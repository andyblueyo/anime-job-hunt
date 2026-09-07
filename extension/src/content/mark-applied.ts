// Injected via chrome.scripting.executeScript (not a static content_scripts
// entry — see the Phase 2 plan's manifest.json section for why) into a tab
// the background script opened as part of an unlock session. Renders the
// capture ribbon: a full-width bar pinned to the top of the viewport asking
// "Did you apply to this?" with Mark applied / Skip, then a confirmation with
// Undo.
//
// Why a top ribbon and not the Phase 2 corner pill: bottom-right is where
// every chat widget and cookie banner lives, and in live use the pill went
// unnoticed. The ribbon sits in the reading path. It overlays the page rather
// than pushing it down — pushing breaks on any site with its own fixed
// header (both end up stuck under each other), and these are pass-through
// tabs, not pages you live in.
//
// Undo timing is owned by the background script (UNDO_WINDOW_MS): the
// decision is sent immediately and held there, so closing this tab right
// after clicking — which is what people do — doesn't lose it.

import { sendToBackground } from "../lib/messages";
import type { ContentBroadcast, Decision, SessionState, TrackedPostingInfo } from "../lib/messages";

/** Mirrors the background's window; only used to hide Undo if the commit
 *  broadcast never reaches this tab (e.g. it was mid-navigation). */
const UNDO_WINDOW_MS = 5000;

type RibbonState = "default" | "applied" | "skipped" | "busy" | "error";

