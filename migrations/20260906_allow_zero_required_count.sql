-- required_count is now capped at what was actually claimable when the
-- session was created: min(settings.episode_required_count [+ isekai bonus],
-- postings with status = 'new'). With an empty queue that's 0, and the session
-- is inserted already `completed` so the episode is still logged (the
-- episodes-vs-applications stat stays honest) without opening an unwinnable
-- lock. The original inline CHECK (required_count > 0) forbids that row.
--
-- The inline constraint was unnamed in the create-tables migration, so
-- Postgres named it itself (unlock_sessions_required_count_check). Rather than
-- trust that name, find any CHECK on this table that mentions required_count
-- and drop it, then add a named replacement. Safe to re-run.

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'anime_jobs'
      and rel.relname = 'unlock_sessions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%required_count%'
  loop
    execute format('alter table anime_jobs.unlock_sessions drop constraint %I', c.conname);
  end loop;
end $$;

alter table anime_jobs.unlock_sessions
  add constraint unlock_sessions_required_count_nonnegative
  check (required_count >= 0);

comment on column anime_jobs.unlock_sessions.required_count is
  'Applications this episode demands. Snapshot at creation: min(settings.episode_required_count + isekai bonus, postings claimable right then). 0 = nothing was claimable; such sessions are created already completed. Never re-read from settings or recomputed for an open lock.';
