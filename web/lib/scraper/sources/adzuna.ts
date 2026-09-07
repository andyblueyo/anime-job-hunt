// Adzuna's search API. Keyword search, so it runs one query per target role;
// needs free credentials (ADZUNA_APP_ID / ADZUNA_APP_KEY) and is skipped —
// logged, not failed — without them.
//
// scrape_config: { country: "us", pages: 1, results_per_page: 50 }.
// Docs: https://developer.adzuna.com/docs/search (checked 2026-09-06).

import type { Adapter, Candidate } from "./types";
import { num, str } from "./types";

interface AdzunaResult {
  id?: string;
  title?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
  created?: string;
}

interface AdzunaResponse {
  results?: AdzunaResult[];
  count?: number;
}

export const adzuna: Adapter = async (ctx) => {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    return {
      candidates: [],
      partial: false,
      skipped: "ADZUNA_APP_ID / ADZUNA_APP_KEY not set in web/.env.local",
    };
  }
  if (ctx.targetRoles.length === 0) {
    return { candidates: [], partial: false, skipped: "No target roles to search for." };
  }

  const config = ctx.board.scrape_config;
  const country = (str(config.country) ?? "us").toLowerCase();
  const pages = Math.min(Math.max(Math.trunc(num(config.pages) ?? 1), 1), 5);
  const perPage = Math.min(Math.max(Math.trunc(num(config.results_per_page) ?? 50), 1), 50);

  const candidates: Candidate[] = [];
  let queries = 0;
  let partial = false;

  outer: for (const role of ctx.targetRoles.slice(0, 5)) {
    for (let page = 1; page <= pages; page++) {
      if (ctx.budget.exhausted()) {
        partial = true;
        break outer;
      }
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
      url.searchParams.set("app_id", appId);
      url.searchParams.set("app_key", appKey);
      url.searchParams.set("what", role);
      url.searchParams.set("results_per_page", String(perPage));
      url.searchParams.set("sort_by", "date");
      url.searchParams.set("content-type", "application/json");

      const body = await ctx.fetchJson<AdzunaResponse>(url.toString());
      queries++;
      const results = body.results ?? [];
      for (const r of results) {
        const title = str(r.title);
        const link = str(r.redirect_url);
        if (!title || !link) continue;
        const location = str(r.location?.display_name);
        // Adzuna estimates pay for ads that don't state it; don't let a guess
        // earn the queue's "meets your salary" badge.
        const predicted = r.salary_is_predicted === "1";
        candidates.push({
          title,
          company: str(r.company?.display_name),
          url: link,
          location,
          remote: /\bremote\b/i.test(`${title} ${location ?? ""}`),
          salary_min: predicted ? null : num(r.salary_min),
          salary_max: predicted ? null : num(r.salary_max),
          salary_currency: predicted ? null : currencyFor(country),
          salary_text: null,
          posted_at: str(r.created),
          closes_at: null,
        });
      }
      if (results.length < perPage) break; // last page for this role
    }
  }

  return { candidates, partial, notes: { queries, country } };
};

function currencyFor(country: string): string {
  const map: Record<string, string> = { us: "USD", gb: "GBP", ca: "CAD", au: "AUD", de: "EUR", fr: "EUR", nl: "EUR" };
  return map[country] ?? "USD";
}
