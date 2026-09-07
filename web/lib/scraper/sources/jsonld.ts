// Generic adapter for boards that publish schema.org JobPosting JSON-LD on
// each job's detail page. Two ways to find those pages:
//
//   discovery: "sitemap" (default)
//     sitemap_url         sitemap index or urlset
//     job_url_pattern     regex a <loc> must match to be a job page
//     sort                "lastmod" (default: newest <lastmod> first, else
//                         sitemap order) or "id_desc" (largest number in the
//                         URL path first)
//   discovery: "listing"
//     listing_url         with a {page} placeholder, e.g.
//                         https://board.example/jobs/?page={page}&sort_by=date
//     listing_pages       how many pages to walk, default 3
//     job_url_pattern     regex an <a href> (resolved absolute) must match
//
//   max_detail_fetches    per run, default 120 — politeness cap
//   order                 number; run sequence across boards (see run.ts)
//
// Used for AllHands (a Getro board; sitemap, checked 2026-09-06) and Tech
// Jobs for Good (listing: its sitemap also lists premium-only postings whose
// pages are a "Premium Membership Required" wall with no JSON-LD, while the
// public listing pages link only to readable ones).
//
// Only pages not already in job_postings or the rejection log are fetched, so
// each run works down from the newest unseen page until the cap or the run's
// time budget; `partial` says there was more. A big board is covered over a
// series of runs rather than in one.

import { canonicalUrl } from "../normalize";
import type { Adapter, Candidate, SourceContext } from "./types";
import { num, str } from "./types";

const DEFAULT_MAX_FETCHES = 120;
const CONCURRENCY = 6;

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

function parseSitemap(xml: string): { children: string[]; entries: SitemapEntry[] } {
  const children: string[] = [];
  const entries: SitemapEntry[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const blockRe = isIndex ? /<sitemap>([\s\S]*?)<\/sitemap>/gi : /<url>([\s\S]*?)<\/url>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(xml))) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(match[1])?.[1];
    if (!loc) continue;
    const decoded = loc.replace(/&amp;/g, "&");
    if (isIndex) children.push(decoded);
    else entries.push({ loc: decoded, lastmod: /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(match[1])?.[1] ?? null });
  }
  return { children, entries };
}

