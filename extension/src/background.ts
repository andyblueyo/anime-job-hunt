// MV3 service worker. The only place that holds the API token and the only
// place that calls fetch() against the website — see messages.ts's header
// for why. Also owns tab orchestration (opening job-posting tabs, injecting
// the "Mark Applied" button into them) and the snooze re-lock alarm.

import {
  ApiError,
  createUnlockSession,
  getExtensionConfig,
  getUnlockSession,
  markApplied,
  snoozeUnlockSession,
} from "./lib/api-client";
import type {
  BackgroundRequest,
  BackgroundResponseMap,
  ContentBroadcast,
  JobPosting,
  SessionState,
  TokenStatus,
} from "./lib/messages";
import { getQuote } from "./lib/quotes";
import {
  getJobPostingForTab,
  getStored,
  removeTabJobPosting,
  setActiveSessionId,
  setAutoDetectEnabled,
  setTabJobPosting,
  setToken,
} from "./lib/storage";

const REANIME_TAB_QUERY = "https://reanime.to/*";
const SNOOZE_ALARM_PREFIX = "snooze:";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function requireToken(): Promise<string | null> {
  const { apiToken } = await getStored();
  return apiToken;
}

/** Re-fetches a session's full state from the API. Returns null on any error
 *  (not-found, network, expired token) rather than throwing — callers treat
 *  "can't confirm it's active" the same as "no active session". */
async function fetchFreshSessionState(
  token: string,
  sessionId: string,
): Promise<SessionState | null> {
  try {
    return await getUnlockSession(token, sessionId);
  } catch {
    return null;
  }
}

async function broadcastToReanimeTabs(message: ContentBroadcast): Promise<void> {
  const tabs = await chrome.tabs.query({ url: REANIME_TAB_QUERY });
  await Promise.all(
    tabs.map((tab) =>
      tab.id
        ? chrome.tabs.sendMessage(tab.id, message).catch(() => {
            // No content script listening yet (tab still loading) — it
            // self-checks via GET_STATUS on init, so dropping this is fine.
          })
        : Promise.resolve(),
    ),
  );
}

function injectMarkAppliedWhenReady(tabId: number): void {
  const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content/mark-applied.js"] })
      .catch(() => {
        // Some pages refuse injection (chrome://, PDFs, an extension
        // gallery). Nothing to do but leave that tab without the button.
      });
  };
  chrome.tabs.onUpdated.addListener(listener);
}

async function openPostingTabs(postings: JobPosting[]): Promise<void> {
  for (const posting of postings) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: posting.url, active: false });
    } catch {
      continue; // an individual bad URL shouldn't sink the rest of the batch
    }
    if (!posting.isSearchFallback && posting.id && tab.id) {
      await setTabJobPosting(tab.id, posting.id);
      injectMarkAppliedWhenReady(tab.id);
    }
  }
}

