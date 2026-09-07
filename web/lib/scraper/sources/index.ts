// job_boards.scrape_config.adapter -> code. Adding a source = one file here
// plus a catalog row (see migrations/20260906_create_scrape_tables.sql).
//
// There is deliberately no CSS-selector adapter yet: the plan called for one
// as a fallback where a board lacks JobPosting JSON-LD, and none of the three
// curated boards did (two carry it; 80,000 Hours has a JSON endpoint). Code
// with no board to run against would be untested code.

import { adzuna } from "./adzuna";
import { eawork } from "./eawork";
import { jsonld } from "./jsonld";
import { remoteok } from "./remoteok";
import type { Adapter } from "./types";

export const ADAPTERS: Record<string, Adapter> = {
  remoteok,
  adzuna,
  eawork,
  jsonld,
};

export type { Adapter, Candidate, SourceContext, SourceResult } from "./types";
