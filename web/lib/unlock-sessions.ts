import type { Db } from "@/lib/supabase/server";

/**
 * Extra applications an isekai episode costs, on top of the user's
 * `episode_required_count`. Phase 6 supplies the isekai flag from an AniList
 * genre lookup on the show title; until then POST /api/unlock-sessions passes
 * `false` and this is never added.
 */
export const ISEKAI_BONUS_COUNT = 3;

/** A session's progress toward its unlock, as reported back to the extension. */
export interface SessionProgress {
  id: string;
  required_count: number;
  applied_count: number;
  status: string;
  /**
   * Postings still handed out to this session (status `queued`) that haven't
   * been applied to or skipped yet. When applied + outstanding falls short of
   * required_count the session can't complete on its own and the overlay
   * offers "Open replacements" (POST /api/unlock-sessions/:id/replacements).
   */
  outstanding_count: number;
}

/** Applications joined to postings handed out by this session. */
export async function countSessionApplications(db: Db, sessionId: string): Promise<number> {
  const { count, error } = await db
    .from("applications")
    .select("id, job_postings!inner(session_id)", { count: "exact", head: true })
    .eq("job_postings.session_id", sessionId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Postings still queued against this session — handed out, not yet decided. */
export async function countSessionOutstanding(db: Db, sessionId: string): Promise<number> {
  const { count, error } = await db
    .from("job_postings")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "queued");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Read a session's progress by id, flipping it to `completed` if its count
 * has been met. Returns null when the session doesn't exist or a lookup
 * failed — callers use this after a write that has already committed, and a
 * progress report that couldn't be assembled shouldn't fail that write.
 */
export async function getSessionProgress(
  db: Db,
  sessionId: string,
): Promise<SessionProgress | null> {
  const { data: session, error: sessionError } = await db
    .from("unlock_sessions")
    .select("id, required_count, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError || !session) return null;

  let applied: number;
  let outstanding: number;
  try {
    [applied, outstanding] = await Promise.all([
      countSessionApplications(db, session.id),
      countSessionOutstanding(db, session.id),
    ]);
  } catch {
    return null;
  }

  let status = session.status;
  if (applied >= session.required_count && status !== "completed") {
    const { error: completeError } = await db
      .from("unlock_sessions")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", session.id);
    if (!completeError) status = "completed";
  }

  return {
    id: session.id,
    required_count: session.required_count,
    applied_count: applied,
    status,
    outstanding_count: outstanding,
  };
}

/**
 * Flip a posting's tied unlock session to `completed` once enough of that
 * session's postings have applications.
 *
 * Both paths that mark a posting applied have to call this — the /queue
 * server action (`markApplied` in web/app/actions.ts) and the extension's
 * POST /api/mark-applied — otherwise applying through one of them writes the
 * application but leaves the lock up forever.
 *
 * Deliberately forgiving: a posting with no `session_id` (added manually,
 * never handed out by a lock) is a no-op, and a failed lookup returns null
 * instead of throwing, since the caller's `applications` write has already
 * committed by the time this runs and shouldn't be reported as failed.
 *
 * Returns the session's progress for callers that report it back, or null
 * when there was no session to complete.
 */
export async function completeSessionIfDone(
  db: Db,
  jobPostingId: string,
): Promise<SessionProgress | null> {
  const { data: posting, error: postingError } = await db
    .from("job_postings")
    .select("session_id")
    .eq("id", jobPostingId)
    .maybeSingle();
  if (postingError || !posting?.session_id) return null;

  return getSessionProgress(db, posting.session_id);
}

// ---------------------------------------------------------------------------
// Claiming postings for a session
//
// The ONE place that decides which `new` postings a session gets. Both
// POST /api/unlock-sessions (creation) and POST /api/unlock-sessions/:id/
// replacements go through here, so the two can't drift on what "claimable"
// means. Neither path ever writes required_count after creation — it's a
// snapshot, and the create route derives it from what this module actually
// claimed, so it can never exceed the postings behind it.
// ---------------------------------------------------------------------------

/** The columns the extension needs to open a tab and label its ribbon. */
export const CLAIMABLE_COLUMNS = "id, company, title, url, location";

export interface ClaimablePosting {
  id: string;
  company: string;
  title: string;
  url: string;
  location: string | null;
}

/**
 * Oldest-first `new` postings the user could be handed right now.
 *
 * `preferNotSkippedFrom` is the session asking for replacements: postings it
 * has already declined (skipped_from_session_id = that session) are left out
 * here and only come back through `selectReofferPostings`, so a Skip doesn't
 * hand the same tab straight back while there's anything else in the pool.
 * Session creation passes null — a posting skipped from an *earlier* episode
 * is fair game for a new one, by design (see POST /api/skip-posting).
 */
export async function selectFreshPostings(
  db: Db,
  userId: string,
  limit: number,
  preferNotSkippedFrom: string | null,
): Promise<ClaimablePosting[]> {
  if (limit <= 0) return [];
  let query = db
    .from("job_postings")
    .select(CLAIMABLE_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "new");
  if (preferNotSkippedFrom) {
    query = query.or(
      `skipped_from_session_id.is.null,skipped_from_session_id.neq.${preferNotSkippedFrom}`,
    );
  }
  const { data, error } = await query.order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClaimablePosting[];
}

/**
 * `new` postings this session previously skipped — the last resort when the
 * fresh pool is empty. Re-offering beats a dead end: the target can't move,
 * so the only ways forward are applying to something or adding postings, and
 * a posting the person declined an hour ago is still a real posting.
 */
export async function selectReofferPostings(
  db: Db,
  userId: string,
  limit: number,
  skippedFromSessionId: string,
): Promise<ClaimablePosting[]> {
  if (limit <= 0) return [];
  const { data, error } = await db
    .from("job_postings")
    .select(CLAIMABLE_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "new")
    .eq("skipped_from_session_id", skippedFromSessionId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClaimablePosting[];
}

/**
 * Attach postings to a session: status -> `queued`, session_id set.
 *
 * Guarded on `status = 'new'` and returns the rows that actually changed, so
 * a posting that was claimed by something else between select and update
 * (two triggers racing, or a /queue action) is silently dropped rather than
 * double-booked. Callers size required_count from the *returned* list.
 */
export async function claimPostings(
  db: Db,
  sessionId: string,
  postingIds: string[],
): Promise<ClaimablePosting[]> {
  if (postingIds.length === 0) return [];
  const { data, error } = await db
    .from("job_postings")
    .update({ status: "queued", session_id: sessionId })
    .in("id", postingIds)
    .eq("status", "new")
    .select(CLAIMABLE_COLUMNS);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClaimablePosting[];
}

/** Wire shape the extension opens tabs from (see extension/src/lib/messages.ts JobPosting). */
export function toWirePosting(posting: ClaimablePosting) {
  return { ...posting, isSearchFallback: false as const };
}
