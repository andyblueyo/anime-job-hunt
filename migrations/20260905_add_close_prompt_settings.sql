-- Phase 4 (application capture): how long a job-posting tab has to stay open
-- before closing it without a decision triggers the "did you apply?" prompt
-- on the lock overlay. A tab closed in eleven seconds wasn't an application,
-- and asking anyway trains reflexive dismissal.
--
-- Additive and backward compatible: existing rows default to 90s. Safe to
-- re-run (`if not exists` on the column, duplicate constraint swallowed).
--
-- Read by web/lib/settings.ts `getSettings` — that select list names every
-- column, so this must be applied before deploying code that reads it or
-- every extension-facing route that loads settings 500s.

alter table anime_jobs.settings
  add column if not exists close_prompt_min_seconds integer not null default 90;

do $$
begin
  alter table anime_jobs.settings
    add constraint settings_close_prompt_min_seconds_nonnegative
    check (close_prompt_min_seconds >= 0);
exception
  when duplicate_object then null;
end $$;

comment on column anime_jobs.settings.close_prompt_min_seconds is
  'Minimum seconds a handed-out job tab must be open before closing it undecided prompts "did you apply?" on the lock overlay. 0 = always prompt.';
