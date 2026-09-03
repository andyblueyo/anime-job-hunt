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
const episodeSegments = $<HTMLDivElement>("episode-segments");
const episodeLabel = $<HTMLParagraphElement>("episode-label");

// Duplicated from web/lib/settings.ts rather than imported — the extension
// bundle is standalone and shares no code with the Next.js app. Keep in sync.
const EPISODE_COUNT_LABELS: Record<number, string> = {
  1: "Easy Mode",
  2: "Slice of Life",
  3: "Training Arc",
  4: "Tournament Arc",
  5: "Hired In Time",
};

const segmentButtons = Array.from(
  episodeSegments.querySelectorAll<HTMLButtonElement>("button.segment"),
);

/**
 * The website owns this value, so the popup renders only what the API just
 * told it. `null` means "we don't know" — the segments go disabled and the
 * label carries the error, rather than showing a made-up local default that
 * the user might then think is in effect.
 */
function renderEpisodeCount(count: number | null, error?: string): void {
  for (const button of segmentButtons) {
    const selected = count !== null && Number(button.dataset.count) === count;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = count === null;
  }

  // An error is styled as one whether or not a stale value survived it, so a
  // failed write can't read as a successful one.
  episodeLabel.classList.toggle("error", Boolean(error) || count === null);
  if (error) {
    episodeLabel.textContent = error;
  } else if (count === null) {
    episodeLabel.textContent = "Couldn't load your setting.";
  } else {
    episodeLabel.textContent = `${count} — ${EPISODE_COUNT_LABELS[count] ?? ""}`;
  }
}

async function loadEpisodeCount(): Promise<void> {
  const result = await sendToBackground({ type: "GET_CONFIG" });
  if (result.ok) {
    renderEpisodeCount(result.config.episode_required_count);
  } else {
    renderEpisodeCount(null, result.error);
  }
}

for (const button of segmentButtons) {
  button.addEventListener("click", async () => {
    const count = Number(button.dataset.count);
    const previous = segmentButtons.find((b) => b.getAttribute("aria-pressed") === "true");
    const previousCount = previous ? Number(previous.dataset.count) : null;

    for (const b of segmentButtons) b.disabled = true;
    episodeLabel.classList.remove("error");
    episodeLabel.textContent = "Saving…";

    const result = await sendToBackground({ type: "SET_EPISODE_REQUIRED_COUNT", count });
    if (result.ok) {
      renderEpisodeCount(result.config.episode_required_count);
    } else {
      // Put the old selection back so the UI never implies a write landed.
      renderEpisodeCount(previousCount, result.error);
      for (const b of segmentButtons) b.disabled = false;
    }
  });
}

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
void loadEpisodeCount();
