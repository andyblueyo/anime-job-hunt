import type { Db } from "@/lib/supabase/server";

export interface UserSettings {
  target_roles: string[];
  target_locations: string[];
  excluded_companies: string[];
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
  near_end_threshold_seconds: number;
  snooze_minutes: number;
  episode_required_count: number;
}

/**
 * Mirrors the column defaults in migrations/ (the create-tables migration,
 * plus 20260903_add_episode_required_count.sql). Nothing inserts a
 * `settings` row automatically — it only exists once someone (a future
 * settings-editing UI, or a manual insert) writes one — so every reader falls
 * back to these rather than assuming the row is there.
 */
export const DEFAULT_SETTINGS: UserSettings = {
  target_roles: [],
  target_locations: [],
  excluded_companies: [],
  tab_cap_per_hour: 1,
  default_anime_mode: false,
  near_end_threshold_seconds: 10,
  snooze_minutes: 10,
  episode_required_count: 5,
};

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const { data, error } = await db
    .from("settings")
    .select(
      "target_roles, target_locations, excluded_companies, tab_cap_per_hour, default_anime_mode, near_end_threshold_seconds, snooze_minutes, episode_required_count",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as UserSettings | null) ?? DEFAULT_SETTINGS;
}

// ---------------------------------------------------------------------------
// episode_required_count — how many applications one episode costs
// ---------------------------------------------------------------------------

export const EPISODE_REQUIRED_COUNT_MIN = 1;
export const EPISODE_REQUIRED_COUNT_MAX = 5;

/** Difficulty labels for the 1-5 scale, shared by /settings and the popup. */
export const EPISODE_REQUIRED_COUNT_LABELS: Record<number, string> = {
  1: "Easy Mode",
  2: "Slice of Life",
  3: "Training Arc",
  4: "Tournament Arc",
  5: "Hired In Time",
};

/**
 * Belt-and-braces for readers: the DB has a CHECK constraint for this range,
 * but a row written before that migration landed (or by hand) could still be
 * out of bounds, and a session built from a wild number is worse than one
 * built from a clamped one.
 */
export function clampEpisodeRequiredCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.episode_required_count;
  return Math.min(
    EPISODE_REQUIRED_COUNT_MAX,
    Math.max(EPISODE_REQUIRED_COUNT_MIN, Math.round(value)),
  );
}

/** Writers validate instead of clamping — a bad request should be told so. */
export function isValidEpisodeRequiredCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EPISODE_REQUIRED_COUNT_MIN &&
    value <= EPISODE_REQUIRED_COUNT_MAX
  );
}

/**
 * Upsert rather than update: nothing in the app inserts a `settings` row, so
 * for most users the first write of this value is also the row's creation.
 * Only the named columns move — the rest take their DB defaults on insert and
 * are left alone on conflict.
 */
export async function setEpisodeRequiredCount(
  db: Db,
  userId: string,
  count: number,
): Promise<void> {
  const { error } = await db
    .from("settings")
    .upsert({ user_id: userId, episode_required_count: count }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}
