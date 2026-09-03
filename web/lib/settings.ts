import type { Db } from "@/lib/supabase/server";

export interface UserSettings {
  target_roles: string[];
  target_locations: string[];
  excluded_companies: string[];
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
  near_end_threshold_seconds: number;
  snooze_minutes: number;
}

/**
 * Mirrors the column defaults in
 * migrations/20260903_create_anime_jobs_tables.sql. Nothing inserts a
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
};

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const { data, error } = await db
    .from("settings")
    .select(
      "target_roles, target_locations, excluded_companies, tab_cap_per_hour, default_anime_mode, near_end_threshold_seconds, snooze_minutes",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as UserSettings | null) ?? DEFAULT_SETTINGS;
}
