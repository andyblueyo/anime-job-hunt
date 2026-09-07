// HTML -> ParsedPosting. Pure: no fetch, no database, so it runs against the
// saved fixtures in __fixtures__/ with no network.
//
// Parse order, first hit wins per field:
//   1. JSON-LD JobPosting (bare object, array, or nested in @graph)
//   2. Microdata itemtype=schema.org/JobPosting, same field mapping
//   3. Meta tags: og:title, og:site_name, <title>
//   4. Known-host URL heuristics (Greenhouse / Lever / Ashby company slugs)
//
// Never guess: a field with no source stays "" with provenance "none". A blank
// the user fills in is fine; a plausible-looking wrong company name is not.

import { extractJobPostings } from "@/lib/scraper/sources/jsonld";
import { attr, cleanText, documentTitle, metaContent, truncate } from "./html";
import {
  emptyFields,
  emptyProvenance,
  type ParsedFieldName,
  type ParsedPosting,
  type Provenance,
} from "./types";

type Json = Record<string, unknown>;

// Column widths are unconstrained in the migration; these keep a bad parse from
// dumping a paragraph into the queue.
const MAX_LEN: Record<Exclude<ParsedFieldName, "url">, number> = {
  company: 120,
  title: 160,
  location: 160,
  salary_range: 80,
  posted_date: 10,
};

// og:site_name on an ATS-hosted page names the ATS, not the employer. A
// company careers site sets it to the company, which is what we want.
const ATS_SITE_NAMES = new Set(
  [
    "greenhouse",
    "lever",
    "ashby",
    "ashbyhq",
    "workday",
    "myworkdayjobs",
    "linkedin",
    "indeed",
    "glassdoor",
    "workable",
    "smartrecruiters",
    "jobvite",
    "icims",
    "bamboohr",
    "recruitee",
    "breezy",
    "breezy hr",
    "rippling",
    "gem",
    "dover",
    "wellfound",
    "welcome to the jungle",
    "otta",
    "builtin",
    "built in",
    "ziprecruiter",
    "monster",
    "dice",
    "simplyhired",
    "teamtailor",
    "personio",
    "pinpoint",
    "jobs",
    "careers",
  ].map((s) => s.toLowerCase()),
);

// ---------------------------------------------------------------------------
// Field-level helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const cleaned = cleanText(value);
  return cleaned || null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.replace(/[,\s]/g, "")) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/** "senior-product-manager" / "acme_corp" -> "Senior Product Manager" / "Acme Corp". */
