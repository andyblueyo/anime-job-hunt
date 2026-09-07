-- Phase 3 (scraper): per-user job-search preferences on `settings`.
--
-- What each one does — this matters, because getting it wrong toward "filter
-- everything" produces an empty queue that looks like a broken scraper:
--
--   target_roles       FILTER. A scraped posting whose title matches none of
--                      these (or their level variants) is not stored — it's
--                      logged to scrape_rejections instead.
--   target_locations   FILTER. Non-matching postings are not stored. A posting
--                      with NO location is kept (missing optional field).
--   experience_level   NOT a filter. Postings carry no experience field; level
--                      is encoded in titles. This expands target_roles into
--                      title variants ("Senior Product Manager", "APM",
--                      "Head of Product") that feed the title matcher. It only
--                      ever adds matches.
--   salary_min         NOT a filter. Most curated boards don't publish pay, so
--                      filtering on it would discard most of the pipeline as
--                      "unknown". Stored as a preference that informs ranking
--                      and display on the queue.
--   excluded_companies (existing) FILTER, exact company-name match.
--
-- Also seeds target_roles for the existing user (rows that still have the
-- empty default). New rows keep '{}' as the column default — the seed is a
-- product-manager job search, not a property of the schema; the code-level
-- default (web/lib/settings.ts) carries the same three titles for users
-- without a row yet.
--
-- Additive. Safe to re-run.

alter table anime_jobs.settings
  add column if not exists experience_level text not null default 'any';

do $$
begin
  alter table anime_jobs.settings
    add constraint settings_experience_level_valid
    check (experience_level in ('any', 'entry', 'mid', 'senior', 'lead', 'executive'));
exception
  when duplicate_object then null;
end $$;

alter table anime_jobs.settings
  add column if not exists salary_min integer;

do $$
begin
  alter table anime_jobs.settings
    add constraint settings_salary_min_nonnegative
    check (salary_min is null or salary_min >= 0);
exception
  when duplicate_object then null;
end $$;

alter table anime_jobs.settings
  add column if not exists salary_currency text not null default 'USD';

comment on column anime_jobs.settings.target_roles is
  'FILTER: job titles to keep. Expanded with experience_level variants by the scraper''s title matcher. Empty = generic API sources are skipped (nothing to search for); curated boards are stored unfiltered.';
comment on column anime_jobs.settings.target_locations is
  'FILTER: locations to keep ("Remote", "San Francisco", "US"). Empty = no location filter. Postings with no location are always kept.';
comment on column anime_jobs.settings.experience_level is
  'NOT a filter. Adds title variants for the level (entry: Associate/Junior/APM; senior: Senior/Staff; lead: Lead/Principal/Group; executive: Head of/Director/VP) to the title matcher.';
comment on column anime_jobs.settings.salary_min is
  'NOT a filter. Annual salary floor (in salary_currency) used to rank and badge postings on the queue. Null = no preference.';
comment on column anime_jobs.settings.salary_currency is
  'ISO 4217 code for salary_min. Default USD.';

update anime_jobs.settings
  set target_roles = array['Product Manager', 'Product Lead', 'Product Owner']
  where cardinality(target_roles) = 0;
