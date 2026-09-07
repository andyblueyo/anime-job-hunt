// RemoteOK's public JSON feed: https://remoteok.com/api — the ~100 most recent
// remote jobs, no auth. The first element is a legal-notice object, not a job.
// Checked 2026-09-06: fields position, company, location, salary_min,
// salary_max (USD, 0 = unknown), url, date, tags.

import type { Adapter, Candidate } from "./types";
import { num, str } from "./types";

interface RemoteOkJob {
  id?: string | number;
  position?: string;
  company?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  date?: string;
}

export const remoteok: Adapter = async (ctx) => {
  const endpoint = str(ctx.board.scrape_config.endpoint) ?? "https://remoteok.com/api";
  const rows = await ctx.fetchJson<RemoteOkJob[]>(endpoint);

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const title = str(row.position);
    const url = str(row.url);
    if (!title || !url) continue; // the legal-notice row, or a malformed one
    candidates.push({
      title,
      company: str(row.company),
      url,
      location: str(row.location),
      remote: true,
      salary_min: num(row.salary_min),
      salary_max: num(row.salary_max),
      salary_currency: "USD",
      salary_text: null,
      posted_at: str(row.date),
      closes_at: null,
    });
  }
  return { candidates, partial: false, notes: { feed_rows: rows.length } };
};
