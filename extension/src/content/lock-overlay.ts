// Injected on every reanime.to page. Renders the full-tab lock overlay when
// an unlock session is active, polls for progress, and removes itself when
// the session completes. Runs on EVERY reanime.to tab (not just the one that
// triggered), which is what closes the "just open a new tab" loophole — a
// freshly loaded tab asks GET_STATUS on init and locks itself immediately if
// a session is already active.

import { sendToBackground } from "../lib/messages";
import type { ContentBroadcast, SessionState } from "../lib/messages";

const POLL_INTERVAL_MS = 5000;
const QUOTE_ROTATE_MS = 15000;

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let quoteTimer: ReturnType<typeof setInterval> | null = null;
let currentSession: SessionState | null = null;

function ensureOverlay(): ShadowRoot {
  if (shadow) return shadow;
  host = document.createElement("div");
  host.id = "next-ep-lock-overlay-host";
  // Sits above literally anything the page can do with z-index; shadow DOM
  // keeps the page's CSS from leaking in (or ours leaking out).
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
  shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .overlay {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 22px;
        padding: 60px 40px;
        text-align: center;
        background:
          radial-gradient(80ch 60ch at 15% -10%, oklch(0.42 0.19 330 / 0.55), transparent 70%),
          radial-gradient(70ch 55ch at 90% 10%, oklch(0.38 0.2 285 / 0.5), transparent 70%),
          oklch(0.08 0.03 300 / 0.97);
        color: oklch(0.96 0.015 300);
        font-family: Arial, Helvetica, sans-serif;
      }
      .eyebrow {
        font-family: "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: oklch(0.78 0.18 340);
        text-shadow: 0 0 16px oklch(0.68 0.22 340 / 0.6);
      }
      .message {
        font-weight: 700;
        font-size: clamp(24px, 4vw, 42px);
        line-height: 1.3;
        max-width: 46rem;
      }
      .message .accent {
        color: oklch(0.72 0.2 340);
      }
      .bar {
        display: flex;
        gap: 10px;
        width: min(90vw, 420px);
      }
      .bar span {
        height: 14px;
        flex: 1;
        border-radius: 4px;
        background: oklch(0.32 0.03 280 / 0.7);
      }
      .bar span[data-filled="true"] {
        background-image: linear-gradient(135deg, oklch(0.66 0.24 354), oklch(0.58 0.21 288));
        box-shadow: 0 0 12px oklch(0.66 0.24 354 / 0.6);
      }
      .quote {
        max-width: 34rem;
        font-size: 15px;
        color: oklch(0.85 0.03 300);
        font-style: italic;
      }
      .quote .author {
        display: block;
        margin-top: 6px;
        font-size: 12px;
        font-style: normal;
        color: oklch(0.6 0.03 300);
      }
      .snooze {
        border: 1px solid oklch(1 0 0 / 0.16);
        background: oklch(1 0 0 / 0.08);
        color: oklch(0.96 0.015 300);
        border-radius: 999px;
        padding: 10px 22px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .snooze:hover { background: oklch(1 0 0 / 0.14); }
      .snooze:disabled { opacity: 0.5; cursor: not-allowed; }
      .footer {
        font-family: "Courier New", monospace;
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: oklch(0.5 0.03 300);
      }
    </style>
    <div class="overlay">
      <p class="eyebrow" id="nel-eyebrow">EPISODE COMPLETE</p>
      <p class="message" id="nel-message"></p>
      <div class="bar" id="nel-bar"></div>
      <p class="quote" id="nel-quote">Loading a quote…</p>
      <button class="snooze" id="nel-snooze" type="button">Snooze</button>
      <p class="footer" id="nel-footer"></p>
    </div>
  `;
  document.documentElement.appendChild(host);

  shadow.getElementById("nel-snooze")?.addEventListener("click", handleSnoozeClick);

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

function renderSession(session: SessionState): void {
  currentSession = session;
  const root = ensureOverlay();

  const message = root.getElementById("nel-message");
  if (message) {
    const remaining = Math.max(session.required_count - session.applied_count, 0);
    message.innerHTML =
      session.status === "snoozed"
        ? `Snoozed. You still need to apply to <span class="accent">${remaining} more</span> job${remaining === 1 ? "" : "s"} before this clears.`
        : `You need to apply to <span class="accent">${session.applied_count}/${session.required_count}</span> jobs before watching another episode.`;
  }

  const bar = root.getElementById("nel-bar");
  if (bar) {
    bar.innerHTML = "";
    const total = Math.max(session.required_count, 1);
    for (let i = 0; i < total; i++) {
      const seg = document.createElement("span");
      seg.dataset.filled = String(i < session.applied_count);
      bar.appendChild(seg);
    }
  }

  const footer = root.getElementById("nel-footer");
  if (footer) {
    footer.textContent =
      session.snooze_count > 0 ? `SNOOZED ${session.snooze_count}x THIS SESSION` : "";
  }

  const snoozeButton = root.getElementById("nel-snooze") as HTMLButtonElement | null;
  if (snoozeButton) {
    snoozeButton.disabled = session.status === "snoozed";
    snoozeButton.textContent = session.status === "snoozed" ? "Already snoozed" : "Snooze";
  }

  startPolling(session.id);
  startQuoteRotation();
}

async function handleSnoozeClick(): Promise<void> {
  if (!currentSession) return;
  const result = await sendToBackground({ type: "SNOOZE_SESSION", sessionId: currentSession.id });
  if (result.ok) {
    removeOverlay(); // instant feedback — the alarm re-shows it when snooze_until passes
  }
}

async function refreshQuote(): Promise<void> {
  if (!shadow) return;
  const { quote, author } = await sendToBackground({ type: "GET_QUOTE" });
  const quoteEl = shadow.getElementById("nel-quote");
  if (!quoteEl) return;
  quoteEl.textContent = quote;
  if (author) {
    const authorEl = document.createElement("span");
    authorEl.className = "author";
    authorEl.textContent = `— ${author}`;
    quoteEl.appendChild(authorEl);
  }
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
    if (currentSession) renderSession(message.session);
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
