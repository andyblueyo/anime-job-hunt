// Pure text/URL helpers shared by the matcher, the adapters, and the queue UI.
// No imports from server modules — lib/scraper/matching.ts is rendered in a
// client component (the title-variant preview on /settings).

/**
 * Lowercase, ASCII-fold, strip punctuation, expand the abbreviations job
 * titles actually use, collapse whitespace. "Sr. Product Mgr, Payments" ->
 * "senior product manager payments".
 */
export function normalizeText(input: string): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return folded
    .split(" ")
    .map((token) => ABBREVIATIONS[token] ?? token)
    .join(" ");
}

const ABBREVIATIONS: Record<string, string> = {
  sr: "senior",
  jr: "junior",
  mgr: "manager",
  mgmt: "management",
  assoc: "associate",
  eng: "engineering",
  svp: "senior vice president",
  evp: "executive vice president",
};

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  return normalized ? normalized.split(" ") : [];
}

/** True when `needle` appears in `haystack` as a contiguous token run. */
export function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Query parameters that identify the *visit*, not the posting. Stripped so the
 * same job reached through two boards (80k's `?utm_source=80000hours`, a Getro
 * board's `?utm_source=All-hands+job+board&gh_src=...`) dedupes to one row.
 * Anything not listed is kept: `gh_jid`, `jobId`, `?id=` and friends are
 * often the only thing telling two postings apart.
 */
const TRACKING_PARAMS = new Set([
  "ref",
  "source",
  "src",
  "gh_src",
  "lever-source",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "trk",
  "trackingid",
]);

export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Salary text
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AUD: "A$" };

function money(amount: number, currency: string | null): string {
  const rounded = Math.round(amount).toLocaleString("en-US");
  if (!currency) return rounded;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${rounded}` : `${currency} ${rounded}`;
}

/** "$170,000–$220,000", "$170,000+", "up to $220,000", or null. Annual figures only. */
export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
): string | null {
  const lo = min && min > 0 ? min : null;
  const hi = max && max > 0 ? max : null;
  if (lo && hi) return lo === hi ? money(lo, currency) : `${money(lo, currency)}–${money(hi, currency)}`;
  if (lo) return `${money(lo, currency)}+`;
  if (hi) return `up to ${money(hi, currency)}`;
  return null;
}

/**
 * Best-effort annual figures out of free text ("$140k–$170k", "140,000 -
 * 170,000 USD", "up to $220,000"). Hourly and monthly rates come back null —
 * a number under 10,000 that isn't written with a "k" is not an annual salary.
 * Used for the queue's salary badge, where being unsure is fine.
 */
export function parseSalaryText(text: string | null): { min: number | null; max: number | null } {
  if (!text) return { min: null, max: null };
  const values: number[] = [];
  const re = /(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let value = Number(match[1].replace(/,/g, "").replace(/\.(?=\d{3}\b)/g, ""));
    if (!Number.isFinite(value)) continue;
    if (match[2]) value *= 1000;
    if (value < 10_000) continue;
    values.push(value);
  }
  if (values.length === 0) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}
