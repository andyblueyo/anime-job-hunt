# Next Ep. Lock — anime-job-hunt

A browser extension that locks your screen at the end of an anime episode until you apply to a set number of jobs. A companion website tracks postings and applications and feeds the extension its next batch. Built originally for one person's product-manager job search; scoped to work for other users too.

**Last updated:** 2026-09-07

---

## Hard rules — read this first

- **Read-only repo access.** Never `git commit`, `git add`, or `git push`, under any circumstance, even if a task seems to call for it. The human pushes every change themselves. If work is done, leave it unstaged/uncommitted in the working tree and say what changed — do not stage or commit it "to be helpful."
- **Work one phase at a time** (see "Build phases" below). Finish the phase you're asked for, summarize what changed and what's left, and stop. Do not jump ahead into a later phase's work without being asked, even if it seems like the natural next step.
- **Stay in your assigned directory.** Work is currently split between two scoped agents (see "Active workstreams"). If you were scoped to `extension/`, do not modify `web/`, and vice versa. Read across the boundary freely; write only inside it.
- **Never touch the `public` schema** in the Supabase project. It belongs to an unrelated app ("friend-events") sharing this Supabase project. This app's tables all live in the `anime_jobs` schema — stay inside it.
- **Never commit secrets.** Supabase URL + anon key go in `.env.local` (already gitignored) — ask the human for them rather than guessing or hardcoding. The Supabase `service_role` key must never be used client-side or in the extension; it doesn't belong in this repo at all.
- **Report what you verified versus what you inferred.** Do not mark anything resolved in this file or the plan doc that you could not observe directly. "Type-checks clean" is not "works."

---

## Current status

**Database:** live. All 6 tables exist in the `anime_jobs` schema of the Supabase project this app uses (a schema shared with one other, unrelated app — see rule above), with Row Level Security enabled on every table. Migration: `migrations/20260903_create_anime_jobs_tables.sql`. Schema is multi-tenant (`user_id` throughout) even though current usage is single-user, since Supabase auth/RLS made that essentially free.

**Website (Phase 1): ✅ done, live-verified.** `web/` — Next.js (App Router), TypeScript, Tailwind, `@supabase/supabase-js`. `web/lib/supabase/server.ts` signs in as one seeded Supabase auth user (credentials from `.env.local`) and caches the session, since RLS keys every policy on `auth.uid()` — an anonymous client returns zero rows, so "single-user, no auth" still needs a real signed-in session under the hood. `app/queue/page.tsx` (status filter tabs, manual-add form, mark-applied/queue/reopen actions) and `app/page.tsx` (dashboard: stat tiles, live lock-status bar, recent applications) exist; both force-dynamic. `app/globals.css` carries the design system as reusable classes (`.card`, `.pill-*`, `.badge`, `.eyebrow`, `.field`). Verified against real Supabase credentials: manual add writes a real `job_postings` row, mark-applied writes a real `applications` row and flips status, dashboard/queue render live data with no console errors.

**Website API + extension (Phase 2): ✅ live-verified, with one known broken path.** API routes under `web/app/api/` (unlock-sessions POST/GET, `unlock-sessions/:id/snooze` POST, mark-applied POST, extension-config GET/PATCH), all gated by a static `EXTENSION_API_TOKEN` bearer check (`web/lib/extension-auth.ts`) rather than real per-user auth — see `extension/README.md` for why. `web/app/settings/page.tsx` shows the token for copy-paste plus a 1–5 segmented difficulty control for `episode_required_count` (1 Easy Mode → 5 Hired In Time); the extension popup has the same control, reading and writing it through extension-config GET/PATCH and deliberately keeping no persisted copy of its own, so the website stays the source of truth. `extension/` is a top-level Manifest V3 WebExtension (esbuild-bundled, `npm run build` → `extension/dist/`, load unpacked) hardcoded to reanime.to.

Working live: the manual "I finished an episode" trigger, session creation, tab opening with live-search fallback, the lock overlay, snooze, and mark-applied.

> **⚠️ Known broken: auto-detect of episode end.** reanime.to's own player is a cross-origin `<iframe id="video-player">` into `flixcloud.cc` — there is no same-origin `<video>` element on the reanime.to page itself. `flixcloud.cc` does expose a real `<video class="art-video">`, and the near-end timer + `ended` event paths are implemented against it, but **they do not fire in practice.** This is the top-priority fix (see "Active workstreams"). The manual button is the working baseline and must never be removed or degraded, but it is not sufficient on its own: the binge case is the entire point of this tool, and someone four episodes deep will not voluntarily click a button. Auto-detect is the mechanism, not a nice-to-have.