/** The last run of digits in the URL path, e.g. .../jobs/35932/ -> 35932. */
function pathId(loc: string): number {
  const path = loc.replace(/[?#].*$/, "");
  const matches = path.match(/\d+/g);
  return matches ? Number(matches[matches.length - 1]) : -1;
}

async function collectJobUrls(
  ctx: SourceContext,
  sitemapUrl: string,
  pattern: RegExp,
  sort: "lastmod" | "id_desc",
): Promise<SitemapEntry[]> {
  const first = parseSitemap(await ctx.fetchText(sitemapUrl));
  let entries = first.entries;
  for (const child of first.children.slice(0, 10)) {
    if (ctx.budget.exhausted()) break;
    entries = entries.concat(parseSitemap(await ctx.fetchText(child)).entries);
  }
  const jobs = entries.filter((e) => pattern.test(e.loc));
  if (sort === "id_desc") {
    jobs.sort((a, b) => pathId(b.loc) - pathId(a.loc));
  } else if (jobs.some((e) => e.lastmod)) {
    jobs.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  }
  return jobs;
}

/**
 * Walk listing pages and collect job links in page order (the board's own
 * newest-first when the URL asks for it). Relative hrefs are resolved against
 * the listing URL; HTML entities in hrefs are decoded.
 */
async function collectListingUrls(
  ctx: SourceContext,
  listingUrl: string,
  pages: number,
  pattern: RegExp,
): Promise<SitemapEntry[]> {
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (let page = 1; page <= pages; page++) {
    if (ctx.budget.exhausted()) break;
    const pageUrl = listingUrl.replace("{page}", String(page));
    const html = await ctx.fetchText(pageUrl);
    const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    let found = 0;
    while ((match = hrefRe.exec(html))) {
      let absolute: string;
      try {
        absolute = new URL(match[1].replace(/&amp;/g, "&"), pageUrl).toString();
      } catch {
        continue;
      }
      // Listing links carry their own tracking (?ref=homepage); match and
      // fetch the clean page URL.
      const clean = absolute.replace(/[?#].*$/, "");
      if (!pattern.test(clean) || seen.has(clean)) continue;
      seen.add(clean);
      out.push({ loc: clean, lastmod: null });
      found++;
    }
    if (found === 0) break; // ran off the end of the listing
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD -> Candidate
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function isJobPosting(node: unknown): node is Json {
  if (!node || typeof node !== "object") return false;
  const type = (node as Json)["@type"];
  return asArray(type).some((t) => typeof t === "string" && t.toLowerCase() === "jobposting");
}

/** Every JobPosting node in the page's ld+json blocks (top-level, arrays, @graph). */
export function extractJobPostings(html: string): Json[] {
  const found: Json[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    for (const node of asArray(parsed)) {
      if (isJobPosting(node)) found.push(node);
      const graph = (node as Json | null)?.["@graph"];
      for (const inner of asArray(graph)) if (isJobPosting(inner)) found.push(inner);
    }
  }
  return found;
}

function placeText(place: unknown): string | null {
  if (!place || typeof place !== "object") return null;
  const p = place as Json;
  // Getro nests {address: {address: {...}}}; schema.org is {address: {...}}.
  const addr = (p.address && typeof p.address === "object" && "address" in (p.address as Json)
    ? (p.address as Json).address
    : p.address) as Json | string | undefined;
  if (typeof addr === "string") return addr.trim() || null;
  if (!addr || typeof addr !== "object") return str(p.name);
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
    .map(str)
    .filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(", ") : str(addr.name);
}

function salaryOf(node: Json): Pick<Candidate, "salary_min" | "salary_max" | "salary_currency" | "salary_text"> {
  const none = { salary_min: null, salary_max: null, salary_currency: null, salary_text: null };
  const base = node.baseSalary;
  if (!base || typeof base !== "object") return none;
  const b = base as Json;
  const currency = str(b.currency);
  const value = b.value;
  let min: number | null = null;
  let max: number | null = null;
  let unit: string | null = null;
  if (typeof value === "number") {
    min = max = num(value);
  } else if (value && typeof value === "object") {
    const v = value as Json;
    unit = str(v.unitText);
    // Tech Jobs for Good capitalizes "Value"; schema.org says "value".
    const single = num(v.value ?? v.Value);
    min = num(v.minValue) ?? single;
    max = num(v.maxValue) ?? single;
  }
  if (unit && !/year|annual/i.test(unit)) {
    // Hourly/monthly: keep the text, don't pretend it's annual.
    const text = [min, max].filter(Boolean).join("–");
    return { ...none, salary_text: text ? `${text} ${currency ?? ""} / ${unit}`.trim() : null };
  }
  return { salary_min: min, salary_max: max, salary_currency: currency, salary_text: null };
}

export function candidateFromJobPosting(node: Json, pageUrl: string): Candidate | null {
  const title = str(node.title);
  if (!title) return null;
  const org = node.hiringOrganization as Json | string | undefined;
  const company = typeof org === "string" ? str(org) : str(org?.name);

  const places = asArray(node.jobLocation).map(placeText).filter((x): x is string => Boolean(x));
  const uniquePlaces = [...new Set(places)];
  const remote = asArray(node.jobLocationType).some(
    (t) => typeof t === "string" && /telecommute|remote/i.test(t),
  );
  const requirement = node.applicantLocationRequirements as Json | undefined;
  const requirementName = requirement && typeof requirement === "object" ? str(requirement.name) : null;
  let location = uniquePlaces.length > 0 ? uniquePlaces.join("; ") : null;
  if (remote) location = location ? `Remote; ${location}` : requirementName ? `Remote (${requirementName})` : "Remote";

  return {
    title,
    company,
    url: pageUrl,
    location,
    remote,
    ...salaryOf(node),
    posted_at: str(node.datePosted),
    closes_at: str(node.validThrough),
  };
}

// ---------------------------------------------------------------------------

export const jsonld: Adapter = async (ctx) => {
  const config = ctx.board.scrape_config;
  const patternSource = str(config.job_url_pattern);
  if (!patternSource) throw new Error("jsonld needs scrape_config.job_url_pattern");
  const pattern = new RegExp(patternSource);
  const maxFetches = Math.trunc(num(config.max_detail_fetches) ?? DEFAULT_MAX_FETCHES);

  let all: SitemapEntry[];
  if (config.discovery === "listing") {
    const listingUrl = str(config.listing_url);
    if (!listingUrl) throw new Error('jsonld with discovery "listing" needs scrape_config.listing_url');
    const pages = Math.min(Math.max(Math.trunc(num(config.listing_pages) ?? 3), 1), 20);
    all = await collectListingUrls(ctx, listingUrl, pages, pattern);
  } else {
    const sitemapUrl = str(config.sitemap_url);
    if (!sitemapUrl) throw new Error("jsonld needs scrape_config.sitemap_url (or discovery: listing)");
    const sort = config.sort === "id_desc" ? "id_desc" : "lastmod";
    all = await collectJobUrls(ctx, sitemapUrl, pattern, sort);
  }
  const unseen = all.filter((e) => {
    const canonical = canonicalUrl(e.loc);
    return canonical !== null && !ctx.seen(canonical);
  });
  const queue = unseen.slice(0, maxFetches);

  const candidates: Candidate[] = [];
  let fetched = 0;
  let noJsonLd = 0;
  let failed = 0;
  let stoppedForBudget = false;

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      if (ctx.budget.exhausted()) {
        stoppedForBudget = true;
        return;
      }
      const entry = queue[cursor++];
      try {
        const html = await ctx.fetchText(entry.loc);
        fetched++;
        const nodes = extractJobPostings(html);
        if (nodes.length === 0) {
          noJsonLd++;
          continue;
        }
        const candidate = candidateFromJobPosting(nodes[0], entry.loc);
        if (candidate) candidates.push(candidate);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return {
    candidates,
    partial: stoppedForBudget || unseen.length > queue.length,
    notes: {
      discovery: config.discovery === "listing" ? "listing" : "sitemap",
      job_urls: all.length,
      unseen: unseen.length,
      fetched,
      no_jsonld: noJsonLd,
      failed,
      stopped_for_budget: stoppedForBudget,
    },
  };
};
