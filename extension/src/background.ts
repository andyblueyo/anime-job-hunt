// MV3 service worker. The only place that holds the API token and the only
// place that calls fetch() against the website — see messages.ts's header
// for why. Also owns tab orchestration (opening job-posting tabs, injecting
// the capture ribbon into them, noticing when they close), the undo window on
// ribbon decisions, and the snooze re-lock alarm.

import {
  ApiError,
  createUnlockSession,
  getExtensionConfig,
  getUnlockSession,
  markApplied,
  requestReplacements,
  skipPosting,
  snoozeUnlockSession,
  updateEpisodeRequiredCount,
} from "./lib/api-client";
import type {
  BackgroundRequest,
  BackgroundResponseMap,
  ContentBroadcast,
  Decision,
  DecisionResponse,
  JobPosting,
  SessionProgress,
  SessionState,
  TokenStatus,
  TrackedPostingInfo,
} from "./lib/messages";
import { getQuote } from "./lib/quotes";
import {
  addPendingConfirmation,
  countTrackedForSession,
  findTabsForPosting,
  getPendingConfirmations,
  getPendingDecisions,
  getStored,
  getTrackedTab,
  removePendingConfirmation,
  removeTrackedTab,
  setActiveSessionId,
  setAutoDetectEnabled,
  setPendingDecision,
  setPostingDecision,
  setToken,
  setTrackedTab,
  takePendingDecision,
} from "./lib/storage";

const REANIME_TAB_QUERY = "https://reanime.to/*";
const SNOOZE_ALARM_PREFIX = "snooze:";

/**
 * How long a ribbon decision waits before being sent to the API. Lives here
 * rather than in the ribbon's content script because (a) a full-width top bar
 * is easy to mis-click, and (b) the tab is very likely to be closed right
 * after clicking — a timer in the tab would die with it, which is exactly the
 * moment it needs to survive.
 */
const UNDO_WINDOW_MS = 5000;

/** Used when the config read fails at tab-close time (offline, bad token). */
const DEFAULT_CLOSE_PROMPT_MIN_SECONDS = 90;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function requireToken(): Promise<string | null> {
  const { apiToken } = await getStored();
  return apiToken;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * The decision routes return the trimmed SessionProgress shape (no snooze
 * fields — they never need them). Default those here rather than widening the
 * API response just for a broadcast; the overlay's next poll gets the full
 * picture.
 */
function progressToSessionState(progress: SessionProgress): SessionState {
  return {
    id: progress.id,
    required_count: progress.required_count,
    applied_count: progress.applied_count,
    status: progress.status,
    snooze_until: null,
    snooze_count: 0,
    outstanding_count: progress.outstanding_count,
  };
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

async function sendToPostingTabs(jobPostingId: string, message: ContentBroadcast): Promise<void> {
  const tabIds = await findTabsForPosting(jobPostingId);
  await Promise.all(
    tabIds.map((tabId) =>
      chrome.tabs.sendMessage(tabId, message).catch(() => {
        // Tab closed or ribbon not injected — nothing to update.
      }),
    ),
  );
}

/**
 * Pushes a session's new state to the anime tabs: clears the lock if it just
 * completed (and tidies the active-session pointer + snooze alarm), otherwise
 * updates the overlay in place.
 */
async function publishSession(session: SessionState): Promise<void> {
  if (session.status === "completed") {
    const { activeSessionId } = await getStored();
    if (activeSessionId === session.id) await setActiveSessionId(null);
    chrome.alarms.clear(`${SNOOZE_ALARM_PREFIX}${session.id}`);
    await broadcastToReanimeTabs({ type: "LOCK_CLEARED" });
  } else {
    await broadcastToReanimeTabs({ type: "SESSION_UPDATED", session });
  }
}

function injectRibbonWhenReady(tabId: number): void {
  const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content/mark-applied.js"] })
      .catch(() => {
        // Some pages refuse injection (chrome://, PDFs, an extension
        // gallery). Nothing to do but leave that tab without the ribbon —
        // the closed-tab prompt still covers it.
      });
  };
  chrome.tabs.onUpdated.addListener(listener);
}

/**
 * Opens one tab per posting and tracks the real (non-search-fallback) ones so
 * the ribbon can name them and onRemoved can tell how long they were open.
 * Returns how many tabs were actually opened.
 */
async function openPostingTabs(
  postings: JobPosting[],
  sessionId: string,
  requiredCount: number,
): Promise<number> {
  // Positions continue from whatever's already open for this session, so a
  // replacements batch reads "3 of 3", not "1 of 3" again.
  let position = await countTrackedForSession(sessionId);
  let opened = 0;

  for (const posting of postings) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: posting.url, active: false });
    } catch {
      continue; // an individual bad URL shouldn't sink the rest of the batch
    }
    opened++;
    if (!posting.isSearchFallback && posting.id && tab.id) {
      position++;
      await setTrackedTab(tab.id, {
        jobPostingId: posting.id,
        sessionId,
        company: posting.company,
        title: posting.title,
        position,
        total: requiredCount,
        openedAt: Date.now(),
        decision: null,
      });
      injectRibbonWhenReady(tab.id);
    }
  }
  return opened;
}

