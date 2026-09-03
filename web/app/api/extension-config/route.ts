import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Lets the extension read tunable values from `settings` instead of
 * hardcoding them, so near_end_threshold_seconds / snooze_minutes /
 * tab_cap_per_hour stay owned by the DB even before a settings-editing page
 * exists. Also doubles as the options page's "is this token valid" check.
 */
export async function GET(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const db = await getDb();
  const userId = await getUserId();
  const settings = await getSettings(db, userId);

  return Response.json({
    near_end_threshold_seconds: settings.near_end_threshold_seconds,
    snooze_minutes: settings.snooze_minutes,
    tab_cap_per_hour: settings.tab_cap_per_hour,
    default_anime_mode: settings.default_anime_mode,
  });
}
