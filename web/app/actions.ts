"use server";

import { refresh } from "next/cache";
import { getDb, getUserId } from "@/lib/supabase/server";
import { completeSessionIfDone } from "@/lib/unlock-sessions";
import {
  EPISODE_REQUIRED_COUNT_MAX,
  EPISODE_REQUIRED_COUNT_MIN,
  isExperienceLevel,
  isValidCurrency,
  isValidEpisodeRequiredCount,
  parseList,
  saveSearchPreferences as persistSearchPreferences,
  setEpisodeRequiredCount,
} from "@/lib/settings";
import { runScraper, type ScrapeSummary } from "@/lib/scraper/run";
import { parsePostingUrl, type ParsePostingResult } from "@/lib/posting-parser";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Postgres unique-violation, e.g. the same posting URL added twice. */
const UNIQUE_VIOLATION = "23505";

function trimmed(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Optional text field — empty string becomes null so the column stays clean. */
function optional(formData: FormData, key: string): string | null {
  return trimmed(formData, key) || null;
}

function requirePostingId(formData: FormData): string {
  const id = trimmed(formData, "id");
  if (!id) throw new Error("Missing posting id");
  return id;
}

export async function addPosting(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const company = trimmed(formData, "company");
  const title = trimmed(formData, "title");
  const url = trimmed(formData, "url");

  if (!company || !title || !url) {
    return { ok: false, error: "Company, title, and URL are all required." };
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(url).toString();
  } catch {
    return { ok: false, error: "That URL doesn't look valid — include https://" };
  }

  // Only the paste-a-link review step sends this (when the page had a
  // datePosted). Anything that isn't a plain date is dropped, not rejected.
  const postedDate = optional(formData, "posted_date");
  const posted_date = postedDate && /^\d{4}-\d{2}-\d{2}$/.test(postedDate) ? postedDate : null;

  const [db, userId] = await Promise.all([getDb(), getUserId()]);

  const { error } = await db.from("job_postings").insert({
    user_id: userId,
    company,
    title,
    url: normalizedUrl,
    location: optional(formData, "location"),
    salary_range: optional(formData, "salary_range"),
    posted_date,
    source: "manual",
    status: "new",
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { ok: false, error: "You've already saved a posting with that URL." };
    }
    return { ok: false, error: error.message };
  }

  refresh();
  return { ok: true };
}

/**
 * Paste-a-link: fetch a job posting page server-side and pre-fill the Add
 * Posting form from it. Reads only — saving is addPosting above, so the row a
 * reviewed parse writes is the same row the hand-typed form writes. Every
 * failure comes back as a result (URL kept, other fields blank, one-line
 * message) rather than a throw: parsing is a convenience, never a gate.
 */
export async function parsePosting(
  _prev: ParsePostingResult | null,
  formData: FormData,
): Promise<ParsePostingResult> {
  return parsePostingUrl(trimmed(formData, "url"));
}

/**
 * Mark a posting applied. This both moves the posting's status and writes the
 * `applications` row — that table is what the extension's lock screen counts,
 * so the two must always move together.
 */
export async function markApplied(formData: FormData): Promise<void> {
  const id = requirePostingId(formData);
  const [db, userId] = await Promise.all([getDb(), getUserId()]);

  // `applications` is unique on job_posting_id, so re-clicking is a no-op
  // rather than an error.
  const { error: applicationError } = await db.from("applications").upsert(
    {
      user_id: userId,
      job_posting_id: id,
      method: "manual",
      applied_at: new Date().toISOString(),
    },
    { onConflict: "job_posting_id", ignoreDuplicates: true },
  );
  if (applicationError) throw new Error(applicationError.message);

  const { error } = await db
    .from("job_postings")
    .update({ status: "applied" })
    .eq("id", id);
  if (error) throw new Error(error.message);

  // If this posting was handed out by an active lock, applying to it here
  // has to be able to clear that lock too — not just the extension's own
  // "Mark Applied" button (POST /api/mark-applied calls the same helper).
  await completeSessionIfDone(db, id);

  refresh();
}

/**
 * Set how many applications one episode costs (1-5). Shares its upsert with
 * the extension's PATCH /api/extension-config, and validates the range rather
 * than clamping it — a value outside 1-5 here means a tampered form post, not
 * a stale DB row.
 *
 * Only affects sessions created from now on: unlock_sessions.required_count is
 * snapshotted at creation, so an already-open lock keeps its original target.
 */
export async function setEpisodeCount(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const count = Number(trimmed(formData, "episode_required_count"));
  if (!isValidEpisodeRequiredCount(count)) {
    return {
      ok: false,
      error: `Pick a whole number from ${EPISODE_REQUIRED_COUNT_MIN} to ${EPISODE_REQUIRED_COUNT_MAX}.`,
    };
  }

  const [db, userId] = await Promise.all([getDb(), getUserId()]);
  try {
    await setEpisodeRequiredCount(db, userId, count);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  refresh();
  return { ok: true };
}

// Deliberately not exported: every export of a "use server" file becomes a
// POST endpoint callable with arbitrary arguments, so the exported actions
// below only accept a posting id and pin the status themselves.
async function setPostingStatus(
  id: string,
  status: "new" | "queued" | "skipped" | "rejected",
): Promise<void> {
  const db = await getDb();
  const { error } = await db.from("job_postings").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function skipPosting(formData: FormData): Promise<void> {
  await setPostingStatus(requirePostingId(formData), "skipped");
  refresh();
}

export async function queuePosting(formData: FormData): Promise<void> {
  await setPostingStatus(requirePostingId(formData), "queued");
  refresh();
}

/** Undo an applied/skipped posting: drop any application row, back to `new`. */
export async function reopenPosting(formData: FormData): Promise<void> {
  const id = requirePostingId(formData);
  const db = await getDb();

  const { error: deleteError } = await db
    .from("applications")
    .delete()
    .eq("job_posting_id", id);
  if (deleteError) throw new Error(deleteError.message);

  await setPostingStatus(id, "new");
  refresh();
}

/**
 * Hard-delete a posting. Cascades to its `applications` row by FK (so no
 * manual cleanup, unlike reopenPosting where the posting survives). Never
 * completes a session — deleting can't add an application — and a session
 * mid-lock recomputes its outstanding pool on the next progress poll, with the
 * replacements route covering the shortfall. Frees the URL for re-adding.
 */
export async function deletePosting(formData: FormData): Promise<void> {
  const id = requirePostingId(formData);
  const db = await getDb();

  const { error } = await db.from("job_postings").delete().eq("id", id);
  if (error) throw new Error(error.message);

  refresh();
}

// ---------------------------------------------------------------------------
// Phase 3: job-search preferences + scraper
// ---------------------------------------------------------------------------

/**
 * The /settings preferences form. Lists come in as free text (commas or
 * newlines); the level must be one of the known values; salary is optional.
 * Empty target_roles is allowed but means generic API sources have nothing to
 * search for — the form warns about that, this doesn't refuse it.
 */
export async function saveSearchPreferences(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const level = trimmed(formData, "experience_level");
  if (!isExperienceLevel(level)) {
    return { ok: false, error: "Pick an experience level from the list." };
  }

  const salaryText = trimmed(formData, "salary_min").replace(/[,\s]/g, "");
  let salaryMin: number | null = null;
  if (salaryText) {
    const parsed = Number(salaryText);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { ok: false, error: "Salary floor must be a whole number (annual), or blank." };
    }
    salaryMin = parsed;
  }

  const currency = trimmed(formData, "salary_currency").toUpperCase() || "USD";
  if (!isValidCurrency(currency)) {
    return { ok: false, error: "Currency should be a 3-letter code like USD or GBP." };
  }

  const [db, userId] = await Promise.all([getDb(), getUserId()]);
  try {
    await persistSearchPreferences(db, userId, {
      target_roles: parseList(trimmed(formData, "target_roles")),
      target_locations: parseList(trimmed(formData, "target_locations")),
      excluded_companies: parseList(trimmed(formData, "excluded_companies")),
      experience_level: level,
      salary_min: salaryMin,
      salary_currency: currency,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  refresh();
  return { ok: true };
}

export type ScrapeActionResult =
  | { ok: true; summary: ScrapeSummary }
  | { ok: false; error: string };

/** "Run now" on /boards. Same code path as the cron route, same time budget. */
export async function runScraperNow(
  _prev: ScrapeActionResult | null,
  formData: FormData,
): Promise<ScrapeActionResult> {
  const dryRun = trimmed(formData, "dry_run") === "1";
  const [db, userId] = await Promise.all([getDb(), getUserId()]);
  try {
    const summary = await runScraper({ db, userId, dryRun, budgetMs: 50_000 });
    refresh();
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * "Add anyway" on a filtered-out posting: the filter was wrong about this
 * one. Moves it from the rejection log into the queue as a normal scraped
 * posting. RLS scopes the id to the caller's rows.
 */
export async function rescueRejection(formData: FormData): Promise<void> {
  const id = trimmed(formData, "id");
  if (!id) throw new Error("Missing rejection id");
  const [db, userId] = await Promise.all([getDb(), getUserId()]);

  const { data: rejection, error: readError } = await db
    .from("scrape_rejections")
    .select("id, url, title, company, location, salary_range, board_id, details")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!rejection) return; // already handled

  const postedAt = (rejection.details as Record<string, unknown> | null)?.posted_at;
  const { error: insertError } = await db.from("job_postings").upsert(
    {
      user_id: userId,
      company: rejection.company ?? "Unknown company",
      title: rejection.title,
      url: rejection.url,
      location: rejection.location,
      source: "scraped",
      source_board: rejection.board_id,
      posted_date: typeof postedAt === "string" ? postedAt.slice(0, 10) : null,
      salary_range: rejection.salary_range,
      status: "new",
      scraped_at: new Date().toISOString(),
    },
    { onConflict: "user_id,url", ignoreDuplicates: true },
  );
  if (insertError) throw new Error(insertError.message);

  const { error: deleteError } = await db.from("scrape_rejections").delete().eq("id", id);
  if (deleteError) throw new Error(deleteError.message);

  refresh();
}
