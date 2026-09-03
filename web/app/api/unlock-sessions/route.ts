import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { clampEpisodeRequiredCount, getSettings } from "@/lib/settings";
import { ISEKAI_BONUS_COUNT } from "@/lib/unlock-sessions";
import { buildSearchFallbackTabs } from "@/lib/search-fallback";

const ACTIVE_STATUSES = ["locked", "snoozed"];

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
 * flixcloud.cc auto-detect bonus). Creates an unlock_sessions row, hands out
 * up to that session's required_count in saved postings (marking them queued
 * + tagged to this session), and backfills any shortfall with live
 * job-search tabs.
 *
 * required_count comes from settings.episode_required_count (1-5) plus the
 * isekai bonus, and is written onto the session row as a snapshot — editing
 * the setting later must not move the goalposts on an already-open lock, so
 * every reader takes the count off the session, never off settings.
 *
 * Rate-limited by settings.tab_cap_per_hour so a binge night can't stack
 * sessions — a trigger over the cap gets back the currently active session
 * (if any) instead of a new one.
 */
export async function POST(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const db = await getDb();
  const userId = await getUserId();
  const settings = await getSettings(db, userId);
  const requiredCount =
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

  const { data: session, error: sessionError } = await db
    .from("unlock_sessions")
    .insert({ user_id: userId, required_count: requiredCount, status: "locked" })
    .select("id, required_count, status, created_at")
    .single();
  if (sessionError || !session) {
    return Response.json(
      { error: sessionError?.message ?? "Could not create unlock session." },
      { status: 500 },
    );
  }

  const { data: available, error: postingsError } = await db
    .from("job_postings")
    .select("id, company, title, url, location")
    .eq("user_id", userId)
    .eq("status", "new")
    .order("created_at", { ascending: true })
    .limit(requiredCount);
  if (postingsError) {
    return Response.json({ error: postingsError.message }, { status: 500 });
  }

  const claimed = available ?? [];
  if (claimed.length > 0) {
    const { error: updateError } = await db
      .from("job_postings")
      .update({ status: "queued", session_id: session.id })
      .in(
        "id",
        claimed.map((p) => p.id),
      );
    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 500 });
    }
  }

  const shortfall = requiredCount - claimed.length;
  const fallbackTabs =
    shortfall > 0
      ? buildSearchFallbackTabs(shortfall, settings.target_roles, settings.target_locations)
      : [];

  return Response.json({
    session_id: session.id,
    required_count: session.required_count,
    postings: [
      ...claimed.map((p) => ({ ...p, isSearchFallback: false as const })),
      ...fallbackTabs,
    ],
  });
}
