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

  const { data: session, error: sessionError } = await db
    .from("unlock_sessions")
    .select("id, required_count, status")
    .eq("id", posting.session_id)
    .maybeSingle();
  if (sessionError || !session) return null;

  const { count, error: countError } = await db
    .from("applications")
    .select("id, job_postings!inner(session_id)", { count: "exact", head: true })
    .eq("job_postings.session_id", session.id);
  if (countError) return null;

  const applied = count ?? 0;
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
  };
}
