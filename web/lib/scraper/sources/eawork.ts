// 80,000 Hours' job board. The page itself (80000hours.org/job-board) has no
// JobPosting JSON-LD — it's a Nuxt app that reads a public JSON endpoint,
// https://backend.eawork.org/api/jobs (EA Work is the open-source backend
// behind it), and that endpoint is what this reads: one array of every live
// posting, ~925 rows / 2.5 MB on 2026-09-06. Unofficial; if it moves, the run
// fails loudly rather than silently returning nothing.
//
// The endpoint builds the whole payload per request: ~25s to first byte when
// measured (2026-09-06), so it gets a long timeout and refuses to start when
// the run's remaining budget couldn't cover it — the run logs it as skipped
// and the next run (or a "Run now") picks it up. The catalog orders it last.
//
// Fields used: title, post.company.name, url_external (the employer's ATS
// link, tagged with 80k's utm — stripped by canonicalization), posted_at,
// closes_at, salary_min/max (0 = unknown; no currency published — the site
// converts client-side — so none is asserted), tags_city / tags_country
// (names), tags_location_type ("Remote").

import type { Adapter, Candidate } from "./types";
import { num, str } from "./types";

interface Tag {
  name?: string;
}

interface EaWorkJob {
  title?: string;
  post?: { company?: { name?: string } };
  url_external?: string;
  posted_at?: string;
  closes_at?: string | null;
  salary_min?: number;
  salary_max?: number;
  tags_city?: Tag[];
  tags_country?: Tag[];
  tags_location_type?: Tag[];
}

function names(tags: Tag[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const name = str(tag.name);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const FEED_TIMEOUT_MS = 45_000;
const MIN_BUDGET_MS = 35_000;

export const eawork: Adapter = async (ctx) => {
  const endpoint = str(ctx.board.scrape_config.endpoint) ?? "https://backend.eawork.org/api/jobs";
  const remaining = ctx.budget.remainingMs();
  if (remaining < MIN_BUDGET_MS) {
    return {
      candidates: [],
      partial: false,
      skipped: `Only ${Math.round(remaining / 1000)}s of run budget left; this feed needs ~30s. Run again.`,
    };
  }
  const rows = await ctx.fetchJson<EaWorkJob[]>(endpoint, {}, {
    timeoutMs: Math.min(FEED_TIMEOUT_MS, remaining),
  });
  if (!Array.isArray(rows)) throw new Error("80,000 Hours endpoint did not return a list.");

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const title = str(row.title);
    const url = str(row.url_external);
    if (!title || !url) continue;

    const cities = names(row.tags_city);
    const countries = names(row.tags_country);
    const locationType = names(row.tags_location_type);
    const remote =
      locationType.some((t) => /remote/i.test(t)) || cities.some((c) => /remote/i.test(c));
    // Cities first, then countries the cities don't already name, so a
    // "United States" target can match a "San Francisco Bay Area" posting.
    const parts = [...cities];
    for (const country of countries) {
      if (!parts.some((p) => p.toLowerCase().includes(country.toLowerCase()))) parts.push(country);
    }

    candidates.push({
      title,
      company: str(row.post?.company?.name),
      url,
      location: parts.length > 0 ? parts.join("; ") : null,
      remote,
      salary_min: num(row.salary_min),
      salary_max: num(row.salary_max),
      salary_currency: null,
      salary_text: null,
      posted_at: str(row.posted_at),
      closes_at: str(row.closes_at),
    });
  }
  return { candidates, partial: false, notes: { feed_rows: rows.length } };
};
