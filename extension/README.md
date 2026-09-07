# Next Ep. Lock — extension (Phase 2 MVP)

Manifest V3 WebExtension, hardcoded to `reanime.to` for this phase (see the
repo root `CLAUDE.md` and the Phase 2 plan for the full picture — this file
covers just this folder).

## What's here

```
src/
  background.ts           service worker — the only place that holds the API
                           token and calls fetch() against the website
  popup/                  manual "I finished an episode" button + auto-detect toggle
  options/                paste the API token from the website's /settings page
  content/
    lock-overlay.ts       injected on reanime.to — the full-tab lock screen
    flixcloud-detect.ts   injected on flixcloud.cc — the auto-detect bonus
    mark-applied.ts       injected on demand into opened job-posting tabs —
                           the top capture ribbon (Mark applied / Skip / Undo)
  lib/
    messages.ts           typed chrome.runtime message contracts
    api-client.ts          fetch wrapper for web/app/api/*
    storage.ts             chrome.storage.local wrapper
    quotes.ts               AnimeChan + local-fallback quotes
    env.ts / globals.d.ts   WEB_APP_ORIGIN, injected at build time
```

Everything talks to the background script via `chrome.runtime.sendMessage` —
content scripts and the popup/options pages never call the API or touch
storage directly. See `messages.ts`'s header comment for why (short version:
background is exempt from the CORS content scripts inherit from the page).

## Build & load

```
cd extension
npm install
npm run build          # -> dist/
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `extension/dist/`.

By default it's built against `http://localhost:3000` (the Next.js dev
server). To point at a deployed URL instead, copy `.env.example` to `.env`,
set `WEB_APP_ORIGIN`, and rebuild — this is baked in at build time (into
`host_permissions` and the bundled code), not configurable from the options
page. `npm run watch` rebuilds on file changes; reload the extension in
`chrome://extensions` after each rebuild to pick up background/content
script changes (the popup/options pages just need to be reopened).

## Connecting it to your account

1. Run the website (`cd ../web && npm run dev`), with `EXTENSION_API_TOKEN`
   set in `web/.env.local`.
2. Visit `http://localhost:3000/settings`, copy the token.
3. Right-click the extension icon → **Options** → paste it → **Save & test**.

## Known rough edges (deliberate, see the Phase 2 plan)

- **`https://*/*` in `host_permissions`.** Needed so `chrome.scripting.executeScript`
  can inject the "Mark Applied" button into whatever arbitrary company
  career-site domain a job posting happens to link to — those domains aren't
  known in advance. This is real over-scoping for a Chrome Web Store listing;
  fine for unpacked/dev-mode use. Narrow this before any public submission
  (Phase 7).
- **flixcloud.cc auto-detect is fragile.** reanime.to's player is a
  cross-origin iframe into `flixcloud.cc`; that embed host happens to expose
  a real `<video>` element, which `flixcloud-detect.ts` uses for a near-end
  timer + `ended` event. reanime.to could switch embed providers at any time
  and this would just silently stop firing — verify it's actually working
  before relying on it, and it's not the primary path regardless: the
  "I finished an episode" button in the popup always works and is what the
  product depends on.
- **No Realtime.** The lock overlay polls `GET /api/unlock-sessions/:id`
  every 5s instead of subscribing to Supabase Realtime — the extension's
  static bearer token isn't a real Supabase session, so it can't open a
  Realtime channel this phase. See the Phase 2 plan for the reasoning.

## Application capture (Phase 4)

Each opened job tab gets a full-width **ribbon** pinned to the top of the
viewport (it overlays the page rather than pushing it down — pushing breaks
on sites with their own fixed header). It names the posting and its position
in the batch, and offers **Mark applied** / **Skip**. Skip returns the posting
to `status = 'new'` with `session_id` cleared so a later episode can hand it
out again.

Both decisions are **deferred 5s with Undo**. The timer lives in the
background script, not the tab — closing the tab right after clicking (which
is what people do) still commits the decision. Pending decisions are also
persisted so a service-worker restart re-arms them.

Closing a tracked tab **without deciding**, after it's been open at least
`settings.close_prompt_min_seconds` (default 90), queues a "You closed N
tabs" card on the lock overlay with **I applied** / **I didn't** per posting.
Tabs closed sooner than that are dropped silently; tabs already answered on
the ribbon never prompt.

If declining leaves the session with fewer outstanding postings than it still
needs, the overlay shows **Open replacements**, which claims fresh postings
via `POST /api/unlock-sessions/:id/replacements` (not counted against
`tab_cap_per_hour`, since it doesn't create a session).

Needs `migrations/20260905_add_close_prompt_settings.sql` applied — every
route that reads `settings` selects the new column, and until it exists
`GET /api/extension-config` answers `{"error":"column settings.close_prompt_min_seconds does not exist"}`.

## Visual system (halftone restyle)

Tokens, keyframes, and the dot-field technique live in `src/lib/theme.ts`
and are shared by the lock overlay (injected into its shadow root) and the
popup (injected into `<head>`). Fonts are bundled from `fonts/` — VCR OSD
Mono for every mono label, Archivo Black for the headline, Archivo for body
and the quote — and referenced through `chrome.runtime.getURL()`, which is
why `manifest.template.json` lists `fonts/*.ttf` under
`web_accessible_resources`. The `@font-face` block goes in the host page's
`<head>`, not the shadow root: Chrome ignores `@font-face` inside a shadow
tree.

VCR OSD Mono is a single weight with no `·`, `—`, `–`, `×`, `≥`, or `@`
glyph. Anything set in it uses `•` as the separator, `-` for dashes, `x` for
"times", and whole-pixel sizes. Its license is free for personal use, which
covers this project as it stands. A public store release (Phase 7) is not
personal use — re-check the license or swap the face before shipping one.

Values with no backend yet (`src/lib/placeholder-data.ts`) render with a
small mono `DEMO` tag via `data-demo`; stub handlers are no-ops that
`console.debug`.

## Manual verification checklist

- [ ] `npm run typecheck` and `npm run build` both succeed
- [ ] Options page: paste an invalid token → shows an error; paste the real
      one → shows "Connected" with the config values from `settings`
- [ ] Popup, on a real reanime.to episode page: "I finished an episode"
      opens the right number of tabs and the lock overlay appears
- [ ] Clicking "Mark Applied" on an opened job tab ticks the bar down on the
      anime tab within one 5s poll
- [ ] Overlay clears itself automatically at required_count/required_count
- [ ] Snooze hides the overlay and it reappears on its own after
      `snooze_minutes`
- [ ] With a lock active, opening a *new* reanime.to tab shows the overlay
      immediately, without a fresh trigger
- [ ] Triggering more than `tab_cap_per_hour` times within an hour re-shows
      the existing lock instead of opening a fresh batch of tabs

### Phase 4 — application capture

- [ ] Ribbon appears at the top of every opened job tab; corner pill is gone
- [ ] Ribbon names the correct posting when several tabs are open at once
- [ ] Mark applied → overlay ticks up within one 5s poll
- [ ] Undo within 5s → no `applications` row is written
- [ ] Skip → posting is back at `status = 'new'` with `session_id` null, and
      appears in a later session's handout
- [ ] Close a tab after 2 minutes with no decision → prompt appears on the
      anime tab
- [ ] Close a tab after 10 seconds → no prompt
- [ ] Close a tab after deciding on the ribbon → no prompt
- [ ] Decline every posting in a session → "Open replacements" appears and
      opens fresh tabs
- [ ] Session still completes normally after replacements are applied to