**No Realtime anywhere.** The original plan called for a Supabase Realtime subscription on `applications` for the live progress bar. The extension's static bearer token can't open a Realtime channel (RLS applies to the socket and needs a real Supabase-issued JWT). **What's actually implemented:** the lock-overlay content script polls `GET /api/unlock-sessions/:id` every 5 seconds, and the mark-applied flow pushes an immediate update so the bar doesn't wait a full poll cycle. Real Realtime is a natural upgrade once the extension gets a real per-user session in the productize phase. Do not write code assuming Realtime is present.

**Application capture (ribbon + closed-tab prompt): built, browser-side flow not yet verified live.** Replaces the corner "Mark Applied" pill with a full-width top ribbon (`extension/src/content/mark-applied.ts`: Mark applied / Skip, then Undo) whose decisions the background holds for `UNDO_WINDOW_MS` (5s) before calling the API — timer + pending decisions live in `background.ts`/`chrome.storage`, not the tab, so closing the tab right after clicking still commits. Tracked job tabs closed without a decision after `settings.close_prompt_min_seconds` (default 90) land in a pending list rendered as a "You closed N tabs" card on the lock overlay (`lock-overlay.ts`); the overlay also shows "Open replacements" when applied + outstanding < required. Routes: `POST /api/skip-posting` (posting → `new`, `session_id` null; 409 if already applied) and `POST /api/unlock-sessions/:id/replacements` (claims the shortfall, not rate-limited); `GET /api/unlock-sessions/:id` also returns `outstanding_count`; `GET /api/extension-config` is wrapped in try/catch so a missing column reaches the extension as `{ error }`. API routes were exercised against the live dev server; the browser flow was not. Run the "Phase 4" checklist in `extension/README.md`.

