import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { getSettings } from "@/lib/settings";
import { buildSearchFallbackTabs } from "@/lib/search-fallback";

// Phase 2: required_count is always 5. The isekai lookup that can bump this
// to 10 is explicitly Phase 6 work (generic site detection + AniList), not
// this phase.
const REQUIRED_COUNT = 5;
const ACTIVE_STATUSES = ["locked", "snoozed"];

export const dynamic = "force-dynamic";

/**
 * Called by the extension when an episode ends (manual button or the
 * flixcloud.cc auto-detect bonus). Creates an unlock_sessions row, hands out
 * up to REQUIRED_COUNT saved postings (marking them queued + tagged to this
 * session), and backfills any shortfall with live job-search tabs.
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
    .insert({ user_id: userId, required_count: REQUIRED_COUNT, status: "locked" })
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
    .limit(REQUIRED_COUNT);
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

  const shortfall = REQUIRED_COUNT - claimed.length;
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
