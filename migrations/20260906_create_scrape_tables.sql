-- Phase 3 (scraper): run log, rejection log, and the shared job-board catalog.
--
-- scrape_rejections is the point of this file. The title/location filters
-- decide what gets stored, and a filter that's too strict is indistinguishable
-- from a broken scraper unless the things it threw away are visible. Every
-- filtered-out posting is logged here with the reason and the evidence the
-- matcher used, deduped on URL so a posting the board keeps listing doesn't
-- pile up a row per run. The /boards page reads this list and offers an "add
-- anyway" per row, which is how a false negative gets corrected.
--
-- Duplicates (URL already in job_postings) and expired postings are counted
-- on the run row but NOT logged as rejections: neither says anything about
-- filter strictness, and they'd bury the rows that do.
--
-- Additive. RLS mirrors the other per-user tables. Safe to re-run.

create table if not exists anime_jobs.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid references anime_jobs.job_boards(id) on delete set null,
  board_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'ok', 'partial', 'skipped', 'error')),
  fetched integer not null default 0,
  inserted integer not null default 0,
  rejected integer not null default 0,
  duplicates integer not null default 0,
  expired integer not null default 0,
  dry_run boolean not null default false,
  error text,
  notes jsonb not null default '{}'::jsonb
);

create index if not exists scrape_runs_user_started_idx
  on anime_jobs.scrape_runs (user_id, started_at desc);

comment on table anime_jobs.scrape_runs is
  'One row per (board, run). status partial = the run hit its time budget before finishing the board; skipped = nothing to do (e.g. Adzuna credentials missing).';

create table if not exists anime_jobs.scrape_rejections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid references anime_jobs.job_boards(id) on delete set null,
  board_name text not null,
  url text not null,
  company text,
  title text not null,
  location text,
  salary_range text,
  reason text not null check (reason in ('title', 'location', 'excluded_company')),
  details jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen integer not null default 1,
  unique (user_id, url)
);

create index if not exists scrape_rejections_user_seen_idx
  on anime_jobs.scrape_rejections (user_id, last_seen_at desc);

comment on table anime_jobs.scrape_rejections is
  'Postings the preference filters kept OUT of job_postings, with the reason. Deduped per URL (times_seen counts repeats). Review on /boards before trusting the filter.';

alter table anime_jobs.scrape_runs enable row level security;
alter table anime_jobs.scrape_rejections enable row level security;

do $$
begin
  create policy "scrape_runs_owner" on anime_jobs.scrape_runs
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create policy "scrape_rejections_owner" on anime_jobs.scrape_rejections
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Shared starter catalog (owner_user_id null). scrape_config.adapter picks the
-- code path in web/lib/scraper/sources; the rest is that adapter's config.
--
-- Not LinkedIn, not Indeed: both block scraping and it risks the account
-- used to apply through them.
--
-- The three curated boards were checked for schema.org JobPosting JSON-LD on
-- 2026-09-06: Tech Jobs for Good and AllHands (a Getro board) carry it on
-- their job detail pages; the 80,000 Hours board has none, but its Nuxt front
-- end reads a public JSON endpoint (backend.eawork.org/api/jobs) which is used
-- directly. No board needed the CSS-selector fallback, so none is seeded.
--
-- AllHands job pages come from its sitemap (newest <lastmod> first). Tech
-- Jobs for Good's sitemap also lists premium-only postings, whose pages are a
-- "Premium Membership Required" wall with no JSON-LD, so its pages come from
-- the public listing (?page=N&sort_by=date), which links only readable ones.
--
-- scrape_config.order runs sources small-first. The 80,000 Hours feed takes
-- ~25s to start responding, so it goes last and skips itself when a run has
-- too little budget left.
-- ---------------------------------------------------------------------------

insert into anime_jobs.job_boards (owner_user_id, name, url, source_type, scrape_config, enabled)
select null, v.name, v.url, v.source_type, v.scrape_config::jsonb, true
from (values
  ('RemoteOK',
   'https://remoteok.com/api',
   'api',
   '{"adapter": "remoteok", "order": 10}'),
  ('Adzuna',
   'https://api.adzuna.com/v1/api/jobs/us/search/1',
   'api',
   '{"adapter": "adzuna", "country": "us", "pages": 1, "results_per_page": 50, "order": 20}'),
  ('80,000 Hours',
   'https://80000hours.org/job-board/',
   'api',
   '{"adapter": "eawork", "endpoint": "https://backend.eawork.org/api/jobs", "order": 50}'),
  ('AllHands',
   'https://jobs.all-hands.us/jobs',
   'structured_data',
   '{"adapter": "jsonld", "discovery": "sitemap", "sitemap_url": "https://jobs.all-hands.us/sitemap.xml", "job_url_pattern": "/companies/[^/]+/jobs/", "sort": "lastmod", "max_detail_fetches": 60, "order": 40}'),
  ('Tech Jobs for Good',
   'https://techjobsforgood.com/jobs/',
   'structured_data',
   '{"adapter": "jsonld", "discovery": "listing", "listing_url": "https://techjobsforgood.com/jobs/?page={page}&sort_by=date", "listing_pages": 3, "job_url_pattern": "^https://techjobsforgood\\.com/jobs/\\d+/$", "max_detail_fetches": 60, "order": 30}')
) as v(name, url, source_type, scrape_config)
where not exists (
  select 1 from anime_jobs.job_boards b where b.url = v.url
);
