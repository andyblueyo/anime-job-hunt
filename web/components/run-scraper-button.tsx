"use client";

import { useActionState } from "react";
import { runScraperNow, type ScrapeActionResult } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";
import type { BoardSummary } from "@/lib/scraper/run";

const STATUS_COLOR: Record<BoardSummary["status"], string> = {
  ok: "var(--color-teal)",
  partial: "var(--color-violet)",
  running: "var(--color-haze)",
  skipped: "var(--color-dim)",
  error: "var(--color-magenta)",
};

function Row({ run }: { run: BoardSummary }) {
  const note = run.error ?? (typeof run.notes.reason === "string" ? run.notes.reason : null);
  return (
    <li className="border border-line-soft bg-paper-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge" style={{ color: STATUS_COLOR[run.status] }}>
          {run.status}
        </span>
        <span className="font-bold">{run.board}</span>
        <span className="text-xs text-dim tabular-nums">
          {run.fetched} fetched · {run.inserted} {run.status === "ok" || run.status === "partial" ? "kept" : "kept"} ·{" "}
          {run.rejected} filtered · {run.duplicates} already had · {run.expired} expired
        </span>
      </div>
      {note ? <p className="mt-1.5 text-xs text-haze">{note}</p> : null}
      {run.samples ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <p className="eyebrow" style={{ color: "var(--color-teal)" }}>
              Would keep · {run.inserted}
            </p>
            <ul className="mt-1.5 space-y-1 text-xs">
              {run.samples.kept.map((c) => (
                <li key={c.url} className="truncate">
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline-hover">
                    {c.title}
                  </a>
                  <span className="text-dim"> · {c.company ?? "?"}{c.location ? ` · ${c.location}` : ""}</span>
                </li>
              ))}
              {run.samples.kept.length === 0 ? <li className="text-dim">none</li> : null}
            </ul>
          </div>
          <div>
            <p className="eyebrow" style={{ color: "var(--color-magenta)" }}>
              Would filter out · {run.rejected}
            </p>
            <ul className="mt-1.5 space-y-1 text-xs">
              {run.samples.rejected.map((c) => (
                <li key={c.url} className="truncate">
                  <span className="text-dim">[{c.reason}] </span>
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline-hover">
                    {c.title}
                  </a>
                  <span className="text-dim"> · {c.company ?? "?"}{c.location ? ` · ${c.location}` : ""}</span>
                </li>
              ))}
              {run.samples.rejected.length === 0 ? <li className="text-dim">none</li> : null}
            </ul>
            {run.rejected > run.samples.rejected.length ? (
              <p className="mt-1 text-xs text-dim">first {run.samples.rejected.length} shown</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Two buttons, one form: a real run writes to the queue and the logs; a dry
 * run fetches and evaluates everything but writes nothing, and shows what
 * would have happened — the way to check the filter before trusting it.
 */
export function RunScraperButton() {
  const [result, action, pending] = useActionState<ScrapeActionResult | null, FormData>(
    runScraperNow,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SubmitPill className="pill pill-primary" pendingLabel="Running… (up to a minute)">
          Run scraper now
        </SubmitPill>
        <button
          type="submit"
          name="dry_run"
          value="1"
          disabled={pending}
          className="pill pill-ghost"
        >
          Dry run (write nothing)
        </button>
        {result && !result.ok ? (
          <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
            {result.error}
          </p>
        ) : null}
      </div>

      {result?.ok ? (
        <div className="space-y-3">
          <p className="text-xs text-dim">
            {result.summary.dry_run ? "Dry run — nothing was written. " : ""}
            {result.summary.variants.length} accepted title forms from{" "}
            {result.summary.prefs.target_roles.length} target titles
            {result.summary.prefs.target_locations.length > 0
              ? `; locations: ${result.summary.prefs.target_locations.join(", ")}`
              : "; no location filter"}
            .{result.summary.budget_exhausted ? " Time budget ran out — some boards were skipped." : ""}
          </p>
          <ul className="space-y-2">
            {result.summary.runs.map((run) => (
              <Row key={`${run.board_id ?? run.board}`} run={run} />
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
