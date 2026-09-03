"use server";

import { refresh } from "next/cache";
import { getDb, getUserId } from "@/lib/supabase/server";
import { completeSessionIfDone } from "@/lib/unlock-sessions";
import {
  EPISODE_REQUIRED_COUNT_MAX,
  EPISODE_REQUIRED_COUNT_MIN,
  isValidEpisodeRequiredCount,
  setEpisodeRequiredCount,
} from "@/lib/settings";

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

  const [db, userId] = await Promise.all([getDb(), getUserId()]);

  const { error } = await db.from("job_postings").insert({
    user_id: userId,
    company,
    title,
    url: normalizedUrl,
    location: optional(formData, "location"),
    salary_range: optional(formData, "salary_range"),
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
