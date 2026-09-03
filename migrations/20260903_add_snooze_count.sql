-- Phase 2: track how many times a lock has been snoozed, for the lock
-- screen's "SNOOZED Nx THIS SESSION" footer and the dashboard's later
-- self-accountability stat.
--
-- Additive, backward compatible: existing rows default to 0. Safe to re-run
-- (guarded with `if not exists`).

alter table anime_jobs.unlock_sessions
  add column if not exists snooze_count integer not null default 0;

comment on column anime_jobs.unlock_sessions.snooze_count is
  'How many times this session''s lock has been snoozed. Incremented by POST /api/unlock-sessions/:id/snooze.';