**Add Posting: paste-a-link parser — ✅ built, live-verified 2026-09-07.** The "Add a posting" card on `/queue` (`web/components/add-posting-form.tsx`) is now two steps: paste a URL → "Fetch details" → a review form with company/role/URL/location/salary (and posted date when the page had one) pre-filled and all editable, each parsed field carrying a quiet mono `parsed` tag and a full-strength border. "Type it in by hand" skips straight to a blank form; "Start over" returns to paste. Parsing is the `parsePosting` server action in `web/app/actions.ts` → `web/lib/posting-parser/` (`fetch.ts` hardened fetch: http(s) only, SSRF guard on every redirect hop, 5 redirects / 2 MB / 8 s caps, HTML-only; `extract.ts` pure HTML→fields: JSON-LD → microdata → meta tags → known-host URL slug, first hit wins per field, never guesses; `index.ts` verdicts). It never writes to the DB — saving is still `addPosting`, `source = 'manual'`, `source_board` null. Failures land on the review form with the URL kept and one line saying why (no job data / login wall / timeout / non-HTML). **LinkedIn, Indeed, Glassdoor:** a guest fetch that lacks JobPosting structured data is reported as a login wall rather than parsed from `<title>` — verified live: a LinkedIn job URL 200'd to a Spanish search-listing page whose title would otherwise have become the role. Verified live in a headless browser: Greenhouse (company + role from the `Job Application for X at Y` title pattern, location from og:description — Greenhouse-only rule), Lever (full JSON-LD incl. posted date), LinkedIn (blocked message, blank editable form), Start over, client-side URL validation, manual entry, and a real save from the review screen that landed in the queue as `added by hand` with an edited salary. Not directly observed: that `posted_date` reached the row (the queue row doesn't render it). **Tests:** `cd web && npm test` (vitest, added as the repo's first test runner) — parser against saved fixtures in `web/lib/posting-parser/__fixtures__/` (real Greenhouse + Lever pages saved 2026-09-07, synthetic @graph / microdata / OG-only / empty / login-wall pages), URL validation, SSRF guard, redirect re-checking. No network in tests. Known gap, documented in `fetch.ts`: DNS is checked and then resolved again by fetch(), so a rebinding hostname could slip past — fine single-user, revisit before multi-tenant.

**Queue: Delete button — ✅ built, live-verified 2026-09-07.** Every `/queue` row (all statuses) ends its action group with Delete (`web/components/delete-posting-button.tsx`), a native `<dialog>` confirm styled as a card (`.dialog`, `.pill-danger` in `globals.css`) in front of the `deletePosting` server action in `web/app/actions.ts` — a hard delete of the `job_postings` row; the `applications` row goes by FK cascade, and the dialog says so when there is one. No schema, policy, API, or extension change. Verified live in a headless browser: Cancel leaves the row; deleting a `new` row drops ALL and NEW by one; deleting an `applied` row drops ALL, APPLIED, and the dashboard applied tile by one (cascade observed through the counts, not by reading Supabase directly); a deleted URL re-adds by hand with no unique violation. **Not exercised:** deleting a queued posting during an open lock — no lock was open and there's no way to clear one from the UI (`reset-lock-button.tsx` is still a stub), so that path rests on reading `getSessionProgress`/replacements, not observation. Accepted consequences, by design: deleting an applied posting retroactively lowers applied stats; a completed session never un-completes; mid-lock deletes shrink the outstanding pool and rely on the replacements route.

**Pending migration:** `migrations/20260905_add_close_prompt_settings.sql` (adds `settings.close_prompt_min_seconds`). Until applied, every settings-reading route 500s with `column settings.close_prompt_min_seconds does not exist` (confirmed live). The two earlier migrations — `20260903_add_snooze_count.sql` and `20260903_add_episode_required_count.sql` — are assumed applied, since the routes that read those columns are working live; confirm against the live DB before relying on this.

**Not started:** the scraper, and the real settings page.

---

## Active workstreams

Work is currently split between two scoped agents running in parallel. They touch disjoint directories on purpose.

**1. Auto-detect fix — `extension/` only.** Diagnose and fix episode-end auto-detection on reanime.to. Diagnose before changing code: confirm whether the content script is injected into the `flixcloud.cc` frame at all, whether a `<video>` element exists and when it appears relative to script execution, and what `duration`, `currentTime`, and `readyState` report over the course of real playback. Two likely culprits worth ruling in or out against real observation rather than assuming: a one-time `querySelector` running before ArtPlayer builds the video element (would need a MutationObserver), and HLS reporting `duration` as `NaN`/`Infinity` early so the near-end threshold never fires. Must work during continuous playback including autoplay-next. reanime.to only — generic multi-site detection is a later phase.

**2. Settings + scraper — `web/` only.** Build the real settings page, then the scraper on top of it. See the next two sections.

---

## Settings spec (to build)

Today `/settings` only exposes the extension API token and the difficulty control. It needs real per-user job-search preferences. Four inputs, but they are **not** four filters:

| Field | Behavior |
|---|---|
| Target job titles | **Filter.** Non-matching postings are not stored. |
| Location | **Filter.** Non-matching postings are not stored. |
| Experience level | **Not a filter.** Postings don't carry an experience field — level is encoded in the title. This input should populate title variants (e.g. entry → "Associate PM", "APM"; senior → "Group PM", "Director of Product") so the user isn't typing every variant by hand. It feeds the title matcher. |
| Salary | **Not a filter.** Most curated boards don't publish salary; Adzuna does. Filtering on it would discard most of the pipeline as "unknown." Store as a preference that informs ranking and display. A posting with no salary is kept, never dropped. |

Getting this wrong in the direction of "filter everything" produces an empty queue and looks like a broken scraper. Postings missing optional fields must survive.

Still open, needs a human decision before the role filter can be trusted: the exact PM title variants in and out (Associate PM? Director of Product? Technical PM?), target locations, and excluded companies.

---

## Architecture

Three components:

**Browser extension** (Manifest V3, Chrome + Firefox with minor manifest differences). Detects an anime episode ending — layered strategy: end-card/"next episode" DOM marker (site-configurable selector) → near-end timer (`video.duration - video.currentTime` under a threshold) → native `ended` event → manual "I finished an episode" button as the universal fallback, since none of the automatic strategies work when playback is in a cross-origin iframe (true of reanime.to, and likely of aggregator sites generally). On trigger: creates an `unlock_sessions` row via the website's API, opens N job-posting tabs (N = `settings.episode_required_count`, a user-chosen 1–5, plus `ISEKAI_BONUS_COUNT` (3) if an AniList genre-tag lookup on the show title says "Isekai" — the lookup itself is a later phase; the code path takes an `isekai` boolean that is currently always false), and shows a full-tab lock overlay — on every tab matching the user's registered sites, not just the triggering one — with a progress bar, a quote, and a Snooze button. **Progress updates via 5-second polling, not Realtime** (see Current status). The lock releases itself automatically when the count is hit.

**Website** (Next.js + Supabase). Auth, connect-extension flow, dashboard, postings queue, job boards management (shared starter catalog + user's own), settings, and the API routes the extension calls.

**Scraper.** Two source types in `job_boards`: generic job APIs/feeds (Adzuna, RemoteOK, We Work Remotely — **avoid scraping LinkedIn/Indeed directly**, both block it and it risks the account used to apply through them), and curated boards (80,000 Hours, Tech for Good, AllHands) scraped via schema.org `JobPosting` structured data where present, falling back to a configured CSS-selector map. Every scraped posting is checked against the user's settings before being stored, per the filter/preference split above. Postings filtered out should be logged separately rather than discarded silently, so the filter can be checked for being too strict before it's trusted. Runs on a schedule (Supabase Cron / Edge Function), deduping against existing `url`s and inserting with `status = new`.

---

## Tech stack

- **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS.
- **Backend/DB:** Supabase (Postgres + Auth + Row Level Security + auto-generated REST API + Cron). Realtime is available but deliberately unused — see Current status.
- **Extension:** Manifest V3 WebExtension, TypeScript, no framework (small surface area — content script, background service worker, popup, options page).
- **Hosting:** Vercel for the website.

---

## Database schema (`anime_jobs` schema, all live)

- **`job_boards`** — id, owner_user_id (null = shared starter catalog), name, url, source_type (`structured_data`/`custom_selector`/`api`), scrape_config (jsonb), enabled, last_run_at.
- **`user_sites`** — id, user_id, domain, detection_strategy (`generic_video`/`manual_only`), title_selector, end_marker_selector, enabled.
- **`settings`** — user_id (PK), target_roles (text[]), target_locations (text[]), excluded_companies (text[]), tab_cap_per_hour, default_anime_mode, near_end_threshold_seconds, snooze_minutes, episode_required_count (int, default 5, CHECK 1–5 — how many applications one episode costs), close_prompt_min_seconds (migration pending). Nothing inserts a row automatically; a user with no `settings` row falls back to column defaults via `web/lib/settings.ts`.
- **`unlock_sessions`** — id, user_id, required_count, status (`locked`/`snoozed`/`completed`), snooze_until, snooze_count, created_at, completed_at. `required_count` is a snapshot taken at session creation (`settings.episode_required_count` + any isekai bonus) — never re-read from settings, so changing the setting can't move the goalposts on an open lock.
- **`job_postings`** — id, user_id, company, title, url, location, source (`scraped`/`manual`), source_board (FK), session_id (FK, nullable), posted_date, salary_range, status (`new`/`queued`/`applied`/`skipped`/`rejected`), scraped_at.
- **`applications`** — id, user_id, job_posting_id (FK), applied_at, method (`auto-tab`/`manual`), resume_version, notes, follow_up_date, outcome.

Full column definitions, constraints, and RLS policies are in the migration file — read it before writing queries against these tables rather than re-deriving the shape from this summary.

---

## Design reference

Published mockup (locked/snoozed/unlocked states + dashboard/queue/job boards/settings/popup): https://claude.ai/code/artifact/348458f4-d438-4d8e-a644-ffbbcc3e9fdd

Visual system to match:
- Dark purple-to-magenta gradient backgrounds (oklch colors — deep violet base, magenta-pink and blue-violet accent glows), subtle grain/scanline texture **on the lock screen specifically** (not on every app page — the website should read as usable daily, not as atmospheric as the rare lock-screen interruption).
- Accent colors: hot pink/magenta (`#ff3d94` range) and blue-violet (`#7c5cff` range) as the two primary accents, a cyan/teal for "success"-style states (applied, connected).
- Typography: Arial/Helvetica for body and UI text; "Press Start 2P" (pixel font) sparingly for small tech/HUD-style labels (status badges, section eyebrows, the brand mark) — not for body copy or long text.
- Rounded-corner cards and pill buttons, segmented (not smooth) progress bars.

---

## Build phases

> **Note on numbering:** the application-capture work (ribbon + closed-tab prompt) was built out of order and is referred to as "Phase 4" in `extension/README.md` and its commit history. It is *not* phase 4 of the list below. Treat the list below as authoritative for what comes next; treat "Phase 4 checklist" in the README as a proper noun referring to that specific feature's verification steps.

**Prove it for yourself** (single-user, one hardcoded anime site):

1. ✅ **Website skeleton** — Next.js + Supabase wiring against the existing `anime_jobs` schema, postings queue, bare-bones dashboard. Done, live-verified.
2. ✅ **Extension MVP** — one hardcoded site, manual button baseline, API calls, tab opening, lock screen with progress bar and snooze. Done and live-verified, **except auto-detect, which is broken and is workstream 1.**
3. ⬅️ **Settings page + scraper** — the real settings form (see spec above), then 1–2 generic job APIs plus curated board adapters (AllHands, 80,000 Hours, Tech for Good), running through the role filter into `job_postings`. This is workstream 2 and the next thing to build.
4. **Polish** — dashboard stats, tab-cap/cooldown tuning, "episodes watched vs. applications sent" and "times snoozed" stats.

**Productize** (multi-user, any site) — not started, and not to be started without being asked:

5. **Multi-tenancy** — real auth + RLS end to end, sign-up/login, connect-extension flow, shared vs. private `job_boards`. Also where the extension's auth graduates from the static token to a real per-user Supabase session (which unlocks Realtime for the progress bar).
6. **Generalize the extension** — user-entered site input with runtime host permissions, full layered detection, Anime Mode toggle + nudge banner, isekai bonus via AniList.
7. **Ship it** — package for Chrome Web Store and Firefox Add-ons. Also where the extension's current `https://*/*` host permission (needed for injecting the mark-applied ribbon into arbitrary job-posting domains) needs to be narrowed or justified for store review. Whether to ship publicly at all is still an open question — it carries a privacy policy, support burden, and holding other people's job-application data.