function scheduleSnoozeAlarm(sessionId: string, snoozeUntil: string): void {
  chrome.alarms.create(`${SNOOZE_ALARM_PREFIX}${sessionId}`, {
    when: Date.parse(snoozeUntil),
  });
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handleTrigger(): Promise<BackgroundResponseMap["TRIGGER_EPISODE_END"]> {
  const token = await requireToken();
  if (!token) {
    return {
      ok: false,
      error: "No API token configured. Open the extension's options page and paste your token.",
    };
  }

  try {
    const result = await createUnlockSession(token);
    const session: SessionState = {
      id: result.session_id,
      required_count: result.required_count,
      applied_count: 0,
      status: "locked",
      snooze_until: null,
      snooze_count: 0,
    };
    await setActiveSessionId(session.id);
    await openPostingTabs(result.postings);
    await broadcastToReanimeTabs({ type: "LOCK_ACTIVE", session });
    return { ok: true, session, postings: result.postings };
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      const body = error.body as { session?: { id: string } | null } | null;
      const existingId = body?.session?.id ?? null;
      const existing = existingId ? await fetchFreshSessionState(token, existingId) : null;
      if (existing) {
        await setActiveSessionId(existing.id);
        await broadcastToReanimeTabs({ type: "LOCK_ACTIVE", session: existing });
      }
      return { ok: false, error: error.message, rateLimited: true, session: existing };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleGetStatus(): Promise<BackgroundResponseMap["GET_STATUS"]> {
  const { apiToken, autoDetectEnabled, activeSessionId } = await getStored();

  let activeSession: SessionState | null = null;
  if (apiToken && activeSessionId) {
    activeSession = await fetchFreshSessionState(apiToken, activeSessionId);
    if (!activeSession || activeSession.status === "completed") {
      await setActiveSessionId(null);
      activeSession = null;
    }
  }

  return { autoDetectEnabled, activeSession, hasToken: Boolean(apiToken) };
}

async function handleSnooze(
  sessionId: string,
): Promise<BackgroundResponseMap["SNOOZE_SESSION"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  try {
    await snoozeUnlockSession(token, sessionId);
    const fresh = await fetchFreshSessionState(token, sessionId);
    if (!fresh) return { ok: false, error: "Could not confirm the snooze took effect." };

    if (fresh.snooze_until) scheduleSnoozeAlarm(sessionId, fresh.snooze_until);
    await broadcastToReanimeTabs({ type: "LOCK_CLEARED" });
    return { ok: true, session: fresh };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handlePoll(sessionId: string): Promise<BackgroundResponseMap["POLL_SESSION"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  const fresh = await fetchFreshSessionState(token, sessionId);
  if (!fresh) return { ok: false, error: "Session not found." };

  if (fresh.status === "completed") {
    const { activeSessionId } = await getStored();
    if (activeSessionId === sessionId) await setActiveSessionId(null);
  }

  return { ok: true, session: fresh };
}

async function handleMarkApplied(
  jobPostingId: string,
): Promise<BackgroundResponseMap["MARK_APPLIED"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  try {
    const result = await markApplied(token, jobPostingId);
    if (!result.session) return { ok: true, session: null };

    // The mark-applied route's session shape omits snooze fields (it never
    // needs them) — default them here rather than widening the API response
    // just for this broadcast; the overlay's next poll gets the full picture.
    const session: SessionState = {
      id: result.session.id,
      required_count: result.session.required_count,
      applied_count: result.session.applied_count,
      status: result.session.status,
      snooze_until: null,
      snooze_count: 0,
    };

    if (session.status === "completed") {
      const { activeSessionId } = await getStored();
      if (activeSessionId === session.id) await setActiveSessionId(null);
      chrome.alarms.clear(`${SNOOZE_ALARM_PREFIX}${session.id}`);
      await broadcastToReanimeTabs({ type: "LOCK_CLEARED" });
    } else {
      await broadcastToReanimeTabs({ type: "SESSION_UPDATED", session });
    }

    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleSaveToken(token: string): Promise<TokenStatus> {
  await setToken(token);
  return handleCheckToken();
}

async function handleCheckToken(): Promise<TokenStatus> {
  const token = await requireToken();
  if (!token) return { hasToken: false, valid: null, config: null, error: null };

  try {
    const config = await getExtensionConfig(token);
    return { hasToken: true, valid: true, config, error: null };
  } catch (error) {
    return {
      hasToken: true,
      valid: false,
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type AnyResponse = BackgroundResponseMap[keyof BackgroundResponseMap] | { error: string };

async function handleMessage(
  message: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<AnyResponse> {
  switch (message.type) {
    case "TRIGGER_EPISODE_END":
      return handleTrigger();
    case "GET_STATUS":
      return handleGetStatus();
    case "SET_AUTO_DETECT_ENABLED":
      await setAutoDetectEnabled(message.enabled);
      return { ok: true };
    case "SNOOZE_SESSION":
      return handleSnooze(message.sessionId);
    case "POLL_SESSION":
      return handlePoll(message.sessionId);
    case "MARK_APPLIED":
      return handleMarkApplied(message.jobPostingId);
    case "SAVE_TOKEN":
      return handleSaveToken(message.token);
    case "CHECK_TOKEN":
      return handleCheckToken();
    case "GET_QUOTE":
      return getQuote();
    case "GET_MY_JOB_POSTING_ID": {
      const tabId = sender.tab?.id;
      const jobPostingId = tabId !== undefined ? await getJobPostingForTab(tabId) : null;
      return { jobPostingId };
    }
    default:
      return { error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ error: error instanceof Error ? error.message : String(error) }),
    );
  return true; // keep the message channel open for the async response above
});

// ---------------------------------------------------------------------------
// Snooze re-lock alarm — chrome.alarms persists across service worker
// restarts, which is why snooze timing lives here rather than a setTimeout.
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) return;
  const sessionId = alarm.name.slice(SNOOZE_ALARM_PREFIX.length);

  const token = await requireToken();
  if (!token) return;

  const session = await fetchFreshSessionState(token, sessionId);
  if (!session || session.status === "completed") return;

  // Treat "snooze_until has passed" as re-locked regardless of the literal
  // stored status string — nothing flips it back to 'locked' server-side,
  // and the overlay doesn't need it to.
  await broadcastToReanimeTabs({ type: "LOCK_ACTIVE", session });
});

// Cleans up the tab->job-posting map as opened tabs get closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabJobPosting(tabId).catch(() => {});
});
