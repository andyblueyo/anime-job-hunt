import type { Db } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Experience level — NOT a filter. Postings carry no experience field; level
// is encoded in titles, so this only expands target_roles into title variants
// for the matcher (see lib/scraper/matching.ts). It never removes a match.
// ---------------------------------------------------------------------------

export const EXPERIENCE_LEVELS = ["any", "entry", "mid", "senior", "lead", "executive"] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const EXPERIENCE_LEVEL_LABELS: Record<ExperienceLevel, { label: string; hint: string }> = {
  any: { label: "Any", hint: "Every level's variants" },
  entry: { label: "Entry", hint: "Associate, Junior, APM" },
  mid: { label: "Mid", hint: "The bare title" },
  senior: { label: "Senior", hint: "Senior, Sr., Staff" },
  lead: { label: "Lead", hint: "Lead, Principal, Group" },
  executive: { label: "Exec", hint: "Head of, Director, VP" },
};

export function isExperienceLevel(value: unknown): value is ExperienceLevel {
  return typeof value === "string" && (EXPERIENCE_LEVELS as readonly string[]).includes(value);
}

/** The seed for a product-manager search — what target_roles starts as. */
export const SEED_TARGET_ROLES = ["Product Manager", "Product Lead", "Product Owner"];

export interface UserSettings {
  /** FILTER: titles to keep (expanded with experience_level variants). */
  target_roles: string[];
  /** FILTER: locations to keep. Empty = no filter. Location-less postings always pass. */
  target_locations: string[];
  /** FILTER: exact company names to drop. */
  excluded_companies: string[];
  /** NOT a filter — see EXPERIENCE_LEVELS. */
  experience_level: ExperienceLevel;
  /** NOT a filter — annual floor used to rank/badge the queue. Null = none. */
  salary_min: number | null;
  salary_currency: string;
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
  near_end_threshold_seconds: number;
  snooze_minutes: number;
  episode_required_count: number;
  /**
   * Seconds a handed-out job tab must have been open before closing it
   * without a ribbon decision prompts "did you apply?" on the lock overlay.
   */
  close_prompt_min_seconds: number;
}

/**
 * Mirrors the column defaults in migrations/ (the create-tables migration,
 * plus the episode_required_count, close_prompt, and search-preferences
 * migrations). Nothing inserts a `settings` row automatically — it only
 * exists once someone writes one — so every reader falls back to these rather
 * than assuming the row is there. target_roles is the one deliberate
 * departure from the column default ('{}'): a user with no row yet should
 * still get the seeded search rather than a scraper with nothing to look for.
 */
export const DEFAULT_SETTINGS: UserSettings = {
  target_roles: SEED_TARGET_ROLES,
  target_locations: [],
  excluded_companies: [],
  experience_level: "any",
  salary_min: null,
  salary_currency: "USD",
  tab_cap_per_hour: 1,
  default_anime_mode: false,
  near_end_threshold_seconds: 10,
  snooze_minutes: 10,
  episode_required_count: 5,
  close_prompt_min_seconds: 90,
};

// Every column in UserSettings, in one place: an unapplied migration for any
// name here makes this select 500 on every extension-facing route.
const SETTINGS_COLUMNS = [
  "target_roles",
  "target_locations",
  "excluded_companies",
  "experience_level",
  "salary_min",
  "salary_currency",
  "tab_cap_per_hour",
  "default_anime_mode",
  "near_end_threshold_seconds",
  "snooze_minutes",
  "episode_required_count",
  "close_prompt_min_seconds",
].join(", ");

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const { data, error } = await db
    .from("settings")
    .select(SETTINGS_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_SETTINGS;

  const row = data as unknown as UserSettings;
  return {
    ...row,
    // A row written by hand or before the constraint could hold anything.
    experience_level: isExperienceLevel(row.experience_level) ? row.experience_level : "any",
    salary_currency: row.salary_currency || "USD",
  };
}

// ---------------------------------------------------------------------------
// Job-search preferences (the /settings form)
// ---------------------------------------------------------------------------

export interface SearchPreferences {
  target_roles: string[];
  target_locations: string[];
  excluded_companies: string[];
  experience_level: ExperienceLevel;
  salary_min: number | null;
  salary_currency: string;
}

/**
 * "Product Manager, Product Lead\nProduct Owner" -> three clean entries.
 * Splits on commas and newlines, trims, drops empties, dedupes
 * case-insensitively keeping the first spelling.
 */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const value = raw.trim().replace(/\s+/g, " ");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isValidCurrency(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_CODE.test(value);
}

/**
 * Upsert, like setEpisodeRequiredCount: for most users the first save is also
 * the row's creation. Only the named columns move.
 */
export async function saveSearchPreferences(
  db: Db,
  userId: string,
  prefs: SearchPreferences,
): Promise<void> {
  const { error } = await db
    .from("settings")
    .upsert(
      {
        user_id: userId,
        target_roles: prefs.target_roles,
        target_locations: prefs.target_locations,
        excluded_companies: prefs.excluded_companies,
        experience_level: prefs.experience_level,
        salary_min: prefs.salary_min,
        salary_currency: prefs.salary_currency,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// episode_required_count — the most applications one episode can cost.
// A ceiling, not a floor: unlock_sessions.required_count is
// min(this [+ isekai bonus], postings claimable at creation) — see
// POST /api/unlock-sessions.
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
