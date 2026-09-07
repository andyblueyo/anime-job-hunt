// Shapes for the paste-a-link parser (lib/posting-parser). Kept dependency-free
// so the review form (a client component) can import them.

/** Where a field's value came from. `none` = left blank, the user fills it in. */
export type Provenance = "jsonld" | "microdata" | "meta" | "url" | "none";

/**
 * The Add Posting form's fields, as strings ready for `defaultValue`. Column
 * names match anime_jobs.job_postings so the review form posts straight into
 * the existing addPosting action.
 */
export interface ParsedFields {
  company: string;
  title: string;
  url: string;
  location: string;
  salary_range: string;
  /** YYYY-MM-DD or "". */
  posted_date: string;
}

export type ParsedFieldName = keyof ParsedFields;

export const PARSED_FIELD_NAMES: ParsedFieldName[] = [
  "company",
  "title",
  "url",
  "location",
  "salary_range",
  "posted_date",
];

export interface ParsedPosting {
  fields: ParsedFields;
  provenance: Record<ParsedFieldName, Provenance>;
}

/**
 * Why a parse came back with less than a full form. `ok` covers partial
 * parses too — the per-field provenance says what's missing.
 */
export type ParseOutcome =
  | "ok"
  | "no_job_data"
  | "blocked"
  | "timeout"
  | "network"
  | "not_html"
  | "invalid_url";

export interface ParsePostingResult extends ParsedPosting {
  outcome: ParseOutcome;
  /** One line for the review screen. Null when everything went to plan. */
  message: string | null;
}

export function emptyFields(url = ""): ParsedFields {
  return { company: "", title: "", url, location: "", salary_range: "", posted_date: "" };
}

export function emptyProvenance(urlKnown: boolean): Record<ParsedFieldName, Provenance> {
  return {
    company: "none",
    title: "none",
    url: urlKnown ? "url" : "none",
    location: "none",
    salary_range: "none",
    posted_date: "none",
  };
}

/** How many of the five visible fields (not the URL itself) were parsed. */
export function parsedFieldCount(provenance: Record<ParsedFieldName, Provenance>): number {
  return PARSED_FIELD_NAMES.filter((f) => f !== "url" && provenance[f] !== "none").length;
}
