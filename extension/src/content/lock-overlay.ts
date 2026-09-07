// Injected on every reanime.to page. Renders the full-tab lock overlay when
// an unlock session is active, polls for progress, and removes itself when
// the session completes. Runs on EVERY reanime.to tab (not just the one that
// triggered), which is what closes the "just open a new tab" loophole — a
// freshly loaded tab asks GET_STATUS on init and locks itself immediately if
// a session is already active.
//
// Phase 4 additions, both rendered inside the overlay because once a job tab
// is closed there's nowhere else to put them:
//   - a "You closed N tabs" card asking about tracked job tabs that were
//     closed without a ribbon decision (after close_prompt_min_seconds);
//   - an "Open replacements" button when the session has fewer postings
//     outstanding than it still needs — the way out of the decline-everything
//     deadlock (see web/app/api/unlock-sessions/[id]/replacements/route.ts).
//
// Visuals: the halftone system in ../lib/theme.ts, rendered inside a shadow
// root so reanime.to's stylesheet can't bleed into the dot fields (and ours
// can't leak out). The one thing that has to live in the light DOM is the
// @font-face block — Chrome ignores @font-face inside a shadow tree.

import { WEB_APP_ORIGIN } from "../lib/env";
import { sendToBackground } from "../lib/messages";
import type { ContentBroadcast, PendingConfirmation, SessionState } from "../lib/messages";
import { PLACEHOLDER_SNOOZE_NOTE } from "../lib/placeholder-data";
import { TECHNIQUE_CSS, TOKEN_DECLARATIONS, ensureFontFaces } from "../lib/theme";

const POLL_INTERVAL_MS = 5000;
const QUOTE_ROTATE_MS = 15000;

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let quoteTimer: ReturnType<typeof setInterval> | null = null;
let currentSession: SessionState | null = null;
let replacementsBusy = false;
/** From GET_CONFIG, for the "SNOOZE 10 MIN" label. Null until loaded or if it failed. */
let snoozeMinutes: number | null = null;

/**
 * Tone-bloom mask for the lock surface: dots pooling along the bottom edge
 * and spilling in from the top-right, clear of the text column on the left.
 * From the export's lock screen, with the centres re-anchored in px off the
 * edges (the export's percentages assumed a ~640px panel; on a full-height
 * viewport they'd put every bloom out of frame). Every stepped alpha stop
 * matters.
 */
const LOCK_TONE_MASK = [
  "radial-gradient(circle 260px at 2% calc(100% + 60px), #000 0 10%, rgba(0,0,0,0.55) 42%, rgba(0,0,0,0.2) 70%, transparent 92%)",
  "radial-gradient(circle 180px at 16% calc(100% + 50px), #000 0 12%, rgba(0,0,0,0.5) 44%, transparent 88%)",
  "radial-gradient(circle 130px at 28% calc(100% + 40px), #000 0 14%, rgba(0,0,0,0.45) 46%, transparent 90%)",
  "radial-gradient(circle 210px at 58% calc(100% + 50px), #000 0 12%, rgba(0,0,0,0.5) 44%, transparent 88%)",
  "radial-gradient(circle 150px at 76% calc(100% + 50px), #000 0 14%, rgba(0,0,0,0.45) 46%, transparent 90%)",
  "radial-gradient(circle 280px at 102% calc(100% + 40px), #000 0 10%, rgba(0,0,0,0.5) 42%, transparent 90%)",
  "radial-gradient(circle 260px at 112% -60px, #000 0 8%, rgba(0,0,0,0.42) 42%, rgba(0,0,0,0.14) 68%, transparent 90%)",
  "radial-gradient(circle 150px at 88% -70px, #000 0 12%, rgba(0,0,0,0.38) 46%, transparent 88%)",
].join(", ");

