import { sendToBackground } from "../lib/messages";
import type { SessionState } from "../lib/messages";
import { PLACEHOLDER_QUEUE_OPEN_COUNT } from "../lib/placeholder-data";
import { TECHNIQUE_CSS, TOKEN_DECLARATIONS, ensureFontFaces } from "../lib/theme";

// Theme first, before anything paints: this script is parsed at the end of
// <body>, so it runs before first render. Fonts resolve through
// chrome.runtime.getURL() here as well — same code path as the overlay.
document.getElementById("nel-theme")!.textContent = `:root { ${TOKEN_DECLARATIONS} } ${TECHNIQUE_CSS}`;
ensureFontFaces();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in popup.html`);
  return el as T;
}

const tokenWarning = $<HTMLDivElement>("token-warning");
const autoDetectToggle = $<HTMLButtonElement>("auto-detect-toggle");
const lockLabel = $<HTMLDivElement>("lock-label");
const lockTag = $<HTMLDivElement>("lock-tag");
const lockCount = $<HTMLDivElement>("lock-count");
const lockApplied = $<HTMLDivElement>("lock-applied");
const lockTarget = $<HTMLDivElement>("lock-target");
const lockFree = $<HTMLParagraphElement>("lock-free");
const lockFoot = $<HTMLDivElement>("lock-foot");
const snoozeStatus = $<HTMLSpanElement>("snooze-status");
const sessionBar = $<HTMLDivElement>("session-bar");
const snoozeButton = $<HTMLButtonElement>("snooze-button");
const logApplicationButton = $<HTMLButtonElement>("log-application");
const triggerButton = $<HTMLButtonElement>("trigger-button");
const triggerStatus = $<HTMLParagraphElement>("trigger-status");
const openOptions = $<HTMLAnchorElement>("open-options");
const openOptionsFooter = $<HTMLAnchorElement>("open-options-footer");
const episodeSegments = $<HTMLDivElement>("episode-segments");
const episodeLabel = $<HTMLDivElement>("episode-label");
const queueCount = $<HTMLSpanElement>("queue-count");

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

// ---------------------------------------------------------------------------
// Placeholders — see ../lib/placeholder-data.ts
// ---------------------------------------------------------------------------

/**
 * Footer queue count. Takes the count as a parameter with the placeholder as
 * its default, so wiring is: pass the real number, drop the data-demo
 * attribute in popup.html.
 */
function renderQueueCount(open: number = PLACEHOLDER_QUEUE_OPEN_COUNT): void {
  queueCount.textContent = `queue • ${open} open`;
}

/**
 * LOG AN APPLICATION is a visibly inert stub. POST /api/mark-applied needs a
 * job_posting_id and the popup has no posting context, so there is nothing
 * honest for this button to do yet. Deliberately no optimistic UI: the count
 * and slots must not move when it's clicked.
 */
function logApplicationStub(): void {
  console.debug(
    "[next.ep.lock] LOG AN APPLICATION is not wired: mark-applied needs a job_posting_id and the popup has none.",
  );
}

// ---------------------------------------------------------------------------
// Jobs per episode
// ---------------------------------------------------------------------------

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
    episodeLabel.textContent = EPISODE_COUNT_LABELS[count] ?? String(count);
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

// ---------------------------------------------------------------------------
// Active lock
// ---------------------------------------------------------------------------

function renderBar(applied: number, required: number): void {
  sessionBar.innerHTML = "";
  // Slot count follows required_count (1-5 plus any isekai bonus), never a fixed five.
  const total = Math.max(required, 1);
  sessionBar.setAttribute("aria-valuemax", String(total));
  sessionBar.setAttribute("aria-valuenow", String(applied));
  for (let i = 0; i < total; i++) {
    const slot = document.createElement("div");
    slot.className = "nel-slot";
    slot.dataset.on = String(i < applied);
    slot.dataset.cur = String(i === applied && applied < required);
    sessionBar.appendChild(slot);
  }
}

function renderSession(session: SessionState | null): void {
  const active = session !== null && session.status !== "completed";

  lockCount.hidden = !active;
  sessionBar.hidden = !active;
  lockFoot.hidden = !active;
  lockFree.hidden = active;

  if (!active) {
    lockLabel.textContent = "no active lock";
    lockTag.textContent = "unlocked";
    return;
  }

  const snoozed = session.status === "snoozed";
  lockLabel.textContent = snoozed ? "snoozed" : "active lock";
  lockTag.textContent = snoozed ? "snoozed" : "locked";
  lockApplied.textContent = String(session.applied_count);
  lockTarget.textContent = `/ ${session.required_count}`;
  renderBar(session.applied_count, session.required_count);

  snoozeStatus.textContent =
    session.snooze_count > 0 ? `${session.snooze_count}x snoozed` : "";
  snoozeButton.disabled = snoozed;
  snoozeButton.textContent = snoozed ? "snoozed" : "snooze";
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

logApplicationButton.addEventListener("click", logApplicationStub);

triggerButton.addEventListener("click", async () => {
  triggerButton.disabled = true;
  triggerStatus.classList.remove("error");
  triggerStatus.textContent = "Opening tabs…";
  try {
    const result = await sendToBackground({ type: "TRIGGER_EPISODE_END", source: "manual" });
    if (result.ok) {
      const n = result.postings.length;
      triggerStatus.textContent = `Opened ${n} tab${n === 1 ? "" : "s"}. Get applying.`;
      renderSession(result.session);
    } else if (result.rateLimited) {
      triggerStatus.textContent = "At your hourly trigger limit - showing the active lock.";
      if (result.session) renderSession(result.session);
    } else {
      triggerStatus.classList.add("error");
      triggerStatus.textContent = result.error;
    }
  } catch (error) {
    triggerStatus.classList.add("error");
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
  if (!result.ok) {
    triggerStatus.classList.add("error");
    triggerStatus.textContent = result.error;
  }
  await refresh();
});

function openOptionsPage(event: Event): void {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
}
openOptions.addEventListener("click", openOptionsPage);
openOptionsFooter.addEventListener("click", openOptionsPage);

renderQueueCount();
void refresh();
void loadEpisodeCount();
