// Injected on flixcloud.cc (all_frames: true) — the cross-origin embed host
// reanime.to actually plays video through (see the Phase 2 plan's research
// finding). This is the "bonus" auto-detect path: near-end timer + native
// `ended` event against flixcloud.cc's real <video class="art-video">
// element. Explicitly fragile — reanime.to could swap embed providers at any
// time and this would just silently stop firing, which is why the manual
// button in the popup stays the primary, guaranteed trigger.

import { sendToBackground } from "../lib/messages";

const VIDEO_POLL_MS = 500;
const VIDEO_POLL_TIMEOUT_MS = 30000;
const STATUS_REFRESH_MS = 10000;
const DEFAULT_THRESHOLD_SECONDS = 10;

let autoDetectEnabled = false;
let nearEndThresholdSeconds = DEFAULT_THRESHOLD_SECONDS;
const attached = new WeakSet<HTMLVideoElement>();

async function refreshConfig(): Promise<void> {
  try {
    const status = await sendToBackground({ type: "GET_STATUS" });
    autoDetectEnabled = status.autoDetectEnabled;
  } catch {
    // Extension context can go away mid-navigation; just keep the last
    // known value rather than throwing.
  }
  try {
    const tokenStatus = await sendToBackground({ type: "CHECK_TOKEN" });
    if (tokenStatus.config) {
      nearEndThresholdSeconds = tokenStatus.config.near_end_threshold_seconds;
    }
  } catch {
    // Fall back to the default threshold.
  }
}

function trigger(): void {
  void sendToBackground({ type: "TRIGGER_EPISODE_END", source: "auto-detect" });
}

function attach(video: HTMLVideoElement): void {
  if (attached.has(video)) return;
  attached.add(video);

  let triggeredForThisSource = false;

  video.addEventListener("loadstart", () => {
    triggeredForThisSource = false;
  });

  video.addEventListener("timeupdate", () => {
    if (!autoDetectEnabled || triggeredForThisSource) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const remaining = video.duration - video.currentTime;
    if (remaining <= nearEndThresholdSeconds) {
      triggeredForThisSource = true;
      trigger();
    }
  });

  video.addEventListener("ended", () => {
    if (!autoDetectEnabled || triggeredForThisSource) return;
    triggeredForThisSource = true;
    trigger();
  });
}

function scanForVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("video");
}

function watchForVideo(): void {
  const existing = scanForVideo();
  if (existing) attach(existing);

  const observer = new MutationObserver(() => {
    const video = scanForVideo();
    if (video) attach(video);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // MutationObserver alone can miss a video swapped in via a player library
  // that reuses the same element without a detectable DOM mutation; a
  // bounded poll is the belt-and-suspenders fallback.
  const start = Date.now();
  const poll = setInterval(() => {
    const video = scanForVideo();
    if (video) attach(video);
    if (Date.now() - start > VIDEO_POLL_TIMEOUT_MS) clearInterval(poll);
  }, VIDEO_POLL_MS);
}

void refreshConfig();
setInterval(refreshConfig, STATUS_REFRESH_MS);
watchForVideo();
