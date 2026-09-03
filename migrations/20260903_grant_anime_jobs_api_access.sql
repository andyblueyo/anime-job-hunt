-- Grant the Supabase API role access to the anime_jobs schema.
--
-- Creating a schema by hand grants nothing to PostgREST's roles -- Supabase
-- only wires up default privileges for `public`. So every request through the
-- REST API currently fails with:
--
--   {"code":"42501","message":"permission denied for schema anime_jobs"}
--
-- even though the schema is correctly exposed (PostgREST reports "the following
-- schemas are exposed: public, anime_jobs"). This migration closes that gap.
--
-- Only `authenticated` is granted, not `anon`. Nothing in this app reads
-- anime_jobs anonymously: the website signs in as a real user and the extension
-- will too. Supabase's own `public` schema grants both roles; we don't need to,
-- and leaving `anon` out means an unauthenticated caller can't even reach the
-- tables to be turned away by RLS.
--
-- Row Level Security remains the thing that gates rows. Every policy in
-- 20260903_create_anime_jobs_tables.sql keys on auth.uid(), so these
-- table-level privileges only ever let a signed-in user reach their own rows.
--
-- Touches only the anime_jobs schema. Safe to re-run.

grant usage on schema anime_jobs to authenticated;

grant select, insert, update, delete
  on all tables in schema anime_jobs
  to authenticated;

-- Tables added by later migrations pick this up automatically, provided they're
-- created by the same role that runs this statement (i.e. the SQL editor /
-- migration role, not a different owner).
alter default privileges in schema anime_jobs
  grant select, insert, update, delete on tables to authenticated;

-- No table in anime_jobs uses a sequence today (every PK is a uuid), but this
-- keeps a future bigserial column from failing inserts in a confusing way.
alter default privileges in schema anime_jobs
  grant usage, select on sequences to authenticated;
