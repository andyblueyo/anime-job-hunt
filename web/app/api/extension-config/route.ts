import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import {
  EPISODE_REQUIRED_COUNT_MAX,
  EPISODE_REQUIRED_COUNT_MIN,
  clampEpisodeRequiredCount,
  getSettings,
  isValidEpisodeRequiredCount,
  setEpisodeRequiredCount,
  type UserSettings,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Shared by GET and PATCH so both always hand back the same shape. */
function configResponse(settings: UserSettings) {
  return Response.json({
    near_end_threshold_seconds: settings.near_end_threshold_seconds,
    snooze_minutes: settings.snooze_minutes,
    tab_cap_per_hour: settings.tab_cap_per_hour,
    default_anime_mode: settings.default_anime_mode,
    episode_required_count: clampEpisodeRequiredCount(settings.episode_required_count),
  });
}

/**
 * Lets the extension read tunable values from `settings` instead of
 * hardcoding them, so near_end_threshold_seconds / snooze_minutes /
 * tab_cap_per_hour / episode_required_count stay owned by the DB. Also
 * doubles as the options page's "is this token valid" check.
 */
export async function GET(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const db = await getDb();
  const userId = await getUserId();
  const settings = await getSettings(db, userId);

  return configResponse(settings);
}

/**
 * The extension's write path for episode_required_count — the popup's
 * difficulty control posts here rather than persisting its own copy, so the
 * website stays the single source of truth.
 *
 * Only this one field is writable: the rest of `settings` has no extension-
 * side UI yet, and a blanket "patch anything in settings" endpoint behind a
 * static shared token is more surface than this needs.
 */
export async function PATCH(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  let body: { episode_required_count?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  const count = body.episode_required_count;
  if (!isValidEpisodeRequiredCount(count)) {
    return Response.json(
      {
        error: `episode_required_count must be an integer from ${EPISODE_REQUIRED_COUNT_MIN} to ${EPISODE_REQUIRED_COUNT_MAX}.`,
      },
      { status: 400 },
    );
  }

  const db = await getDb();
  const userId = await getUserId();

  try {
    await setEpisodeRequiredCount(db, userId, count);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  // Read back rather than echoing the request, so the caller renders from
  // what actually landed.
  return configResponse(await getSettings(db, userId));
}
