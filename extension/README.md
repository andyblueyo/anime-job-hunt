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
    mark-applied.ts       injected on demand into opened job-posting tabs
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
