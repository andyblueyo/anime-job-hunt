-- anime_jobs schema tables
-- Matches the schema drafted in the architecture plan (project doc: anime-job-hunt-plan.md).
-- Assumes the `anime_jobs` schema already exists and is exposed via
-- `alter role authenticator set pgrst.db_schemas = 'public, anime_jobs';` (already done).

create schema if not exists anime_jobs;

-- ---------------------------------------------------------------------------
-- job_boards: scrape sources. owner_user_id null = shared starter catalog
-- (seeded by an admin / service role), set = one user's private board.
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.job_boards (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  url text not null,
  source_type text not null check (source_type in ('structured_data', 'custom_selector', 'api')),
  scrape_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table anime_jobs.job_boards is 'Scrape sources. owner_user_id null = shared starter catalog, set = private to that user.';

-- ---------------------------------------------------------------------------
-- user_sites: anime site(s) each user has registered with the extension.
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.user_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  detection_strategy text not null default 'generic_video' check (detection_strategy in ('generic_video', 'manual_only')),
  title_selector text,
  end_marker_selector text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, domain)
);

-- ---------------------------------------------------------------------------
-- settings: one row per user.
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  target_roles text[] not null default '{}',
  target_locations text[] not null default '{}',
  excluded_companies text[] not null default '{}',
  tab_cap_per_hour integer not null default 1 check (tab_cap_per_hour > 0),
  default_anime_mode boolean not null default false,
  near_end_threshold_seconds integer not null default 10 check (near_end_threshold_seconds > 0),
  snooze_minutes integer not null default 10 check (snooze_minutes > 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- unlock_sessions: one row per episode-end trigger. Drives the lock screen.
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.unlock_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  required_count integer not null default 5 check (required_count > 0),
  status text not null default 'locked' check (status in ('locked', 'snoozed', 'completed')),
  snooze_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists unlock_sessions_user_status_idx on anime_jobs.unlock_sessions (user_id, status);

-- ---------------------------------------------------------------------------
-- job_postings
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.job_postings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text not null,
  title text not null,
  url text not null,
  location text,
  source text not null default 'manual' check (source in ('scraped', 'manual')),
  source_board uuid references anime_jobs.job_boards(id) on delete set null,
  session_id uuid references anime_jobs.unlock_sessions(id) on delete set null,
  posted_date date,
  salary_range text,
  status text not null default 'new' check (status in ('new', 'queued', 'applied', 'skipped', 'rejected')),
  scraped_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists job_postings_user_status_idx on anime_jobs.job_postings (user_id, status);
create index if not exists job_postings_session_idx on anime_jobs.job_postings (session_id);

-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
create table if not exists anime_jobs.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_posting_id uuid not null references anime_jobs.job_postings(id) on delete cascade,
  applied_at timestamptz not null default now(),
  method text not null default 'manual' check (method in ('auto-tab', 'manual')),
  resume_version text,
  notes text,
  follow_up_date date,
  outcome text,
  unique (job_posting_id)
);

create index if not exists applications_user_idx on anime_jobs.applications (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: every user only ever sees their own rows.
-- job_boards is the one exception - everyone can *read* the shared catalog
-- (owner_user_id is null) plus their own private boards, but can only
-- write rows they own.
-- ---------------------------------------------------------------------------
alter table anime_jobs.job_boards enable row level security;
alter table anime_jobs.user_sites enable row level security;
alter table anime_jobs.settings enable row level security;
alter table anime_jobs.unlock_sessions enable row level security;
alter table anime_jobs.job_postings enable row level security;
alter table anime_jobs.applications enable row level security;

create policy "job_boards_select" on anime_jobs.job_boards
  for select using (owner_user_id is null or owner_user_id = auth.uid());
create policy "job_boards_insert" on anime_jobs.job_boards
  for insert with check (owner_user_id = auth.uid());
create policy "job_boards_update" on anime_jobs.job_boards
  for update using (owner_user_id = auth.uid());
create policy "job_boards_delete" on anime_jobs.job_boards
  for delete using (owner_user_id = auth.uid());

create policy "user_sites_owner" on anime_jobs.user_sites
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "settings_owner" on anime_jobs.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "unlock_sessions_owner" on anime_jobs.unlock_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "job_postings_owner" on anime_jobs.job_postings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "applications_owner" on anime_jobs.applications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
