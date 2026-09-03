import { sendToBackground } from "../lib/messages";
import type { SessionState } from "../lib/messages";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in popup.html`);
  return el as T;
}

const tokenWarning = $<HTMLDivElement>("token-warning");
const autoDetectToggle = $<HTMLButtonElement>("auto-detect-toggle");
const sessionCard = $<HTMLDivElement>("session-card");
const sessionProgress = $<HTMLParagraphElement>("session-progress");
const sessionBar = $<HTMLDivElement>("session-bar");
const snoozeButton = $<HTMLButtonElement>("snooze-button");
const triggerButton = $<HTMLButtonElement>("trigger-button");
const triggerStatus = $<HTMLParagraphElement>("trigger-status");
const openOptions = $<HTMLAnchorElement>("open-options");
const openOptionsFooter = $<HTMLAnchorElement>("open-options-footer");

function renderBar(applied: number, required: number): void {
  sessionBar.innerHTML = "";
  const total = Math.max(required, 1);
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("span");
    seg.dataset.filled = String(i < applied);
    sessionBar.appendChild(seg);
  }
}

function renderSession(session: SessionState | null): void {
  if (!session || session.status === "completed") {
    sessionCard.hidden = true;
    return;
  }
  sessionCard.hidden = false;
  const label =
    session.status === "snoozed"
      ? `Snoozed — ${session.applied_count}/${session.required_count} applied`
      : `${session.applied_count}/${session.required_count} applied`;
  sessionProgress.textContent = label;
  renderBar(session.applied_count, session.required_count);
  snoozeButton.disabled = session.status === "snoozed";
  snoozeButton.textContent = session.status === "snoozed" ? "Already snoozed" : "Snooze";
}

async function refresh(): Promise<void> {
  const status = await sendToBackground({ type: "GET_STATUS" });
  tokenWarning.hidden = status.hasToken;
  autoDetectToggle.dataset.on = String(status.autoDetectEnabled);
  autoDetectToggle.setAttribute("aria-pressed", String(status.autoDetectEnabled));
  renderSession(status.activeSession);
  triggerButton.disabled = !status.hasToken;
}

autoDetectToggle.addEventListener("click", async () => {
  const next = autoDetectToggle.dataset.on !== "true";
  autoDetectToggle.dataset.on = String(next);
  autoDetectToggle.setAttribute("aria-pressed", String(next));
  await sendToBackground({ type: "SET_AUTO_DETECT_ENABLED", enabled: next });
});

triggerButton.addEventListener("click", async () => {
  triggerButton.disabled = true;
  triggerStatus.textContent = "Opening tabs…";
  try {
    const result = await sendToBackground({ type: "TRIGGER_EPISODE_END", source: "manual" });
    if (result.ok) {
      triggerStatus.textContent = `Opened ${result.postings.length} tab(s). Get applying!`;
      renderSession(result.session);
    } else if (result.rateLimited) {
      triggerStatus.textContent = "Already at your hourly trigger limit — showing the active lock.";
      if (result.session) renderSession(result.session);
    } else {
      triggerStatus.textContent = result.error;
    }
  } catch (error) {
    triggerStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    await refresh();
  }
});

snoozeButton.addEventListener("click", async () => {
  const status = await sendToBackground({ type: "GET_STATUS" });
  if (!status.activeSession) return;
  snoozeButton.disabled = true;
  const result = await sendToBackground({
    type: "SNOOZE_SESSION",
    sessionId: status.activeSession.id,
  });
  if (!result.ok) triggerStatus.textContent = result.error;
  await refresh();
});

function openOptionsPage(event: Event): void {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
}
openOptions.addEventListener("click", openOptionsPage);
openOptionsFooter.addEventListener("click", openOptionsPage);

void refresh();