export function titleCaseSlug(slug: string): string {
  return decodeURIComponent(slug)
    .split(/[-_+\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** datePosted may be a date, a datetime, or junk. Only YYYY-MM-DD gets through. */
export function normalizeDate(value: string | null): string {
  if (!value) return "";
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  const candidate = direct ? direct[1] : (() => {
    const t = new Date(value);
    return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
  })();
  if (!candidate) return "";
  const t = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(t.getTime()) ? "" : candidate;
}

// Salary -> the compact form the form's placeholder shows: "$140k–$170k".
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AUD: "A$" };

function compactMoney(amount: number, currency: string | null): string {
  let body: string;
  if (amount >= 10_000) {
    const k = amount / 1000;
    body = `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, "")}k`;
  } else {
    body = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, "");
  }
  if (!currency) return body;
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${body}` : `${currency.toUpperCase()} ${body}`;
}

const UNIT_SUFFIX: Array<[RegExp, string]> = [
  [/hour/i, "/hr"],
  [/day/i, "/day"],
  [/week/i, "/wk"],
  [/month/i, "/mo"],
];

export function formatCompactSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
  unit: string | null,
): string {
  const lo = min && min > 0 ? min : null;
  const hi = max && max > 0 ? max : null;
  if (!lo && !hi) return "";
  const suffix = unit ? UNIT_SUFFIX.find(([re]) => re.test(unit))?.[1] ?? "" : "";
  let body: string;
  if (lo && hi && lo !== hi) {
    body = `${compactMoney(Math.min(lo, hi), currency)}–${compactMoney(Math.max(lo, hi), currency)}`;
  } else {
    body = compactMoney((lo ?? hi) as number, currency);
  }
  return `${body}${suffix}`;
}

function salaryFromNode(node: Json): string {
  const base = node.baseSalary;
  if (base === undefined || base === null) return "";
  if (typeof base === "number" || typeof base === "string") {
    return formatCompactSalary(num(base), num(base), null, null);
  }
  if (typeof base !== "object") return "";
  const b = base as Json;
  const currency = str(b.currency);
  const value = b.value;
  let min: number | null = null;
  let max: number | null = null;
  let unit: string | null = null;
  if (typeof value === "number" || typeof value === "string") {
    min = max = num(value);
  } else if (value && typeof value === "object") {
    const v = value as Json;
    unit = str(v.unitText);
    const single = num(v.value ?? v.Value);
    min = num(v.minValue) ?? single;
    max = num(v.maxValue) ?? single;
  } else {
    // Some pages put min/max straight on the MonetaryAmount.
    min = num(b.minValue);
    max = num(b.maxValue);
    unit = str(b.unitText);
  }
  return formatCompactSalary(min, max, currency, unit);
}

function locationFromNode(node: Json): string {
  const places: string[] = [];
  for (const place of asArray(node.jobLocation)) {
    if (typeof place === "string") {
      const text = str(place);
      if (text) places.push(text);
      continue;
    }
    if (!place || typeof place !== "object") continue;
    const p = place as Json;
    // Getro nests {address: {address: {...}}}; schema.org is {address: {...}}.
    let addr = p.address;
    if (addr && typeof addr === "object" && "address" in (addr as Json)) addr = (addr as Json).address;
    if (typeof addr === "string") {
      const text = str(addr);
      if (text) places.push(text);
      continue;
    }
    if (addr && typeof addr === "object") {
      const a = addr as Json;
      const parts = [str(a.addressLocality), str(a.addressRegion)].filter((x): x is string => Boolean(x));
      // Locality+region is the spec; a country-only address is still a location.
      if (parts.length === 0) {
        const country = str(a.addressCountry) ?? str((a.addressCountry as Json | undefined)?.name);
        if (country) parts.push(country);
      }
      if (parts.length > 0) places.push(parts.join(", "));
      else if (str(a.name)) places.push(str(a.name) as string);
      continue;
    }
    if (str(p.name)) places.push(str(p.name) as string);
  }
  const unique = [...new Set(places)];

  const remote = asArray(node.jobLocationType).some(
    (t) => typeof t === "string" && /telecommute|remote/i.test(t),
  );
  const requirement = asArray(node.applicantLocationRequirements)
    .map((r) => (r && typeof r === "object" ? str((r as Json).name) : str(r)))
    .filter((x): x is string => Boolean(x));

  if (remote || requirement.length > 0) {
    const scope = unique.length > 0 ? unique.join("; ") : requirement.join(", ");
    return scope ? `Remote — ${scope}` : "Remote";
  }
  return unique.join("; ");
}

function companyFromNode(node: Json): string {
  const org = node.hiringOrganization;
  if (typeof org === "string") return str(org) ?? "";
  if (org && typeof org === "object") return str((org as Json).name) ?? "";
  return "";
}

/** One schema.org JobPosting (from JSON-LD or microdata) -> field values. */
function fieldsFromNode(node: Json): Partial<Record<ParsedFieldName, string>> {
  return {
    title: str(node.title) ?? "",
    company: companyFromNode(node),
    location: locationFromNode(node),
    salary_range: salaryFromNode(node),
    posted_date: normalizeDate(str(node.datePosted)),
  };
}

// ---------------------------------------------------------------------------
// Microdata -> a JSON-LD-shaped node, so the one mapper above serves both
// ---------------------------------------------------------------------------

const JOBPOSTING_ITEMTYPE = /itemtype\s*=\s*["'][^"']*schema\.org\/JobPosting["']/i;

/**
 * Best-effort microdata reader. Finds every element carrying an `itemprop`
 * after the JobPosting itemscope and takes its value the way the spec does:
 * `content` on <meta>, `datetime` on <time>, `href` on <a>/<link>, otherwise
 * the element's text. Nesting is approximated by order: the props following
 * `hiringOrganization` / `jobLocation` / `baseSalary` until the next top-level
 * prop belong to that scope. Good enough for the flat markup real pages use.
 */
export function microdataJobPosting(html: string): Json | null {
  const start = html.search(JOBPOSTING_ITEMTYPE);
  if (start === -1) return null;
  const scopeStart = html.lastIndexOf("<", start);
  const region = html.slice(scopeStart);

  const node: Json = { "@type": "JobPosting" };
  const scopes: Record<string, Json> = {};
  let currentScope: string | null = null;

  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  let first = true;
  while ((match = tagRe.exec(region))) {
    if (first) {
      first = false;
      continue; // the JobPosting element itself
    }
    const [whole, tagName, attrs] = match;
    const prop = attr(attrs, "itemprop");
    if (!prop) continue;
    const isScope = /\bitemscope\b/i.test(attrs);

    if (isScope) {
      // A new nested scope. Only the three we map get collected.
      if (["hiringOrganization", "jobLocation", "baseSalary", "address", "value"].includes(prop)) {
        if (prop === "address" || prop === "value") {
          // stay inside the parent scope; these just wrap the leaf props
        } else {
          currentScope = prop;
          scopes[prop] = scopes[prop] ?? {};
        }
      } else {
        currentScope = null;
      }
      continue;
    }

    let value: string | null;
    const lower = tagName.toLowerCase();
    if (lower === "meta") value = attr(attrs, "content");
    else if (lower === "time") value = attr(attrs, "datetime") ?? innerText(region, match.index + whole.length, tagName);
    else if (lower === "a" || lower === "link") value = attr(attrs, "href") ?? innerText(region, match.index + whole.length, tagName);
    else value = innerText(region, match.index + whole.length, tagName);
    if (value === null) continue;
    const cleaned = cleanText(value);

    const LEAF_TOP = ["title", "datePosted", "jobLocationType", "applicantLocationRequirements", "description"];
    if (LEAF_TOP.includes(prop)) {
      currentScope = null;
      if (node[prop] === undefined) node[prop] = cleaned;
      continue;
    }
    if (currentScope) {
      const scope = scopes[currentScope];
      if (scope[prop] === undefined) scope[prop] = cleaned;
    }
  }

  if (scopes.hiringOrganization) node.hiringOrganization = scopes.hiringOrganization;
  if (scopes.jobLocation) node.jobLocation = { address: scopes.jobLocation };
  if (scopes.baseSalary) {
    const s = scopes.baseSalary;
    node.baseSalary = {
      currency: s.currency,
      value: { minValue: s.minValue, maxValue: s.maxValue, value: s.value, unitText: s.unitText },
    };
  }
  return node.title || node.hiringOrganization ? node : null;
}

/** Text between an opening tag (ending at `from`) and the matching close of the same tag name. */
function innerText(html: string, from: number, tagName: string): string | null {
  const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
  closeRe.lastIndex = 0;
  const rest = html.slice(from, from + 5000);
  const close = closeRe.exec(rest);
  if (!close) return null;
  return rest.slice(0, close.index);
}

// ---------------------------------------------------------------------------
// Meta tags + URL heuristics
// ---------------------------------------------------------------------------

/** Greenhouse's <title>: "Job Application for {title} at {company}". */
export function splitGreenhouseTitle(title: string): { title: string; company: string } | null {
  const match = /^Job Application for (.+?) at (.+)$/i.exec(title.trim());
  return match ? { title: match[1].trim(), company: match[2].trim() } : null;
}

/** Strip " - {company}", " | {company}", " at {company}", or a leading "{company} - ". */
export function stripCompanyFromTitle(title: string, company: string): string {
  if (!company) return title.trim();
  const escaped = company.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(new RegExp(`\\s+(?:[-–—|]|at|@)\\s+${escaped}\\s*$`, "i"), "")
    .replace(new RegExp(`^${escaped}\\s+[-–—|:]\\s+`, "i"), "")
    .trim();
}

const HOST_SLUG_RULES: Array<{ host: RegExp; slugIndex: number }> = [
  { host: /^(boards|job-boards)\.greenhouse\.io$/i, slugIndex: 0 },
  { host: /^(boards|job-boards)\.eu\.greenhouse\.io$/i, slugIndex: 0 },
  { host: /^jobs\.lever\.co$/i, slugIndex: 0 },
  { host: /^jobs\.(eu\.)?ashbyhq\.com$/i, slugIndex: 0 },
];

/** The company slug from a known ATS URL, title-cased. Null for every other host. */
export function companyFromUrl(url: URL): string | null {
  const rule = HOST_SLUG_RULES.find((r) => r.host.test(url.hostname));
  if (!rule) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const slug = segments[rule.slugIndex];
  if (!slug || /^(jobs?|embed|careers)$/i.test(slug)) return null;
  const company = titleCaseSlug(slug);
  return company || null;
}

function isGreenhouse(url: URL): boolean {
  return /(^|\.)greenhouse\.io$/i.test(url.hostname);
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/** True when the page actually describes a job (vs. a login wall or a 404 body). */
export function looksLikeJobPage(parsed: ParsedPosting): boolean {
  return parsed.provenance.title !== "none" || parsed.provenance.company !== "none";
}

export function extractPosting(html: string, pageUrl: string): ParsedPosting {
  const fields = emptyFields(pageUrl);
  const provenance = emptyProvenance(Boolean(pageUrl));

  const set = (name: Exclude<ParsedFieldName, "url">, value: string | null | undefined, source: Provenance) => {
    if (provenance[name] !== "none") return; // first hit wins
    const cleaned = cleanText(value);
    if (!cleaned) return;
    fields[name] = truncate(cleaned, MAX_LEN[name]);
    provenance[name] = source;
  };
  const apply = (values: Partial<Record<ParsedFieldName, string>>, source: Provenance) => {
    for (const name of ["title", "company", "location", "salary_range", "posted_date"] as const) {
      set(name, values[name], source);
    }
  };

  // 1. JSON-LD
  for (const node of extractJobPostings(html)) apply(fieldsFromNode(node), "jsonld");

  // 2. Microdata
  const micro = microdataJobPosting(html);
  if (micro) apply(fieldsFromNode(micro), "microdata");

  // 3. Meta tags
  let url: URL | null = null;
  try {
    url = new URL(pageUrl);
  } catch {
    url = null;
  }
  const docTitle = documentTitle(html);
  const greenhouse = docTitle ? splitGreenhouseTitle(docTitle) : null;
  if (greenhouse) {
    set("title", greenhouse.title, "meta");
    set("company", greenhouse.company, "meta");
  }
  const ogTitle = metaContent(html, "og:title", "twitter:title");
  const siteName = metaContent(html, "og:site_name");
  if (siteName && !ATS_SITE_NAMES.has(siteName.toLowerCase())) set("company", siteName, "meta");
  if (ogTitle) set("title", stripCompanyFromTitle(ogTitle, fields.company), "meta");
  if (docTitle) set("title", stripCompanyFromTitle(docTitle, fields.company), "meta");
  // Greenhouse (checked against job-boards.greenhouse.io, 2026-09-07) puts the
  // job's location list in og:description. Nowhere else is that safe to assume.
  if (url && isGreenhouse(url)) set("location", metaContent(html, "og:description"), "meta");

  // 4. Known-host URL slug
  if (url) set("company", companyFromUrl(url), "url");

  // A title we only got from metadata may still carry the company we found
  // later from the URL slug.
  if (provenance.title === "meta" && fields.company) {
    fields.title = truncate(stripCompanyFromTitle(fields.title, fields.company), MAX_LEN.title);
  }

  return { fields, provenance };
}
