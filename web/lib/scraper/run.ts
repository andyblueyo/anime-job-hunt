// The scraper run: settings -> title variants -> each enabled board's adapter
// -> dedupe -> filter -> job_postings (kept) / scrape_rejections (filtered out)
// / scrape_runs (what happened). Called by GET /api/cron/scrape on a schedule
// and by the "Run now" action on /boards.
//
// Two rules the whole thing is built around:
//   1. A posting missing an optional field (location, salary, company) is
//      kept, never dropped. Only a title that matches nothing, a location that
//      contradicts the targets, or an excluded company keeps a posting out.
//   2. Nothing filtered out disappears. It goes to scrape_rejections with the
//      reason and evidence, and every run re-evaluates that log against the
//      current preferences first — loosen the filter and yesterday's
//      rejections walk into the queue on the next run without refetching.

import type { Db } from "@/lib/supabase/server";
import { getSettings, type UserSettings } from "@/lib/settings";
import type { JobBoard, ScrapeRunStatus } from "@/lib/types";
import { evaluate, expandTitleVariants, type Evaluation, type FilterPrefs } from "./matching";
import { fetchJson, fetchText, makeBudget } from "./http";
import { canonicalUrl, formatSalary } from "./normalize";
import { ADAPTERS, type Candidate, type SourceContext } from "./sources";

const DEFAULT_BUDGET_MS = 50_000;
const RECONSIDER_LABEL = "Re-check of filtered-out log";

export interface RunScraperOptions {
  db: Db;
  userId: string;
  /** Wall-clock cap for the whole run; boards past it are recorded as skipped. */
  budgetMs?: number;
  /** Evaluate and report, write nothing — for checking the filter. */
  dryRun?: boolean;
  /** Only these boards (ids). Default: every enabled board. */
  boardIds?: string[];
  /** Dry runs only: pretend the preferences were these. */
  prefsOverride?: Partial<FilterPrefs>;
}

export interface CandidateView {
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  url: string;
}

export interface RejectedView extends CandidateView {
  reason: "title" | "location" | "excluded_company";
  details: Record<string, unknown>;
}

export interface BoardSummary {
  board_id: string | null;
  board: string;
  status: ScrapeRunStatus;
  fetched: number;
  inserted: number;
  rejected: number;
  duplicates: number;
  expired: number;
  error: string | null;
  notes: Record<string, unknown>;
  /** Dry runs only. */
  samples?: { kept: CandidateView[]; rejected: RejectedView[] };
}