const OVERLAY_CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }
  button {
    font: inherit;
    cursor: pointer;
    border-radius: 0;
    margin: 0;
  }
  [hidden] { display: none !important; }

  .overlay {
    ${TOKEN_DECLARATIONS}
    position: fixed;
    inset: 0;
    overflow-y: auto;
    background: var(--ink-2);
    color: var(--paper);
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .overlay .nel-tone {
    --nel-mask: ${LOCK_TONE_MASK};
    background-image: radial-gradient(circle, var(--paper) 1.7px, transparent 2.1px);
    filter: blur(0.5px);
    animation-duration: 40s;
  }

  /* Sparkles live on the right and bottom margins, away from the text column. */
  .spark-a { top: 38%; right: 9%; width: clamp(120px, 14vw, 210px); aspect-ratio: 1; transform: rotate(-9deg); animation-duration: 8.5s; animation-delay: 0.4s; }
  .spark-b { top: 5%; right: 24%; width: clamp(70px, 8vw, 116px); aspect-ratio: 1; transform: rotate(7deg) scaleY(1.3); animation-duration: 6.2s; animation-delay: 1.1s; }
  .spark-c { top: 11%; right: 5%; width: clamp(34px, 3.6vw, 54px); aspect-ratio: 1; transform: rotate(-16deg) scaleX(0.8); animation-duration: 4.6s; }
  .spark-d { bottom: 11%; right: 29%; width: clamp(18px, 2vw, 28px); aspect-ratio: 1; transform: rotate(12deg); animation-duration: 3.6s; animation-delay: 1.6s; }
  .spark-e { top: 30%; right: 20%; width: 11px; height: 11px; animation-duration: 5.4s; animation-delay: 2.2s; }
  .spark-f { bottom: 22%; right: 13%; width: 8px; height: 8px; opacity: 0.7; animation-duration: 4.2s; animation-delay: 0.8s; }
  .spark-g { bottom: 4%; left: 3%; width: clamp(30px, 3.2vw, 48px); aspect-ratio: 1; opacity: 0.45; transform: rotate(-6deg); animation-duration: 7.8s; animation-delay: 1.9s; }

  .content {
    position: relative;
    min-height: 100%;
    width: 100%;
    max-width: 1140px;
    margin: 0 auto;
    padding: clamp(28px, 5vh, 64px) clamp(22px, 4.2vw, 66px);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: clamp(14px, 2vw, 26px);
  }

  .mono {
    font-family: var(--font-mono);
    font-synthesis: none;
    font-weight: 400;
    text-transform: uppercase;
  }

  .eyebrow-row { display: flex; align-items: center; gap: 13px; }
  .eyebrow-rule { width: clamp(20px, 2.6vw, 38px); height: 1px; background: var(--spot); }
  .eyebrow { font-size: 12px; letter-spacing: 0.28em; color: var(--paper); }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: clamp(30px, 5vw, 68px);
    line-height: 0.92;
    letter-spacing: -0.035em;
    color: var(--paper);
    max-width: 14ch;
    text-wrap: balance;
  }

  .progress { display: flex; flex-wrap: wrap; align-items: center; gap: clamp(12px, 1.6vw, 22px); }
  .progress .nel-slots { --nel-slot-line: rgba(247, 245, 239, 0.7); --nel-slot-fill: var(--paper); }
  .progress .nel-slot { flex: none; width: clamp(30px, 3.4vw, 54px); height: clamp(9px, 1vw, 13px); }
  .count-line { font-size: 12px; letter-spacing: 0.14em; color: #CFCBC3; }

  .quote {
    max-width: 50ch;
    margin: 0;
    padding-left: 18px;
    border-left: 3px solid var(--spot);
  }
  .quote p {
    margin: 0;
    font-family: var(--font-body);
    font-style: italic;
    font-size: clamp(14px, 1.4vw, 18px);
    line-height: 1.7;
    color: var(--paper-3);
    text-wrap: pretty;
  }
  .quote .author {
    display: block;
    margin-top: 10px;
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--muted-2);
  }

  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px 12px; }
  .btn {
    font-family: var(--font-mono);
    font-synthesis: none;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 12px;
    padding: 13px 22px;
    border: 1px solid rgba(247, 245, 239, 0.4);
    background: transparent;
    color: var(--paper-3);
    transition: border-color 140ms ease, opacity 140ms ease;
  }
  .btn:hover:not(:disabled) { border-color: var(--paper); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn.primary {
    font-size: 14px;
    padding: clamp(13px, 1.4vw, 18px) clamp(18px, 2.2vw, 32px);
    border-color: var(--paper);
    background: var(--paper);
    color: var(--ink-2);
  }
  .btn.primary:hover:not(:disabled) { opacity: 0.86; }
  .btn.spot { border-color: var(--spot); color: var(--paper); }
  .btn.spot:hover:not(:disabled) { background: var(--spot); }
  .btn.small { font-size: 11px; padding: 8px 14px; }
  .note { font-size: 11px; letter-spacing: 0.1em; color: #8A867E; }

  /* Closed-tab prompt: a light panel on the dark field. */
  .card {
    position: relative;
    width: min(100%, 640px);
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    padding: 16px 18px 6px;
  }
  .card .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid rgba(26, 26, 24, 0.28); }
  .card h2 { margin: 0; font-size: 12px; letter-spacing: 0.2em; color: var(--muted); }
  .card .sub { margin: 0; font-size: 13px; color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 0; border-bottom: 1px solid rgba(26, 26, 24, 0.12); }
  .row:last-child { border-bottom: 0; }
  .row .who { flex: 1 1 220px; min-width: 0; }
  .row .company { font-size: 15px; font-weight: 400; color: var(--ink); }
  .row .title { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .open { margin-top: 3px; font-size: 11px; letter-spacing: 0.1em; color: var(--muted-2); }
  .row .choices { flex: none; display: flex; gap: 7px; }
  .row .btn { border-color: var(--line); color: var(--ink); padding: 8px 14px; font-size: 11px; }
  .row .btn:hover:not(:disabled) { background: var(--shell); }
  .row .btn.primary { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .row .btn.primary:hover:not(:disabled) { opacity: 0.84; background: var(--ink); }
  .row .err { flex-basis: 100%; font-size: 12px; color: var(--spot); }
  .row[data-busy="true"] .btn { opacity: 0.5; cursor: wait; }
`;

function ensureOverlay(): ShadowRoot {
  if (shadow) return shadow;
  ensureFontFaces();

  host = document.createElement("div");
  host.id = "next-ep-lock-overlay-host";
  // Sits above literally anything the page can do with z-index; shadow DOM
  // keeps the page's CSS from leaking in (or ours leaking out).
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
  shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${TECHNIQUE_CSS}${OVERLAY_CSS}</style>
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="nel-headline">
      <div class="nel-tone"></div>
      <div class="nel-wash"></div>
      <div class="nel-grain nel-grain-light"></div>
      <div class="nel-sparkle nel-sparkle-5 spark-a"></div>
      <div class="nel-sparkle spark-b"></div>
      <div class="nel-sparkle spark-c"></div>
      <div class="nel-sparkle nel-sparkle-spot spark-d"></div>
      <div class="nel-sparkle spark-e"></div>
      <div class="nel-sparkle spark-f"></div>
      <div class="nel-sparkle spark-g"></div>

      <div class="content">
        <div class="eyebrow-row">
          <div class="eyebrow-rule"></div>
          <div class="mono eyebrow" id="nel-eyebrow">episode complete</div>
        </div>

        <h1 id="nel-headline">Finish applying to keep watching.</h1>

        <div class="progress">
          <div class="nel-slots" id="nel-bar" role="progressbar" aria-valuemin="0"></div>
          <div class="mono count-line" id="nel-count"></div>
        </div>

        <section class="card" id="nel-pending" hidden aria-live="polite">
          <div class="card-head">
            <h2 class="mono" id="nel-pending-title"></h2>
            <p class="sub">Closed without an answer. Did you apply?</p>
          </div>
          <div id="nel-pending-rows"></div>
        </section>

        <blockquote class="quote" id="nel-quote">
          <p id="nel-quote-text">Loading a quote…</p>
          <span class="mono author" id="nel-quote-author"></span>
        </blockquote>

        <div class="actions">
          <button class="btn primary" id="nel-open-queue" type="button">open job queue</button>
          <button class="btn" id="nel-snooze" type="button">snooze</button>
          <button class="btn spot" id="nel-replacements" type="button" hidden>open replacements</button>
          <div class="mono note" id="nel-snooze-count" hidden></div>
          <div class="mono note" id="nel-snooze-note" data-demo></div>
        </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(host);

  shadow.getElementById("nel-snooze")?.addEventListener("click", handleSnoozeClick);
  shadow.getElementById("nel-replacements")?.addEventListener("click", handleReplacementsClick);
  shadow.getElementById("nel-open-queue")?.addEventListener("click", handleOpenQueueClick);

  renderSnoozeNote();
  void loadSnoozeMinutes();

  return shadow;
}

function removeOverlay(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (quoteTimer) clearInterval(quoteTimer);
  pollTimer = null;
  quoteTimer = null;
  host?.remove();
  host = null;
  shadow = null;
  currentSession = null;
}

/**
 * Snooze-cap note beside the button. No daily cap exists yet, so this is the
 * placeholder from ../lib/placeholder-data.ts; pass a real string (and drop
 * the data-demo attribute) once there is one.
 */
function renderSnoozeNote(note: string = PLACEHOLDER_SNOOZE_NOTE): void {
  const el = shadow?.getElementById("nel-snooze-note");
  if (el) el.textContent = note;
}

/** Reads snooze_minutes once so the button can say how long a snooze is. */
async function loadSnoozeMinutes(): Promise<void> {
  try {
    const result = await sendToBackground({ type: "GET_CONFIG" });
    if (result.ok) snoozeMinutes = result.config.snooze_minutes;
  } catch {
    snoozeMinutes = null;
  }
  if (currentSession) renderSnoozeButton(currentSession);
}

function renderSnoozeButton(session: SessionState): void {
  const button = shadow?.getElementById("nel-snooze") as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = session.status === "snoozed";
  if (session.status === "snoozed") {
    button.textContent = "snoozed";
  } else {
    button.textContent = snoozeMinutes ? `snooze ${snoozeMinutes} min` : "snooze";
  }
}

function renderSession(session: SessionState): void {
  currentSession = session;
  const root = ensureOverlay();
  const remaining = Math.max(session.required_count - session.applied_count, 0);

  const eyebrow = root.getElementById("nel-eyebrow");
  if (eyebrow) eyebrow.textContent = session.status === "snoozed" ? "snoozed" : "episode complete";

  const headline = root.getElementById("nel-headline");
  if (headline) {
    headline.textContent =
      session.status === "snoozed"
        ? `Snoozed. ${remaining} more to go.`
        : "Finish applying to keep watching.";
  }

  const bar = root.getElementById("nel-bar");
  if (bar) {
    bar.innerHTML = "";
    // Slot count follows the session's required_count (1-5, plus any isekai
    // bonus) — never a hardcoded five.
    const total = Math.max(session.required_count, 1);
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(session.applied_count));
    for (let i = 0; i < total; i++) {
      const slot = document.createElement("div");
      slot.className = "nel-slot";
      slot.dataset.on = String(i < session.applied_count);
      slot.dataset.cur = String(i === session.applied_count && remaining > 0);
      bar.appendChild(slot);
    }
  }

  const count = root.getElementById("nel-count");
  if (count) {
    count.textContent = `${session.applied_count} of ${session.required_count} application${
      session.required_count === 1 ? "" : "s"
    } logged`;
  }

  const snoozeCount = root.getElementById("nel-snooze-count");
  if (snoozeCount) {
    snoozeCount.hidden = session.snooze_count <= 0;
    snoozeCount.textContent = `${session.snooze_count}x snoozed this session`;
  }

  renderSnoozeButton(session);
  renderReplacementsButton(session);
  void refreshPending();

  startPolling(session.id);
  startQuoteRotation();
}

/**
 * Offered only when nothing still open can finish the lock: every handed-out
 * posting has been applied to or declined and the count is still short. Not
 * automatic on decline — opening tabs right after someone said "no thanks"
 * to a tab is the wrong reflex.
 */
function renderReplacementsButton(session: SessionState): void {
  const button = shadow?.getElementById("nel-replacements") as HTMLButtonElement | null;
  if (!button) return;
  if (session.outstanding_count === undefined) {
    button.hidden = true;
    return;
  }
  const short = session.required_count - session.applied_count - session.outstanding_count;
  button.hidden = short <= 0;
  if (!replacementsBusy) {
    button.disabled = false;
    button.textContent = `open ${short} replacement${short === 1 ? "" : "s"}`;
  }
}

async function handleReplacementsClick(): Promise<void> {
  if (!currentSession || replacementsBusy) return;
  const button = shadow?.getElementById("nel-replacements") as HTMLButtonElement | null;
  replacementsBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = "opening…";
  }
  const result = await sendToBackground({
    type: "REQUEST_REPLACEMENTS",
    sessionId: currentSession.id,
  });
  replacementsBusy = false;
  if (button) {
    button.disabled = false;
    button.textContent = result.ok
      ? `opened ${result.opened} tab${result.opened === 1 ? "" : "s"}`
      : `couldn't open: ${result.error}`;
  }
  // The next poll re-reads outstanding_count and hides the button.
}

async function handleSnoozeClick(): Promise<void> {
  if (!currentSession) return;
  const result = await sendToBackground({ type: "SNOOZE_SESSION", sessionId: currentSession.id });
  if (result.ok) {
    removeOverlay(); // instant feedback — the alarm re-shows it when snooze_until passes
  }
}

/** The website's queue is where applications get logged; open it beside this tab. */
function handleOpenQueueClick(): void {
  window.open(`${WEB_APP_ORIGIN}/queue`, "_blank", "noopener");
}

// ---------------------------------------------------------------------------
// Closed-tab confirmations
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Reads the pending list on the same tick as the session poll — no extra polling. */
async function refreshPending(): Promise<void> {
  if (!shadow) return;
  let pending: PendingConfirmation[];
  try {
    ({ pending } = await sendToBackground({ type: "GET_PENDING_CONFIRMATIONS" }));
  } catch {
    return;
  }
  renderPending(pending);
}

function renderPending(pending: PendingConfirmation[]): void {
  const card = shadow?.getElementById("nel-pending") as HTMLElement | null;
  const rows = shadow?.getElementById("nel-pending-rows");
  const title = shadow?.getElementById("nel-pending-title");
  if (!card || !rows || !title) return;

  if (pending.length === 0) {
    card.hidden = true;
    rows.innerHTML = "";
    return;
  }

  // Don't rebuild rows the user is mid-click on: only redraw when the set of
  // postings actually changed.
  const signature = pending.map((p) => p.jobPostingId).join("|");
  if (!card.hidden && rows.dataset.signature === signature) return;
  rows.dataset.signature = signature;

  card.hidden = false;
  title.textContent = `you closed ${pending.length} tab${pending.length === 1 ? "" : "s"}`;
  rows.innerHTML = "";

  for (const entry of pending) {
    const row = document.createElement("div");
    row.className = "row";

    const who = document.createElement("div");
    who.className = "who";
    const company = document.createElement("div");
    company.className = "company";
    company.textContent = entry.company ?? "Unknown company";
    const jobTitle = document.createElement("div");
    jobTitle.className = "title";
    jobTitle.textContent = entry.title;
    const open = document.createElement("div");
    open.className = "mono open";
    // Showing the duration answers "why am I being asked about this one" and
    // lets the person calibrate their own honesty.
    open.textContent = `open ${formatDuration(entry.secondsOpen)}`;
    who.append(company, jobTitle, open);

    const choices = document.createElement("div");
    choices.className = "choices";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn primary";
    yes.textContent = "i applied";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn";
    no.textContent = "i didn't";
    choices.append(yes, no);

    const err = document.createElement("div");
    err.className = "err";
    err.hidden = true;

    const resolve = async (applied: boolean) => {
      if (row.dataset.busy === "true") return;
      row.dataset.busy = "true";
      err.hidden = true;
      const result = await sendToBackground({
        type: "RESOLVE_PENDING",
        jobPostingId: entry.jobPostingId,
        applied,
      });
      row.dataset.busy = "false";
      if (!result.ok) {
        err.textContent = result.error;
        err.hidden = false;
        // A definitive rejection has already been dropped from the list by
        // the background; the next refresh removes the row. A transient
        // failure leaves it for retry.
        void refreshPending();
        return;
      }
      // Reflect the session change now rather than waiting on the poll
      // (a completed session arrives as LOCK_CLEARED from the background).
      if (result.session && result.session.status !== "completed") {
        renderSession({
          ...result.session,
          snooze_until: currentSession?.snooze_until ?? null,
          snooze_count: currentSession?.snooze_count ?? 0,
        });
      } else {
        void refreshPending();
      }
    };
    yes.addEventListener("click", () => void resolve(true));
    no.addEventListener("click", () => void resolve(false));

    row.append(who, choices, err);
    rows.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Quotes + polling
// ---------------------------------------------------------------------------

/**
 * "Rock Lee, Naruto" -> "rock lee • naruto". The mono face has no middle dot
 * (or dashes), so the bullet is the separator everywhere it's set in VCR. It
 * also has no accented glyphs (AnimeChan sends names like "Ryōsuke"), so
 * diacritics are stripped on this line only — the quote itself is Archivo.
 */
function formatAttribution(author: string): string {
  const plain = author.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const split = plain.lastIndexOf(", ");
  return split === -1 ? plain : `${plain.slice(0, split)} • ${plain.slice(split + 2)}`;
}

async function refreshQuote(): Promise<void> {
  if (!shadow) return;
  const { quote, author } = await sendToBackground({ type: "GET_QUOTE" });
  const text = shadow.getElementById("nel-quote-text");
  const attribution = shadow.getElementById("nel-quote-author");
  if (text) text.textContent = `“${quote}”`;
  if (attribution) attribution.textContent = author ? formatAttribution(author) : "";
}

function startQuoteRotation(): void {
  if (quoteTimer) return;
  void refreshQuote();
  quoteTimer = setInterval(refreshQuote, QUOTE_ROTATE_MS);
}

function startPolling(sessionId: string): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const result = await sendToBackground({ type: "POLL_SESSION", sessionId });
    if (!result.ok) return;
    if (result.session.status === "completed") {
      removeOverlay();
      return;
    }
    // Failsafe for a missed chrome.alarms wake (e.g. the browser was closed
    // through the snooze window): a poll noticing snooze_until has already
    // passed re-locks locally without waiting on the alarm.
    if (
      result.session.status === "snoozed" &&
      result.session.snooze_until &&
      Date.parse(result.session.snooze_until) <= Date.now()
    ) {
      renderSession({ ...result.session, status: "locked" });
      return;
    }
    renderSession(result.session);
  }, POLL_INTERVAL_MS);
}

chrome.runtime.onMessage.addListener((message: ContentBroadcast) => {
  if (message.type === "LOCK_ACTIVE") {
    renderSession(message.session);
  } else if (message.type === "SESSION_UPDATED") {
    if (currentSession) {
      // Decision-route broadcasts carry no snooze fields; keep what we have.
      renderSession({
        ...message.session,
        snooze_until: message.session.snooze_until ?? currentSession.snooze_until,
        snooze_count: message.session.snooze_count || currentSession.snooze_count,
      });
    }
  } else if (message.type === "LOCK_CLEARED") {
    removeOverlay();
  }
});

// On load, check whether a lock is already active — this is what covers a
// freshly opened/navigated reanime.to tab while a session is in progress.
void (async () => {
  const status = await sendToBackground({ type: "GET_STATUS" });
  if (status.activeSession && status.activeSession.status !== "completed") {
    renderSession(status.activeSession);
  }
})();
