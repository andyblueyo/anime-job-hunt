// Injected via chrome.scripting.executeScript (not a static content_scripts
// entry — see the Phase 2 plan's manifest.json section for why) into a tab
// the background script opened as part of an unlock session. Renders a
// floating "Mark Applied" button; clicking it records the application and
// updates the lock overlay on the anime tab without needing to switch back
// to it.

import { sendToBackground } from "../lib/messages";

async function init(): Promise<void> {
  const { jobPostingId } = await sendToBackground({ type: "GET_MY_JOB_POSTING_ID" });
  if (!jobPostingId) return; // not a tab this extension is tracking

  const host = document.createElement("div");
  host.style.cssText =
    "all: initial; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      button {
        font-family: Arial, Helvetica, sans-serif;
        font-size: 14px;
        font-weight: 700;
        border: none;
        border-radius: 999px;
        padding: 12px 20px;
        cursor: pointer;
        color: white;
        background-image: linear-gradient(135deg, oklch(0.66 0.24 354), oklch(0.58 0.21 288));
        box-shadow: 0 6px 24px oklch(0.66 0.24 354 / 0.4);
      }
      button:disabled { opacity: 0.6; cursor: default; }
      button:not(:disabled):hover { filter: brightness(1.08); }
    </style>
    <button id="mark-applied-btn" type="button">Mark Applied</button>
  `;
  document.documentElement.appendChild(host);

  const button = shadow.getElementById("mark-applied-btn") as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Marking…";
    const result = await sendToBackground({ type: "MARK_APPLIED", jobPostingId });
    if (result.ok) {
      button.textContent = "Applied ✓";
      // Leave it visible rather than yanking it away — a quiet confirmation
      // that persists is more reassuring than a button that vanishes.
    } else {
      button.disabled = false;
      button.textContent = "Mark Applied (retry)";
    }
  });
}

void init();