function scheduleSnoozeAlarm(sessionId: string, snoozeUntil: string): void {
  chrome.alarms.create(`${SNOOZE_ALARM_PREFIX}${sessionId}`, {
    when: Date.parse(snoozeUntil),
  });
}

// ---------------------------------------------------------------------------
// Decisions — the API calls themselves
// ---------------------------------------------------------------------------

/** Writes the application and publishes the session's new state. */
async function applyNow(token: string, jobPostingId: string): Promise<DecisionResponse> {
  try {
    const result = await markApplied(token, jobPostingId);
    if (!result.session) return { ok: true, session: null };
    const session = progressToSessionState(result.session);
    await publishSession(session);
    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Returns the posting to the pool and publishes the session's new state. */
async function skipNow(token: string, jobPostingId: string): Promise<DecisionResponse> {
  try {
    const result = await skipPosting(token, jobPostingId);
    if (!result.session) return { ok: true, session: null };
    const session = progressToSessionState(result.session);
    await publishSession(session);
    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Decisions — the undo window
// ---------------------------------------------------------------------------

// Timers are in-memory (a 5s setTimeout is well inside the worker's idle
// grace), but the decisions themselves are persisted, and the startup block
// at the bottom re-arms anything a restart interrupted.
const commitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function armCommitTimer(jobPostingId: string, delayMs: number): void {
  cancelCommitTimer(jobPostingId);
  const timer = setTimeout(() => {
    commitTimers.delete(jobPostingId);
    void commitDecision(jobPostingId);
  }, Math.max(0, delayMs));
  commitTimers.set(jobPostingId, timer);
}

function cancelCommitTimer(jobPostingId: string): void {
  const timer = commitTimers.get(jobPostingId);
  if (timer) clearTimeout(timer);
  commitTimers.delete(jobPostingId);
}

/** Fires when the undo window closes: hit the API and tell the ribbon how it went. */
async function commitDecision(jobPostingId: string): Promise<void> {
  const pending = await takePendingDecision(jobPostingId);
  if (!pending) return; // undone in the meantime

  const token = await requireToken();
  const result: DecisionResponse = token
    ? pending.decision === "applied"
      ? await applyNow(token, jobPostingId)
      : await skipNow(token, jobPostingId)
    : { ok: false, error: "No API token configured." };

  if (!result.ok) {
    // Let the tab fall back to "undecided" so closing it still prompts, and
    // the ribbon can offer a retry. If the tab is already gone (the common
    // case — people close right after clicking), the ribbon can't retry, so
    // hand the question to the overlay's closed-tab prompt instead.
    await setPostingDecision(jobPostingId, null);
    const openTabs = await findTabsForPosting(jobPostingId);
    if (openTabs.length === 0 && pending.sessionId) {
      await addPendingConfirmation({
        jobPostingId,
        sessionId: pending.sessionId,
        company: pending.company,
        title: pending.title,
        secondsOpen: Math.round((Date.now() - pending.openedAt) / 1000),
        closedAt: Date.now(),
      });
    }
  }

  await sendToPostingTabs(jobPostingId, {
    type: "DECISION_COMMITTED",
    jobPostingId,
    decision: pending.decision,
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    session: result.ok ? result.session : null,
  });
}

/**
 * Records a ribbon decision, starts its undo window, and answers with the
 * *projected* session state so the ribbon can say "2 of 2 done" right away.
 * Nothing reaches the API until commitDecision runs.
 */
async function deferDecision(
  jobPostingId: string,
  decision: Decision,
  senderTabId: number | undefined,
): Promise<DecisionResponse> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  const tracked = senderTabId !== undefined ? await getTrackedTab(senderTabId) : null;
  const sessionId = tracked?.sessionId ?? (await getStored()).activeSessionId;

  await setPostingDecision(jobPostingId, decision);
  await setPendingDecision({
    jobPostingId,
    sessionId,
    decision,
    commitAt: Date.now() + UNDO_WINDOW_MS,
    company: tracked?.company ?? null,
    title: tracked?.title ?? "Job posting",
    openedAt: tracked?.openedAt ?? Date.now(),
  });
  armCommitTimer(jobPostingId, UNDO_WINDOW_MS);

  const fresh = sessionId ? await fetchFreshSessionState(token, sessionId) : null;
  if (!fresh) return { ok: true, session: null };

  const outstanding = Math.max(0, (fresh.outstanding_count ?? 1) - 1);
  const applied = decision === "applied" ? fresh.applied_count + 1 : fresh.applied_count;
  return {
    ok: true,
    session: {
      ...fresh,
      applied_count: applied,
      outstanding_count: outstanding,
      status: applied >= fresh.required_count ? "completed" : fresh.status,
    },
  };
}

async function handleUndo(jobPostingId: string): Promise<BackgroundResponseMap["UNDO_DECISION"]> {
  cancelCommitTimer(jobPostingId);
  await takePendingDecision(jobPostingId);
  await setPostingDecision(jobPostingId, null);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Closed-tab confirmations
// ---------------------------------------------------------------------------

async function getClosePromptMinSeconds(token: string): Promise<number> {
  try {
    const config = await getExtensionConfig(token);
    return config.close_prompt_min_seconds;
  } catch {
    return DEFAULT_CLOSE_PROMPT_MIN_SECONDS;
  }
}

async function handleTabRemoved(tabId: number): Promise<void> {
  const tracked = await removeTrackedTab(tabId);
  if (!tracked) return;
  if (tracked.decision) return; // the ribbon already has an answer

  const token = await requireToken();
  if (!token) return;

  const secondsOpen = Math.round((Date.now() - tracked.openedAt) / 1000);
  const minSeconds = await getClosePromptMinSeconds(token);
  // A tab closed in eleven seconds wasn't an application; asking anyway is
  // how you train someone to dismiss the prompt reflexively.
  if (secondsOpen < minSeconds) return;

  await addPendingConfirmation({
    jobPostingId: tracked.jobPostingId,
    sessionId: tracked.sessionId,
    company: tracked.company,
    title: tracked.title,
    secondsOpen,
    closedAt: Date.now(),
  });
}

/**
 * The overlay's "I applied" / "I didn't". Immediate — there's no ribbon left
 * to undo from. The entry leaves the pending list on success, and also on a
 * definitive rejection (posting gone, or already applied via /queue) since
 * re-asking can't change that answer; a network failure keeps it for retry.
 */
async function handleResolvePending(
  jobPostingId: string,
  applied: boolean,
): Promise<BackgroundResponseMap["RESOLVE_PENDING"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  const result = applied
    ? await applyNow(token, jobPostingId)
    : await skipNow(token, jobPostingId);

  const definitive = result.ok || /not found|already/i.test(result.error);
  if (definitive) await removePendingConfirmation(jobPostingId);

  return result;
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
      outstanding_count: result.postings.filter((p) => !p.isSearchFallback).length,
    };
    await setActiveSessionId(session.id);
    await openPostingTabs(result.postings, session.id, session.required_count);
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
    return { ok: false, error: errorMessage(error) };
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
    return { ok: false, error: errorMessage(error) };
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

async function handleRequestReplacements(
  sessionId: string,
): Promise<BackgroundResponseMap["REQUEST_REPLACEMENTS"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  try {
    const result = await requestReplacements(token, sessionId);
    const opened = await openPostingTabs(result.postings, sessionId, result.required_count);
    return { ok: true, opened };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Reads the live config on demand. Nothing caches the result — the website
 * owns episode_required_count, and a copy in chrome.storage would go stale
 * the moment /settings changed it.
 */
async function handleGetConfig(): Promise<BackgroundResponseMap["GET_CONFIG"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  try {
    return { ok: true, config: await getExtensionConfig(token) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function handleSetEpisodeRequiredCount(
  count: number,
): Promise<BackgroundResponseMap["SET_EPISODE_REQUIRED_COUNT"]> {
  const token = await requireToken();
  if (!token) return { ok: false, error: "No API token configured." };

  try {
    // The response is the config as stored, so the popup re-renders from the
    // server's answer rather than assuming the write took the value it sent.
    return { ok: true, config: await updateEpisodeRequiredCount(token, count) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
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
    return { hasToken: true, valid: false, config: null, error: errorMessage(error) };
  }
}

async function handleGetMyPosting(
  tabId: number | undefined,
): Promise<BackgroundResponseMap["GET_MY_JOB_POSTING_ID"]> {
  const tracked = tabId !== undefined ? await getTrackedTab(tabId) : null;
  if (!tracked) return { jobPostingId: null, posting: null };

  const pending = (await getPendingDecisions())[tracked.jobPostingId];
  const posting: TrackedPostingInfo = {
    jobPostingId: tracked.jobPostingId,
    sessionId: tracked.sessionId,
    company: tracked.company,
    title: tracked.title,
    position: tracked.position,
    total: tracked.total,
    decision: tracked.decision,
    undoAvailable: Boolean(pending),
  };
  return { jobPostingId: tracked.jobPostingId, posting };
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
      return deferDecision(message.jobPostingId, "applied", sender.tab?.id);
    case "SKIP_POSTING":
      return deferDecision(message.jobPostingId, "skipped", sender.tab?.id);
    case "UNDO_DECISION":
      return handleUndo(message.jobPostingId);
    case "GET_PENDING_CONFIRMATIONS":
      return { pending: await getPendingConfirmations() };
    case "RESOLVE_PENDING":
      return handleResolvePending(message.jobPostingId, message.applied);
    case "REQUEST_REPLACEMENTS":
      return handleRequestReplacements(message.sessionId);
    case "SAVE_TOKEN":
      return handleSaveToken(message.token);
    case "CHECK_TOKEN":
      return handleCheckToken();
    case "GET_QUOTE":
      return getQuote();
    case "GET_CONFIG":
      return handleGetConfig();
    case "SET_EPISODE_REQUIRED_COUNT":
      return handleSetEpisodeRequiredCount(message.count);
    case "GET_MY_JOB_POSTING_ID":
      return handleGetMyPosting(sender.tab?.id);
    default:
      return { error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: errorMessage(error) }));
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

// A tracked job tab closing is the moment to decide whether to ask about it.
chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Startup: the worker may have been torn down with decisions still inside
// their undo window. Re-arm them (commitAt in the past → commit now).
// ---------------------------------------------------------------------------

void (async () => {
  const pending = await getPendingDecisions();
  for (const decision of Object.values(pending)) {
    armCommitTimer(decision.jobPostingId, decision.commitAt - Date.now());
  }
})();
