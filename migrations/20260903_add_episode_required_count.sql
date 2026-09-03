-- Phase 2 follow-up: make the per-episode job count a user setting instead of
-- the literal 5 that POST /api/unlock-sessions used to hardcode. 1 is easy
-- mode, 5 is maximum effort.
--
-- The 1..5 ceiling bounds the *setting*, not the resulting
-- unlock_sessions.required_count: the isekai bonus (ISEKAI_BONUS_COUNT in
-- web/lib/unlock-sessions.ts) is added on top at session-creation time, so a
-- session can legitimately require more than 5.
--
-- Additive and backward compatible: existing rows default to 5, which is
-- exactly what the route hardcoded before this. Safe to re-run.
--
-- Independent of 20260903_add_snooze_count.sql (different table, no shared
-- objects) — the two can be applied in either order, but both are pending.

alter table anime_jobs.settings
  add column if not exists episode_required_count integer not null default 5;

-- `add constraint` has no `if not exists` form, so the re-runnability this
-- file promises above needs the duplicate swallowed explicitly.
do $$
begin
  alter table anime_jobs.settings
    add constraint settings_episode_required_count_range
    check (episode_required_count between 1 and 5);
exception
  when duplicate_object then null;
end $$;

comment on column anime_jobs.settings.episode_required_count is
  'How many applications one episode costs (1 = easy mode, 5 = maximum effort). Snapshotted into unlock_sessions.required_count at session creation, plus the isekai bonus if any.';