export interface ScrapeSummary {
  dry_run: boolean;
  budget_ms: number;
  budget_exhausted: boolean;
  prefs: FilterPrefs;
  variants: string[];
  runs: BoardSummary[];
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RejectionRow {
  id: string;
  url: string;
  times_seen: number;
  title: string;
  company: string | null;
  location: string | null;
  salary_range: string | null;
  board_id: string | null;
  board_name: string;
  details: Record<string, unknown>;
}

function view(c: Candidate, url: string): CandidateView {
  return {
    title: c.title,
    company: c.company,
    location: c.location,
    salary: formatSalary(c.salary_min, c.salary_max, c.salary_currency) ?? c.salary_text,
    url,
  };
}

function postingRow(userId: string, boardId: string | null, c: Candidate, url: string, now: string) {
  return {
    user_id: userId,
    company: c.company ?? "Unknown company",
    title: c.title,
    url,
    location: c.location,
    source: "scraped" as const,
    source_board: boardId,
    posted_date: c.posted_at ? c.posted_at.slice(0, 10) : null,
    salary_range: formatSalary(c.salary_min, c.salary_max, c.salary_currency) ?? c.salary_text,
    status: "new" as const,
    scraped_at: now,
  };
}

function orderOf(board: JobBoard): number {
  const value = board.scrape_config.order;
  return typeof value === "number" && Number.isFinite(value) ? value : 100;
}

function prefsOf(settings: UserSettings, override: Partial<FilterPrefs> | undefined): FilterPrefs {
  return {
    target_roles: override?.target_roles ?? settings.target_roles,
    target_locations: override?.target_locations ?? settings.target_locations,
    excluded_companies: override?.excluded_companies ?? settings.excluded_companies,
    experience_level: override?.experience_level ?? settings.experience_level,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runScraper(options: RunScraperOptions): Promise<ScrapeSummary> {
  const { db, userId } = options;
  const dryRun = options.dryRun ?? false;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const budget = makeBudget(budgetMs);
  const now = new Date().toISOString();

  const settings = await getSettings(db, userId);
  const prefs = prefsOf(settings, dryRun ? options.prefsOverride : undefined);
  const variants = expandTitleVariants(prefs.target_roles, prefs.experience_level);

  // What we already have, by canonical URL.
  const [postingsRes, rejectionsRes, boardsRes] = await Promise.all([
    db.from("job_postings").select("url").eq("user_id", userId),
    db
      .from("scrape_rejections")
      .select("id, url, times_seen, title, company, location, salary_range, board_id, board_name, details")
      .eq("user_id", userId),
    db.from("job_boards").select("*").eq("enabled", true).order("name"),
  ]);
  for (const res of [postingsRes, rejectionsRes, boardsRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const postingUrls = new Set<string>();
  for (const row of (postingsRes.data ?? []) as Array<{ url: string }>) {
    postingUrls.add(canonicalUrl(row.url) ?? row.url);
  }
  const rejectionByUrl = new Map<string, RejectionRow>();
  for (const row of (rejectionsRes.data ?? []) as RejectionRow[]) {
    rejectionByUrl.set(canonicalUrl(row.url) ?? row.url, row);
  }

  let boards = (boardsRes.data ?? []) as JobBoard[];
  if (options.boardIds?.length) boards = boards.filter((b) => options.boardIds!.includes(b.id));
  // scrape_config.order (small first) lets the catalog put slow sources last,
  // so a run that hits its budget drops the 25-second feed, not the fast ones.
  boards.sort((a, b) => orderOf(a) - orderOf(b) || a.name.localeCompare(b.name));

  const runs: BoardSummary[] = [];

  // -- 1. Re-check the rejection log against today's preferences -----------
  if (rejectionByUrl.size > 0) {
    runs.push(await reconsiderRejections({ db, userId, dryRun, prefs, variants, rejectionByUrl, postingUrls, now }));
  }

  // -- 2. Each board ---------------------------------------------------------
  for (const board of boards) {
    if (budget.exhausted()) {
      runs.push(await recordSkipped(db, userId, board, dryRun, "Time budget exhausted before this board ran."));
      continue;
    }
    runs.push(
      await runBoard({ db, userId, board, dryRun, prefs, variants, budget, postingUrls, rejectionByUrl, now }),
    );
  }

  return { dry_run: dryRun, budget_ms: budgetMs, budget_exhausted: budget.exhausted(), prefs, variants, runs };
}

interface Shared {
  db: Db;
  userId: string;
  dryRun: boolean;
  prefs: FilterPrefs;
  variants: string[];
  postingUrls: Set<string>;
  rejectionByUrl: Map<string, RejectionRow>;
  now: string;
}

async function reconsiderRejections(ctx: Shared): Promise<BoardSummary> {
  const { db, userId, dryRun, prefs, variants, rejectionByUrl, postingUrls, now } = ctx;
  const rescued: Array<{ row: RejectionRow; url: string }> = [];
  for (const [url, row] of rejectionByUrl) {
    const remote =
      typeof row.details.remote === "boolean" ? row.details.remote : /\bremote\b/i.test(row.location ?? "");
    const result = evaluate(
      { title: row.title, company: row.company, location: row.location, remote },
      prefs,
      variants,
    );
    if (result.keep && !postingUrls.has(url)) rescued.push({ row, url });
  }

  const summary: BoardSummary = {
    board_id: null,
    board: RECONSIDER_LABEL,
    status: "ok",
    fetched: rejectionByUrl.size,
    inserted: 0,
    rejected: rejectionByUrl.size - rescued.length,
    duplicates: 0,
    expired: 0,
    error: null,
    notes: { would_rescue: rescued.length },
  };
  if (dryRun) {
    summary.samples = {
      kept: rescued.slice(0, 25).map(({ row, url }) => ({
        title: row.title,
        company: row.company,
        location: row.location,
        salary: row.salary_range,
        url,
      })),
      rejected: [],
    };
    return summary;
  }
  if (rescued.length === 0) return summary;

  const rows = rescued.map(({ row, url }) => ({
    user_id: userId,
    company: row.company ?? "Unknown company",
    title: row.title,
    url,
    location: row.location,
    source: "scraped" as const,
    source_board: row.board_id,
    posted_date: typeof row.details.posted_at === "string" ? row.details.posted_at.slice(0, 10) : null,
    salary_range: row.salary_range,
    status: "new" as const,
    scraped_at: now,
  }));
  const { data: inserted, error: insertError } = await db
    .from("job_postings")
    .upsert(rows, { onConflict: "user_id,url", ignoreDuplicates: true })
    .select("url");
  if (insertError) {
    return { ...summary, status: "error", error: insertError.message };
  }
  const { error: deleteError } = await db
    .from("scrape_rejections")
    .delete()
    .in(
      "id",
      rescued.map(({ row }) => row.id),
    );
  if (deleteError) return { ...summary, status: "error", error: deleteError.message };

  for (const { url } of rescued) {
    postingUrls.add(url);
    rejectionByUrl.delete(url);
  }
  summary.inserted = inserted?.length ?? 0;
  await db.from("scrape_runs").insert({
    user_id: userId,
    board_id: null,
    board_name: RECONSIDER_LABEL,
    status: "ok",
    fetched: summary.fetched,
    inserted: summary.inserted,
    rejected: summary.rejected,
    finished_at: new Date().toISOString(),
    notes: summary.notes,
  });
  return summary;
}

async function recordSkipped(
  db: Db,
  userId: string,
  board: JobBoard,
  dryRun: boolean,
  reason: string,
): Promise<BoardSummary> {
  if (!dryRun) {
    await db.from("scrape_runs").insert({
      user_id: userId,
      board_id: board.id,
      board_name: board.name,
      status: "skipped",
      finished_at: new Date().toISOString(),
      notes: { reason },
    });
  }
  return {
    board_id: board.id,
    board: board.name,
    status: "skipped",
    fetched: 0,
    inserted: 0,
    rejected: 0,
    duplicates: 0,
    expired: 0,
    error: null,
    notes: { reason },
  };
}

async function runBoard(
  ctx: Shared & { board: JobBoard; budget: ReturnType<typeof makeBudget> },
): Promise<BoardSummary> {
  const { db, userId, board, dryRun, prefs, variants, budget, postingUrls, rejectionByUrl, now } = ctx;
  const summary: BoardSummary = {
    board_id: board.id,
    board: board.name,
    status: "ok",
    fetched: 0,
    inserted: 0,
    rejected: 0,
    duplicates: 0,
    expired: 0,
    error: null,
    notes: {},
  };

  const adapterKey = typeof board.scrape_config.adapter === "string" ? board.scrape_config.adapter : "";
  const adapter = ADAPTERS[adapterKey];
  if (!adapter) {
    return finish(db, userId, board, dryRun, null, {
      ...summary,
      status: "error",
      error: `Unknown adapter "${adapterKey}" in scrape_config.`,
    });
  }

  // Keyword-search sources have nothing to ask for without target roles.
  // Boards that list everything still run — with no title filter applied.
  const sourceCtx: SourceContext = {
    board,
    targetRoles: prefs.target_roles,
    budget,
    seen: (url) => postingUrls.has(url) || rejectionByUrl.has(url),
    fetchText,
    fetchJson,
  };

  let runId: string | null = null;
  if (!dryRun) {
    const { data } = await db
      .from("scrape_runs")
      .insert({ user_id: userId, board_id: board.id, board_name: board.name, status: "running" })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  try {
    const result = await adapter(sourceCtx);
    summary.notes = { ...(result.notes ?? {}) };
    if (result.skipped) {
      summary.status = "skipped";
      summary.notes.reason = result.skipped;
      return finish(db, userId, board, dryRun, runId, summary);
    }

    const kept: Array<{ c: Candidate; url: string; e: Extract<Evaluation, { keep: true }> }> = [];
    const rejected: Array<{ c: Candidate; url: string; e: Extract<Evaluation, { keep: false }> }> = [];
    const batch = new Set<string>();
    let invalid = 0;

    for (const c of result.candidates) {
      summary.fetched++;
      const url = canonicalUrl(c.url);
      if (!url) {
        invalid++;
        continue;
      }
      if (batch.has(url) || postingUrls.has(url)) {
        summary.duplicates++;
        continue;
      }
      batch.add(url);
      if (c.closes_at) {
        const closes = Date.parse(c.closes_at);
        if (Number.isFinite(closes) && closes < Date.now()) {
          summary.expired++;
          continue;
        }
      }
      const e = evaluate(
        { title: c.title, company: c.company, location: c.location, remote: c.remote },
        prefs,
        variants,
      );
      if (e.keep) kept.push({ c, url, e });
      else rejected.push({ c, url, e });
    }
    if (invalid) summary.notes.invalid_urls = invalid;
    summary.rejected = rejected.length;
    if (result.partial) summary.status = "partial";

    if (dryRun) {
      summary.inserted = kept.length;
      summary.samples = {
        kept: kept.slice(0, 25).map(({ c, url }) => view(c, url)),
        rejected: rejected.slice(0, 40).map(({ c, url, e }) => ({ ...view(c, url), reason: e.reason, details: e.details })),
      };
      return summary;
    }

    if (kept.length > 0) {
      const { data: inserted, error } = await db
        .from("job_postings")
        .upsert(
          kept.map(({ c, url }) => postingRow(userId, board.id, c, url, now)),
          { onConflict: "user_id,url", ignoreDuplicates: true },
        )
        .select("url");
      if (error) throw new Error(`Inserting postings: ${error.message}`);
      summary.inserted = inserted?.length ?? 0;
      for (const { url } of kept) postingUrls.add(url);

      // A posting that passes now but was in the log: it's in the queue, so
      // it's no longer a rejection.
      const rescuedIds = kept.map(({ url }) => rejectionByUrl.get(url)?.id).filter((id): id is string => Boolean(id));
      if (rescuedIds.length > 0) {
        const { error: deleteError } = await db.from("scrape_rejections").delete().in("id", rescuedIds);
        if (deleteError) throw new Error(`Clearing rescued rejections: ${deleteError.message}`);
        for (const { url } of kept) rejectionByUrl.delete(url);
      }
    }

    if (rejected.length > 0) {
      const rows = rejected.map(({ c, url, e }) => ({
        user_id: userId,
        board_id: board.id,
        board_name: board.name,
        url,
        company: c.company,
        title: c.title,
        location: c.location,
        salary_range: formatSalary(c.salary_min, c.salary_max, c.salary_currency) ?? c.salary_text,
        reason: e.reason,
        details: { ...e.details, remote: c.remote, posted_at: c.posted_at, closes_at: c.closes_at },
        last_seen_at: now,
        times_seen: (rejectionByUrl.get(url)?.times_seen ?? 0) + 1,
      }));
      const { data: upserted, error } = await db
        .from("scrape_rejections")
        .upsert(rows, { onConflict: "user_id,url" })
        .select("id, url, times_seen, title, company, location, salary_range, board_id, board_name, details");
      if (error) throw new Error(`Logging rejections: ${error.message}`);
      for (const row of (upserted ?? []) as RejectionRow[]) rejectionByUrl.set(row.url, row);
    }

    return finish(db, userId, board, dryRun, runId, summary);
  } catch (error) {
    summary.status = "error";
    summary.error = error instanceof Error ? error.message : String(error);
    return finish(db, userId, board, dryRun, runId, summary);
  }
}

async function finish(
  db: Db,
  userId: string,
  board: JobBoard,
  dryRun: boolean,
  runId: string | null,
  summary: BoardSummary,
): Promise<BoardSummary> {
  if (dryRun) return summary;
  const patch = {
    status: summary.status,
    fetched: summary.fetched,
    inserted: summary.inserted,
    rejected: summary.rejected,
    duplicates: summary.duplicates,
    expired: summary.expired,
    error: summary.error,
    notes: summary.notes,
    finished_at: new Date().toISOString(),
  };
  if (runId) {
    await db.from("scrape_runs").update(patch).eq("id", runId);
  } else {
    await db.from("scrape_runs").insert({ user_id: userId, board_id: board.id, board_name: board.name, ...patch });
  }
  // job_boards.last_run_at is not written: shared catalog rows (owner null)
  // are read-only under RLS for a normal user. /boards derives "last run"
  // from scrape_runs instead.
  return summary;
}
