import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { clampEpisodeRequiredCount, getSettings } from "@/lib/settings";
import {
  ISEKAI_BONUS_COUNT,
  claimPostings,
  selectFreshPostings,
  toWirePosting,
} from "@/lib/unlock-sessions";

const ACTIVE_STATUSES = ["locked", "snoozed"];

/** Postgres check_violation — here, almost certainly required_count = 0
 *  against the original `> 0` constraint. */
const CHECK_VIOLATION = "23514";

/**
 * Whether the episode that just ended was isekai, which costs
 * ISEKAI_BONUS_COUNT extra applications.
 *
 * Hardcoded false for now: the AniList genre lookup that answers this is
 * Phase 6 work (it needs the show title, which needs generic per-site title
 * detection). Kept as a value on the request path rather than an inlined
 * `false` so Phase 6 only has to supply the flag here.
 */
const isekaiEpisode: boolean = false;

export const dynamic = "force-dynamic";

/**
 * Called by the extension when an episode ends (manual button or the
 * flixcloud.cc auto-detect bonus). Creates an unlock_sessions row and hands
 * it saved postings (marked `queued` + tagged to the session).
 *
 * required_count = min(target, postings actually claimed), where target is
 * settings.episode_required_count (1-5) plus the isekai bonus. The setting is
 * a ceiling, not a floor: 3 postings and a setting of 5 means the session
 * requires 3, and it can never exceed the postings behind it — every tab this
 * opens carries a job_posting_id and can count. (Padding the shortfall with
 * live job-search tabs used to happen here; those tabs could never count, so
 * the session was unwinnable. Gone.)
 *
 * With nothing claimable, required_count is 0 and the session is inserted
 * already `completed`, opening no tabs. That's deliberate — the episode still
 * gets logged so episodes-vs-applications stays honest.
 *
 * required_count is a snapshot. Nothing re-reads it from settings or
 * recomputes it as postings arrive; an open lock's target never moves.
 * Replacements (POST /api/unlock-sessions/:id/replacements) only ever fills
 * back up *to* it.
 *
 * Rate-limited by settings.tab_cap_per_hour so a binge night can't stack
 * sessions — a trigger over the cap gets back the currently active session
 * (if any) instead of a new one. Zero-count sessions count against the cap
 * like any other.
 */
export async function POST(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  try {
    const db = await getDb();
    const userId = await getUserId();
    const settings = await getSettings(db, userId);
    const target =
      clampEpisodeRequiredCount(settings.episode_required_count) +
      (isekaiEpisode ? ISEKAI_BONUS_COUNT : 0);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount, error: countError } = await db
      .from("unlock_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", oneHourAgo);
    if (countError) {
      return Response.json({ error: countError.message }, { status: 500 });
    }

    if ((recentCount ?? 0) >= settings.tab_cap_per_hour) {
      const { data: active } = await db
        .from("unlock_sessions")
        .select("id, required_count, status, snooze_until, snooze_count, created_at")
        .eq("user_id", userId)
        .in("status", ACTIVE_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return Response.json(
        {
          error: `Rate limited: ${settings.tab_cap_per_hour} trigger(s) per hour already used.`,
          rate_limited: true,
          session: active ?? null,
        },
        { status: 429 },
      );
    }

    // Look before inserting: the row needs a required_count, and that number
    // is "how many of these we can actually hand out".
    const candidates = await selectFreshPostings(db, userId, target, null);
    const now = new Date().toISOString();

    const { data: inserted, error: sessionError } = await db
      .from("unlock_sessions")
      .insert({
        user_id: userId,
        required_count: candidates.length,
        status: candidates.length === 0 ? "completed" : "locked",
        completed_at: candidates.length === 0 ? now : null,
      })
      .select("id, required_count, status, created_at")
      .single();
    if (sessionError || !inserted) {
      const message = sessionError?.message ?? "Could not create unlock session.";
      const hint =
        sessionError?.code === CHECK_VIOLATION
          ? " (required_count = 0 needs migrations/20260906_allow_zero_required_count.sql applied.)"
          : "";
      return Response.json({ error: message + hint }, { status: 500 });
    }

    let session = inserted;
    const claimed = await claimPostings(
      db,
      session.id,
      candidates.map((p) => p.id),
    );

    // The claim is guarded on status = 'new', so a racing claim elsewhere can
    // leave us with fewer rows than we selected. required_count must never
    // exceed what the session actually holds, so settle it now — this is
    // still creation, not a later move of the target.
    if (claimed.length !== candidates.length) {
      const { data: settled, error: settleError } = await db
        .from("unlock_sessions")
        .update({
          required_count: claimed.length,
          status: claimed.length === 0 ? "completed" : "locked",
          completed_at: claimed.length === 0 ? now : null,
        })
        .eq("id", session.id)
        .select("id, required_count, status, created_at")
        .single();
      if (settleError || !settled) {
        return Response.json(
          { error: settleError?.message ?? "Could not settle unlock session." },
          { status: 500 },
        );
      }
      session = settled;
    }

    return Response.json({
      session_id: session.id,
      required_count: session.required_count,
      status: session.status,
      postings: claimed.map(toWirePosting),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
