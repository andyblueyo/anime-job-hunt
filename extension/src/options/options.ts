import { sendToBackground } from "../lib/messages";
import { WEB_APP_ORIGIN } from "../lib/env";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in options.html`);
  return el as T;
}

const tokenInput = $<HTMLInputElement>("token-input");
const saveButton = $<HTMLButtonElement>("save-button");
const status = $<HTMLParagraphElement>("status");
const configDetails = $<HTMLDListElement>("config-details");
const configSnooze = $<HTMLElement>("config-snooze");
const configThreshold = $<HTMLElement>("config-threshold");
const configCap = $<HTMLElement>("config-cap");
const webAppOriginLabel = $<HTMLElement>("web-app-origin");

webAppOriginLabel.textContent = WEB_APP_ORIGIN;

function renderTokenStatus(result: {
  hasToken: boolean;
  valid: boolean | null;
  config: { snooze_minutes: number; near_end_threshold_seconds: number; tab_cap_per_hour: number } | null;
  error: string | null;
}): void {
  if (!result.hasToken) {
    status.dataset.state = "";
    status.textContent = "No token saved yet.";
    configDetails.hidden = true;
    return;
  }

  if (result.valid) {
    status.dataset.state = "ok";
    status.textContent = "Connected — token works.";
    if (result.config) {
      configSnooze.textContent = `${result.config.snooze_minutes} min`;
      configThreshold.textContent = `${result.config.near_end_threshold_seconds}s remaining`;
      configCap.textContent = `${result.config.tab_cap_per_hour} trigger(s)/hour`;
      configDetails.hidden = false;
    }
  } else {
    status.dataset.state = "error";
    status.textContent = result.error ?? "Token saved, but the site rejected it.";
    configDetails.hidden = true;
  }
}

async function loadCurrentStatus(): Promise<void> {
  const result = await sendToBackground({ type: "CHECK_TOKEN" });
  renderTokenStatus(result);
}

saveButton.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    status.dataset.state = "error";
    status.textContent = "Paste a token first.";
    return;
  }

  saveButton.disabled = true;
  status.dataset.state = "";
  status.textContent = "Checking…";
  try {
    const result = await sendToBackground({ type: "SAVE_TOKEN", token });
    renderTokenStatus(result);
    if (result.valid) tokenInput.value = "";
  } finally {
    saveButton.disabled = false;
  }
});

void loadCurrentStatus();
