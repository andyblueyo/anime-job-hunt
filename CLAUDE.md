# Next Ep. Lock — anime-job-hunt

A browser extension that locks your screen at the end of an anime episode until you apply to a set number of jobs (5, or 10 if the show is an isekai). A companion website tracks postings and applications and feeds the extension its next batch. Built originally for one person's product-manager job search; scoped to work for other users too.

## Hard rules — read this first

- **Read-only repo access. Never `git commit`, `git add`, or `git push`, under any circumstance, even if a task seems to call for it.** The human pushes every change themselves. If work is done, leave it unstaged/uncommitted in the working tree and say what changed — do not stage or commit it "to be helpful."
- **Work one phase at a time** (see "Build phases" below). Finish the phase you're asked for, summarize what changed and what's left, and stop. Do not jump ahead into a later phase's work without being asked, even if it seems like the natural next step.
- **Never touch the `public` schema** in the Supabase project. It belongs to an unrelated app ("friend-events") sharing this Supabase project. This app's tables all live in the `anime_jobs` schema — stay inside it.
- **Never commit secrets.** Supabase URL + anon key go in `.env.local` (already gitignored) — ask the human for them rather than guessing or hardcoding. The Supabase `service_role` key must never be used client-side or in the extension; it doesn't belong in this repo at all.

## Current status

- **Database**: live. All 6 tables exist in the `anime_jobs` schema of the Supabase project this app uses (a schema shared with one other, unrelated app — see rule above), with Row Level Security enabled on every table. Migration: `migrations/20260903_create_anime_jobs_tables.sql`. Schema is multi-tenant (`user_id` throughout) even though phase 1 usage is single-user, since Supabase auth/RLS made that essentially free.
- **Design**: mockups exist for the lock screen (locked/snoozed/unlocked states) and the core website screens (dashboard, postings queue, job boards, settings, extension popup). Match this visual system rather than inventing a new one — see "Design reference" below.
- **Website (phase 1)**: ✅ done and verified end-to-end against the live database. `web/` — Next.js (App Router), TypeScript, Tailwind, `@supabase/supabase-js`. `web/lib/supabase/server.ts` signs in as one seeded Supabase auth user (credentials from `.env.local`) and caches the session, since RLS keys every policy on `auth.uid()` — an anonymous client returns zero rows, so "single-user, no auth" still needs a real signed-in session under the hood. `app/queue/page.tsx` (status filter tabs, manual-add form, mark-applied/queue/reopen actions) and `app/page.tsx` (dashboard: stat tiles, live lock-status bar, recent applications) exist; both `force-dynamic`. `app/globals.css` carries the design system as reusable classes (`.card`, `.pill-*`, `.badge`, `.eyebrow`, `.field`). Verified with real Supabase credentials in `web/.env.local`: manually added a posting through the UI (real `job_postings` row), marked it applied (real `applications` row, status flipped to `applied`), and confirmed the dashboard/queue pages render live data with no console errors.
- **Website API + extension (phase 2)**: built, type-checked, and lint-clean; **not yet verified against live Supabase credentials or a real browser session** — no `.env.local` was available in the sandbox this was built in, so the checklist below is the next thing to run. New API routes under `web/app/api/` (`unlock-sessions` POST/GET, `unlock-sessions/:id/snooze` POST, `mark-applied` POST, `extension-config` GET), all gated by a static `EXTENSION_API_TOKEN` bearer check (`web/lib/extension-auth.ts`) rather than real per-user auth — see `extension/README.md` and the Phase 2 plan for why. New migration `migrations/20260903_add_snooze_count.sql` (adds `unlock_sessions.snooze_count`) — **not yet applied**, apply it before testing the snooze routes. New minimal `web/app/settings/page.tsx` just shows the token for copy-paste. `extension/` is a new top-level Manifest V3 WebExtension (esbuild-bundled, `npm run build` → `extension/dist/`, load unpacked) hardcoded to reanime.to: manual "I finished an episode" button (primary trigger) plus an auto-detect bonus against `flixcloud.cc`'s `<video>` element (reanime.to's own player is a cross-origin iframe with no same-origin video — confirmed live; flixcloud.cc is the actual embed host and does expose one, but this path is explicitly fragile, see the README). No Realtime — the lock overlay polls every 5s instead, since the extension's static token can't open a Realtime channel. Verification checklist: `extension/README.md`.
- **Not started**: the scraper.

## Architecture

Three components:

1. **Browser extension** (Manifest V3, works on Chrome + Firefox with minor manifest differences). Detects an anime episode ending — layered strategy: end-card/"next episode" DOM marker (site-configurable selector) → near-end timer (`video.duration - video.currentTime` under a threshold) → native `ended` event → **manual "I finished an episode" button as the universal fallback**, since none of the automatic strategies work when playback is in a cross-origin iframe (likely true of aggregator sites). On trigger: creates an `unlock_sessions` row via the website's API, opens N job-posting tabs (N = 5, or 10 if an AniList genre-tag lookup on the show title says "Isekai"), and shows a full-tab lock overlay — on *every* tab matching the user's registered sites, not just the triggering one — with a progress bar, a quote, and a Snooze button. Progress updates live via a Supabase Realtime subscription on `applications` filtered to the session; the lock releases itself automatically when the count is hit.

