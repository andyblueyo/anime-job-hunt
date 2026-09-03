/** A live job-search tab opened when the saved-postings queue runs dry. */
export interface SearchFallbackTab {
  isSearchFallback: true;
  id: null;
  company: null;
  title: string;
  url: string;
  location: string | null;
}

// A small pool of job-search engines to cycle through so a multi-tab
// shortfall isn't N copies of the same search. No scraping — these are just
// search-results pages for the user to browse manually.
const ENGINES: Array<(role: string, location: string) => string> = [
  (role, location) =>
    `https://www.indeed.com/jobs?q=${encodeURIComponent(role)}&l=${encodeURIComponent(location)}`,
  (role, location) =>
    `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}`,
  (role, location) =>
    `https://www.google.com/search?q=${encodeURIComponent(`${role} jobs ${location}`.trim())}&ibp=htl;jobs`,
];

/**
 * Builds `count` live search tabs from the user's saved target roles/
 * locations. These don't get a `job_posting_id`, aren't persisted, and don't
 * count toward an unlock session's progress — there's nothing to mark
 * "applied" on a search-results page.
 */
export function buildSearchFallbackTabs(
  count: number,
  targetRoles: string[],
  targetLocations: string[],
): SearchFallbackTab[] {
  const roles = targetRoles.length > 0 ? targetRoles : [""];
  const locations = targetLocations.length > 0 ? targetLocations : [""];

  return Array.from({ length: count }, (_, i) => {
    const role = roles[i % roles.length];
    const location = locations[i % locations.length];
    const engine = ENGINES[i % ENGINES.length];
    const label = [role, location].filter(Boolean).join(" · ") || "open job search";

    return {
      isSearchFallback: true as const,
      id: null,
      company: null,
      title: `Search: ${label}`,
      url: engine(role, location),
      location: location || null,
    };
  });
}
