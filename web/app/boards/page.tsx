import { rescueRejection } from "@/app/actions";
import { RunScraperButton } from "@/components/run-scraper-button";
import { SubmitPill } from "@/components/submit-pill";
import { Card, EmptyState, ErrorNote, SectionHeading, formatDate } from "@/components/ui";
import { getDb } from "@/lib/supabase/server";
import type { JobBoard, ScrapeRejection, ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";

const RUNS_SHOWN = 20;
const REJECTIONS_SHOWN = 60;

type Loaded = {
  boards: JobBoard[];
  runs: ScrapeRun[];
  rejections: ScrapeRejection[];
  rejectionCount: number;
};

async function load(): Promise<Loaded> {
  const db = await getDb();
  const [boards, runs, rejections] = await Promise.all([
    db.from("job_boards").select("*").order("name").returns<JobBoard[]>(),
    db
      .from("scrape_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(RUNS_SHOWN)
      .returns<ScrapeRun[]>(),
    db
      .from("scrape_rejections")
      .select("*", { count: "exact" })
      .order("last_seen_at", { ascending: false })
      .limit(REJECTIONS_SHOWN)
      .returns<ScrapeRejection[]>(),
  ]);
  for (const result of [boards, runs, rejections]) {
    if (result.error) throw new Error(result.error.message);
  }
  return {
    boards: boards.data ?? [],
    runs: runs.data ?? [],
    rejections: rejections.data ?? [],
    rejectionCount: rejections.count ?? 0,
  };
}

const STATUS_COLOR: Record<ScrapeRun["status"], string> = {
  ok: "var(--color-teal)",
  partial: "var(--color-violet)",
  running: "var(--color-haze)",
  skipped: "var(--color-dim)",
  error: "var(--color-magenta)",
};

const TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function adapterOf(board: JobBoard): string {
  return typeof board.scrape_config.adapter === "string" ? board.scrape_config.adapter : "—";
}

/** One sentence of evidence per rejection, from the matcher's details. */
function explain(r: ScrapeRejection): string {
  const d = r.details;
  if (r.reason === "title") {
    const tried = typeof d.variants_tried === "number" ? d.variants_tried : null;
    return `Title matched none of ${tried ?? "the"} accepted forms${
      typeof d.normalized_title === "string" ? ` (read as “${d.normalized_title}”)` : ""
    }.`;
  }
  if (r.reason === "location") {
    const targets = Array.isArray(d.target_locations) ? (d.target_locations as string[]).join(", ") : "";
    return `Location “${r.location ?? "—"}”${d.remote ? " (remote)" : ""} isn't in: ${targets}.`;
  }
  return `Company is on the excluded list (${String(d.excluded ?? r.company ?? "")}).`;
}

export default async function BoardsPage() {
  let loaded: Loaded | null = null;
  let error: string | null = null;
  try {
    loaded = await load();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const lastRunByBoard = new Map<string, ScrapeRun>();
  for (const run of loaded?.runs ?? []) {
    if (run.board_id && !lastRunByBoard.has(run.board_id)) lastRunByBoard.set(run.board_id, run);
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Job boards</p>
        <h1 className="mt-2 text-3xl font-bold">
          Where the <span className="text-magenta">queue</span> comes from
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-haze">
          The scraper reads every enabled source, keeps what matches your titles and
          locations, and logs what it filtered out so the filter can be checked before
          it&apos;s trusted. It runs daily on a schedule; you can also run it here.
        </p>
      </header>

      {error ? (
        <ErrorNote>
          {error}
          <br />
          <span className="text-dim">
            If <code>scrape_runs</code> / <code>scrape_rejections</code> is the problem, apply{" "}
            <code>migrations/20260906_create_scrape_tables.sql</code> and reload.
          </span>
        </ErrorNote>
      ) : null}

      <Card>
        <SectionHeading eyebrow="Run" />
        <RunScraperButton />
      </Card>

      {loaded ? (
        <>
          <Card>
            <SectionHeading eyebrow="Sources" />
            {loaded.boards.length === 0 ? (
              <EmptyState>
                No boards in the catalog yet — the seed lives in{" "}
                <code>migrations/20260906_create_scrape_tables.sql</code>.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-faint">
                {loaded.boards.map((board) => {
                  const last = lastRunByBoard.get(board.id);
                  return (
                    <li
                      key={board.id}
                      className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-bold">
                          {board.name}
                          <span className="badge text-dim">{adapterOf(board)}</span>
                          {!board.enabled ? <span className="badge text-dim">disabled</span> : null}
                        </p>
                        <a
                          href={board.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline-hover block truncate text-xs text-dim"
                        >
                          {board.url}
                        </a>
                      </div>
                      <p className="shrink-0 text-xs text-haze tabular-nums">
                        {last ? (
                          <>
                            <span style={{ color: STATUS_COLOR[last.status] }}>{last.status}</span>{" "}
                            {TIME.format(new Date(last.started_at))} · {last.inserted} kept ·{" "}
                            {last.rejected} filtered
                          </>
                        ) : (
                          "never run"
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeading eyebrow="Recent runs" />
            {loaded.runs.length === 0 ? (
              <EmptyState>No runs yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-line-faint text-sm">
                {loaded.runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0 last:pb-0">
                    <span className="badge" style={{ color: STATUS_COLOR[run.status] }}>
                      {run.status}
                    </span>
                    <span className="font-bold">{run.board_name}</span>
                    <span className="text-xs text-dim tabular-nums">
                      {TIME.format(new Date(run.started_at))} · {run.fetched} fetched · {run.inserted} kept ·{" "}
                      {run.rejected} filtered · {run.duplicates} already had · {run.expired} expired
                      {run.dry_run ? " · dry run" : ""}
                    </span>
                    {run.error ? (
                      <span className="basis-full text-xs" style={{ color: "var(--color-magenta)" }}>
                        {run.error}
                      </span>
                    ) : typeof run.notes.reason === "string" ? (
                      <span className="basis-full text-xs text-dim">{run.notes.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeading
              eyebrow={`Filtered out · ${loaded.rejectionCount}`}
              title="What the filter kept out"
            />
            <p className="mb-4 max-w-2xl text-sm text-haze">
              Every posting the title, location, or excluded-company filter dropped, with
              why. If one of these should have made it, &quot;Add anyway&quot; moves it into the
              queue. Loosening a preference on Settings re-checks this whole list on the
              next run.
            </p>
            {loaded.rejections.length === 0 ? (
              <EmptyState>Nothing filtered out yet.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {loaded.rejections.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-2 border border-line-soft bg-paper-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="badge" style={{ color: "var(--color-magenta)" }}>
                          {r.reason.replace("_", " ")}
                        </span>
                        <span className="truncate text-xs text-haze">{r.company ?? "Unknown company"}</span>
                        <span className="text-xs text-dim">· {r.board_name}</span>
                      </div>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline-hover mt-1 block truncate text-sm font-bold"
                      >
                        {r.title}
                      </a>
                      <p className="mt-0.5 truncate text-xs text-dim">
                        {explain(r)}
                        {r.salary_range ? ` · ${r.salary_range}` : ""} · seen {r.times_seen}× · last{" "}
                        {formatDate(r.last_seen_at)}
                      </p>
                    </div>
                    <form action={rescueRejection} className="shrink-0">
                      <input type="hidden" name="id" value={r.id} />
                      <SubmitPill className="pill pill-ghost pill-sm" pendingLabel="…">
                        Add anyway
                      </SubmitPill>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {loaded.rejectionCount > loaded.rejections.length ? (
              <p className="mt-3 text-xs text-dim">
                Showing the {loaded.rejections.length} most recently seen.
              </p>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
