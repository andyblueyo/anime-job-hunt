// parsePostingUrl: paste a job link, get the Add Posting form pre-filled.
// Fetch (fetch.ts) -> extract (extract.ts) -> one-line verdict. Never writes
// to the database; saving stays in app/actions.ts addPosting.

import { extractPosting, looksLikeJobPage } from "./extract";
import { FetchFailure, fetchPostingHtml, parseHttpUrl, type FetchDeps } from "./fetch";
import { documentTitle, headHtml } from "./html";
import {
  emptyFields,
  emptyProvenance,
  parsedFieldCount,
  type ParseOutcome,
  type ParsePostingResult,
} from "./types";

export type { ParsePostingResult, ParsedFields, ParsedFieldName, Provenance } from "./types";
export { parsedFieldCount } from "./types";

/**
 * Sites that answer anonymous fetches with a login wall or a bot check rather
 * than the posting. Named in the message so the user knows it isn't their
 * link that's wrong.
 */
const WALLED_HOSTS: Array<{ re: RegExp; label: string }> = [
  { re: /(^|\.)linkedin\.com$/i, label: "LinkedIn" },
  { re: /(^|\.)indeed\.[a-z.]+$/i, label: "Indeed" },
  { re: /(^|\.)glassdoor\.[a-z.]+$/i, label: "Glassdoor" },
];

const WALL_TITLE = /\b(sign in|log ?in|login|security check|access denied|just a moment|attention required|authenticating|verify you are|are you a human|captcha|unusual traffic)\b/i;
const WALL_PATH = /\/(authwall|login|signin|sign-in|log-in|checkpoint|challenge|verify|captcha)\b/i;

function walledHost(url: URL): string | null {
  return WALLED_HOSTS.find((w) => w.re.test(url.hostname))?.label ?? null;
}

function blockedMessage(site: string | null): string {
  const who = site ?? "That site";
  return `${who} didn't let us read the posting (login wall or bot check) — LinkedIn, Indeed, and Glassdoor usually don't. Fill the details in by hand.`;
}

function failure(url: string, outcome: ParseOutcome, message: string): ParsePostingResult {
  return {
    fields: emptyFields(url),
    provenance: emptyProvenance(Boolean(url)),
    outcome,
    message,
  };
}

export async function parsePostingUrl(raw: string, deps: FetchDeps = {}): Promise<ParsePostingResult> {
  let url: URL;
  try {
    url = parseHttpUrl(raw);
  } catch (error) {
    const message = error instanceof FetchFailure ? error.message : "That doesn't look like a URL.";
    return failure(raw.trim(), "invalid_url", message);
  }
  const input = url.toString();
  const site = walledHost(url);

  let page;
  try {
    page = await fetchPostingHtml(input, deps);
  } catch (error) {
    if (!(error instanceof FetchFailure)) {
      return failure(input, "network", `Couldn't fetch the page: ${error instanceof Error ? error.message : String(error)}`);
    }
    switch (error.kind) {
      case "invalid_url":
      case "blocked_target":
        return failure(input, "invalid_url", error.message);
      case "timeout":
        return failure(input, "timeout", `${error.message} Fill the details in by hand.`);
      case "not_html":
        return failure(input, "not_html", error.message);
      case "http_error": {
        const status = error.status ?? 0;
        // 401/403/429/999 are the shapes a login wall or bot check takes.
        if (site || status === 401 || status === 403 || status === 429 || status === 999) {
          return failure(input, "blocked", blockedMessage(site));
        }
        return failure(input, "network", `${error.message} Check the link, or fill the details in by hand.`);
      }
      case "network":
      default:
        return failure(input, "network", `${error.message} Fill the details in by hand.`);
    }
  }

  // A login wall or bot check that answers 200 still has a <title> and often
  // an og:site_name, so it would parse as a "job" with the wrong company. Rule
  // it out before trusting anything on the page.
  const finalUrl = new URL(page.finalUrl);
  const title = documentTitle(headHtml(page.html)) ?? "";
  const landedOnWall = WALL_PATH.test(finalUrl.pathname) || WALL_TITLE.test(title);
  if (landedOnWall) return failure(input, "blocked", blockedMessage(site ?? walledHost(finalUrl)));

  const parsed = extractPosting(page.html, input);
  // On LinkedIn/Indeed/Glassdoor a guest fetch that isn't the posting is
  // usually some other 200 page (a search listing, a redirect target) whose
  // <title> parses as a plausible-looking wrong role. Only structured data
  // counts there; metadata alone is treated as the wall it almost always is.
  const walled = site ?? walledHost(finalUrl);
  const structured = (p: string) => p === "jsonld" || p === "microdata";
  const trusted = walled
    ? structured(parsed.provenance.title) || structured(parsed.provenance.company)
    : looksLikeJobPage(parsed);
  if (trusted) {
    const count = parsedFieldCount(parsed.provenance);
    return {
      ...parsed,
      outcome: "ok",
      message:
        count >= 4
          ? null
          : `Found ${count} of 5 fields on the page — fill in the rest and check what's there.`,
    };
  }

  // Nothing usable. A walled host that gave us nothing is a wall, not a
  // parser gap; say so.
  if (walled) return failure(input, "blocked", blockedMessage(walled));
  return failure(
    input,
    "no_job_data",
    "Fetched the page but found no job data on it (no structured data or job metadata). Fill the details in by hand.",
  );
}