2. **Website** (Next.js + Supabase). Auth, connect-extension flow, dashboard, postings queue, job boards management (shared starter catalog + user's own), settings (target roles/locations/excluded companies, lock-behavior tuning), and the API routes the extension calls.

3. **Scraper**. Two source types in `job_boards`: generic job APIs/feeds (Adzuna, RemoteOK, We Work Remotely — avoid scraping LinkedIn/Indeed directly, both block it and it risks the account used to apply through them), and curated boards (80,000 Hours, Tech for Good, AllHands) scraped via `schema.org JobPosting` structured data where present, falling back to a configured CSS-selector map. Every scraped posting is checked against the user's `target_roles` before being stored. Runs on a schedule (Supabase Cron / Edge Function).

## Tech stack

- **Frontend**: Next.js (App Router), TypeScript, Tailwind CSS.
- **Backend/DB**: Supabase (Postgres + Auth + Row Level Security + auto-generated REST API + Realtime + Cron).
- **Extension**: Manifest V3 WebExtension, TypeScript, no framework needed (small surface area — content script, background service worker, popup, options page).
- **Hosting**: Vercel for the website.

## Database schema (`anime_jobs` schema, all live)

- `job_boards` — id, owner_user_id (null = shared starter catalog), name, url, source_type (`structured_data`/`custom_selector`/`api`), scrape_config (jsonb), enabled, last_run_at.
- `user_sites` — id, user_id, domain, detection_strategy (`generic_video`/`manual_only`), title_selector, end_marker_selector, enabled.
- `settings` — user_id (PK), target_roles (text[]), target_locations (text[]), excluded_companies (text[]), tab_cap_per_hour, default_anime_mode, near_end_threshold_seconds, snooze_minutes.
- `unlock_sessions` — id, user_id, required_count, status (`locked`/`snoozed`/`completed`), snooze_until, created_at, completed_at.
- `job_postings` — id, user_id, company, title, url, location, source (`scraped`/`manual`), source_board (FK), session_id (FK, nullable), posted_date, salary_range, status (`new`/`queued`/`applied`/`skipped`/`rejected`), scraped_at.
- `applications` — id, user_id, job_posting_id (FK), applied_at, method (`auto-tab`/`manual`), resume_version, notes, follow_up_date, outcome.

Full column definitions, constraints, and RLS policies are in the migration file — read it before writing queries against these tables rather than re-deriving the shape from this summary.

## Design reference

Published mockup (locked/snoozed/unlocked states + dashboard/queue/job boards/settings/popup): https://claude.ai/code/artifact/348458f4-d438-4d8e-a644-ffbbcc3e9fdd

Visual system to match:
- Dark purple-to-magenta gradient backgrounds (`oklch` colors — deep violet base, magenta-pink and blue-violet accent glows), subtle grain/scanline texture on the lock screen specifically (not needed on every app page — the website should read as usable daily, not as atmospheric as the rare lock-screen interruption).
- Accent colors: hot pink/magenta (`#ff3d94` range) and blue-violet (`#7c5cff` range) as the two primary accents, a cyan/teal for "success"-style states (applied, connected).
- Typography: Arial/Helvetica for body and UI text; "Press Start 2P" (pixel font) sparingly for small tech/HUD-style labels (status badges, section eyebrows, the brand mark) — not for body copy or long text.
- Rounded-corner cards and pill buttons, segmented (not smooth) progress bars.

## Build phases

Work through these **in order, one at a time**, stopping after each for review unless told to continue:

**Prove it for yourself (single-user, one hardcoded anime site):**
1. Next.js app skeleton + Supabase client wiring against the existing `anime_jobs` schema. Postings queue page (list + manual add + mark-applied/skip actions) and a bare-bones dashboard. No auth yet needed if running single-user locally — but don't fight the schema's multi-tenant shape, just operate as the one seeded user.
2. Extension MVP: one hardcoded site, manual "I finished an episode" button as the baseline (attempt the layered auto-detect if the site allows it), calls the website's API, opens tabs, shows the lock screen (overlay, progress bar via Realtime, snooze).
3. Scraper: 1–2 generic job APIs, plus one curated board adapter, running through the role filter into `job_postings`.
4. Polish: dashboard stats, tab-cap/cooldown tuning.

**Productize (multi-user, any site):**
5. Real auth + RLS-backed multi-tenancy end to end, sign-up/login, connect-extension flow, shared vs. private `job_boards`.
6. Generalize the extension: user-entered site input with runtime host permissions, full layered detection, Anime Mode toggle + nudge, isekai bonus via AniList.
7. Package for the Chrome Web Store and Firefox Add-ons.

Phase 1 is done. Phase 2 (extension MVP) is built but not yet verified live — run the checklist in `extension/README.md` (needs real Supabase credentials in `web/.env.local` plus the `snooze_count` migration applied) before moving to phase 3.