async function init(): Promise<void> {
  const { posting: tracked } = await sendToBackground({ type: "GET_MY_JOB_POSTING_ID" });
  if (!tracked) return; // not a tab this extension is tracking
  const posting: TrackedPostingInfo = tracked; // narrowed const, safe to close over

  const host = document.createElement("div");
  host.id = "next-ep-lock-ribbon-host";
  host.style.cssText =
    "all: initial; position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .ribbon {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 20px;
        color: white;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 14px;
        line-height: 1.3;
        background-image: linear-gradient(90deg, oklch(0.66 0.24 354), oklch(0.58 0.21 288));
        box-shadow: 0 6px 24px oklch(0.2 0.08 300 / 0.45);
        transition: background-image 200ms;
      }
      .ribbon[data-state="applied"] {
        background-image: linear-gradient(90deg, oklch(0.62 0.15 190), oklch(0.55 0.14 225));
      }
      .ribbon[data-state="skipped"] {
        background-image: linear-gradient(90deg, oklch(0.42 0.04 300), oklch(0.36 0.04 285));
      }
      .ribbon[data-state="error"] {
        background-image: linear-gradient(90deg, oklch(0.55 0.2 25), oklch(0.48 0.18 10));
      }
      .icon {
        flex: none;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: oklch(1 0 0 / 0.18);
        font-family: "Courier New", monospace;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .text { flex: 1; min-width: 0; }
      .prompt { font-weight: 700; font-size: 15px; }
      .context {
        margin-top: 2px;
        font-size: 12px;
        color: oklch(1 0 0 / 0.85);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .actions { flex: none; display: flex; gap: 8px; }
      button {
        font-family: inherit;
        font-size: 13px;
        font-weight: 700;
        border-radius: 999px;
        padding: 9px 18px;
        cursor: pointer;
        border: 1px solid transparent;
        transition: filter 120ms, background 120ms;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      .solid { background: white; color: oklch(0.35 0.16 320); border-color: white; }
      .solid:not(:disabled):hover { filter: brightness(0.94); }
      .outline { background: transparent; color: white; border-color: oklch(1 0 0 / 0.6); }
      .outline:not(:disabled):hover { background: oklch(1 0 0 / 0.12); }
      [hidden] { display: none !important; }
    </style>
    <div class="ribbon" data-state="default" role="region" aria-label="Next Ep. Lock">
      <div class="icon" aria-hidden="true">EP</div>
      <div class="text">
        <div class="prompt" id="prompt"></div>
        <div class="context" id="context"></div>
      </div>
      <div class="actions">
        <button class="solid" id="apply" type="button">Mark applied</button>
        <button class="outline" id="skip" type="button">Skip</button>
        <button class="outline" id="undo" type="button" hidden>Undo</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const ribbon = shadow.querySelector(".ribbon") as HTMLDivElement;
  const promptEl = shadow.getElementById("prompt") as HTMLDivElement;
  const contextEl = shadow.getElementById("context") as HTMLDivElement;
  const applyBtn = shadow.getElementById("apply") as HTMLButtonElement;
  const skipBtn = shadow.getElementById("skip") as HTMLButtonElement;
  const undoBtn = shadow.getElementById("undo") as HTMLButtonElement;

  const { jobPostingId } = posting;
  const postingName = [posting.company, posting.title].filter(Boolean).join(" · ");
  let undoHideTimer: ReturnType<typeof setTimeout> | null = null;

  function sessionLine(session: SessionState | null): string {
    if (!session) return "";
    const remaining = Math.max(session.required_count - session.applied_count, 0);
    if (remaining === 0) return "Episode unlocked.";
    return `${remaining} more to unlock this episode.`;
  }

  function render(state: RibbonState, session: SessionState | null, error?: string): void {
    ribbon.dataset.state = state;
    const showActions = state === "default" || state === "busy" || state === "error";
    applyBtn.hidden = !showActions;
    skipBtn.hidden = !showActions;
    applyBtn.disabled = state === "busy";
    skipBtn.disabled = state === "busy";
    undoBtn.hidden = showActions;

    switch (state) {
      case "default":
      case "busy":
        promptEl.textContent = "Did you apply to this?";
        contextEl.textContent = `${postingName} — ${posting.position} of ${posting.total} this episode`;
        break;
      case "applied":
        promptEl.textContent = session
          ? `Logged — ${Math.min(session.applied_count, session.required_count)} of ${session.required_count} done`
          : "Logged";
        contextEl.textContent = [postingName, sessionLine(session)].filter(Boolean).join(" · ");
        break;
      case "skipped":
        promptEl.textContent = "Skipped — back in your queue";
        contextEl.textContent = [postingName, sessionLine(session)].filter(Boolean).join(" · ");
        break;
      case "error":
        promptEl.textContent = `Couldn't save: ${error ?? "unknown error"}`;
        contextEl.textContent = `${postingName} — try again`;
        break;
    }
  }

  /** Undo is only meaningful inside the background's window; hide it after. */
  function showUndoFor(ms: number): void {
    if (undoHideTimer) clearTimeout(undoHideTimer);
    undoBtn.hidden = false;
    undoHideTimer = setTimeout(() => {
      undoBtn.hidden = true;
    }, ms);
  }

  async function decide(decision: Decision): Promise<void> {
    render("busy", null);
    const result = await sendToBackground(
      decision === "applied"
        ? { type: "MARK_APPLIED", jobPostingId }
        : { type: "SKIP_POSTING", jobPostingId },
    );
    if (!result.ok) {
      render("error", null, result.error);
      return;
    }
    render(decision, result.session);
    showUndoFor(UNDO_WINDOW_MS);
  }

  applyBtn.addEventListener("click", () => void decide("applied"));
  skipBtn.addEventListener("click", () => void decide("skipped"));
  undoBtn.addEventListener("click", async () => {
    undoBtn.disabled = true;
    await sendToBackground({ type: "UNDO_DECISION", jobPostingId });
    undoBtn.disabled = false;
    if (undoHideTimer) clearTimeout(undoHideTimer);
    render("default", null);
  });

  // The background reports the eventual API result once the undo window
  // closes. Success just retires Undo; failure reopens the buttons.
  chrome.runtime.onMessage.addListener((message: ContentBroadcast) => {
    if (message.type !== "DECISION_COMMITTED" || message.jobPostingId !== jobPostingId) return;
    if (undoHideTimer) clearTimeout(undoHideTimer);
    if (message.ok) {
      render(message.decision, message.session);
      undoBtn.hidden = true;
    } else {
      render("error", null, message.error);
    }
  });

  // A reloaded tab picks up where it left off.
  if (posting.decision) {
    render(posting.decision, null);
    if (posting.undoAvailable) showUndoFor(UNDO_WINDOW_MS);
    else undoBtn.hidden = true;
  } else {
    render("default", null);
  }
}

void init();
