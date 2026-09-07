-- Provenance for the extension's Skip (POST /api/skip-posting), which puts a
-- handed-out posting back to status = 'new' with session_id cleared so a
-- later episode can hand it out again.
--
-- Without this, POST /api/unlock-sessions/:id/replacements — which claims the
-- oldest `new` postings first, exactly like session creation — would hand the
-- just-skipped posting straight back (it's back in the pool, and it's older
-- than anything that wasn't claimed). Replacements now prefers postings the
-- session hasn't declined, and only re-offers skipped ones when nothing else
-- is left.
--
-- Semantics: "the most recent session that skipped this posting". Written by
-- the skip route only; not cleared on claim (a stale value pointing at an old
-- session never matches a live one, and is overwritten on the next skip).
-- Sessions are never deleted in-app, but `on delete set null` keeps the
-- posting if one ever is.
--
-- Additive, nullable, no default. Safe to re-run.

alter table anime_jobs.job_postings
  add column if not exists skipped_from_session_id uuid
    references anime_jobs.unlock_sessions(id) on delete set null;

comment on column anime_jobs.job_postings.skipped_from_session_id is
  'Most recent unlock session this posting was skipped from (extension Skip / "I didn''t"). Lets that session''s replacements prefer postings it has not declined. Null = never skipped from a session.';
