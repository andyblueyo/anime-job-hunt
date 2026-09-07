// chrome.storage.local wrapper. This is the ONLY module that reads or writes
// the API token — content scripts and the popup/options UI never touch
// storage directly, only background.ts does (see messages.ts's header).
//
// Everything here is persisted rather than kept in a module-level variable
// because the MV3 service worker can be terminated and restarted at any
// time; anything that needs to survive that (the active session id, which
// tab is applying to which posting, decisions waiting out their undo window)
// has to live in chrome.storage instead of plain memory.

import type { Decision, PendingConfirmation } from "./messages";

/** A job-posting tab the background opened as part of an unlock session. */
export interface TrackedTab {
  jobPostingId: string;
  sessionId: string;
  company: string | null;
  title: string;
  /** 1-based position among the postings handed out for this session. */
  position: number;
  /** The session's required_count at the time the tab was opened. */
  total: number;
  openedAt: number;
  /**
   * Set the moment a ribbon button is clicked (before the undo window runs
   * out), so closing the tab mid-window doesn't also raise a closed-tab
   * prompt. Cleared again on undo or if the commit fails.
   */
  decision: Decision | null;
}

/** A ribbon decision waiting out its undo window before hitting the API. */
export interface PendingDecision {
  jobPostingId: string;
  sessionId: string | null;
  decision: Decision;
  commitAt: number;
  /** Carried so a commit that fails after the tab is gone can still raise a prompt. */
  company: string | null;
  title: string;
  openedAt: number;
}

export interface StoredState {
  apiToken: string | null;
  autoDetectEnabled: boolean;
  activeSessionId: string | null;
  /** tabId -> tracked posting, for tabs opened as part of an unlock session. */
  tabJobPostings: Record<number, TrackedTab>;
  /** Tracked tabs closed without a decision, awaiting the overlay's prompt. */
  pendingConfirmations: PendingConfirmation[];
  /** jobPostingId -> decision inside its undo window. */
  pendingDecisions: Record<string, PendingDecision>;
}

const DEFAULTS: StoredState = {
  apiToken: null,
  autoDetectEnabled: false, // off by default — see the Phase 2 plan's scope section
  activeSessionId: null,
  tabJobPostings: {},
  pendingConfirmations: [],
  pendingDecisions: {},
};

export async function getStored(): Promise<StoredState> {
  const stored = (await chrome.storage.local.get(DEFAULTS)) as StoredState;

  // Phase 2 stored tabJobPostings as tabId -> job_posting_id (a bare string).
  // Entries in that shape can't drive the ribbon or the closed-tab prompt, so
  // drop them rather than guess — they only exist for tabs opened before the
  // extension was updated.
  const tabs: Record<number, TrackedTab> = {};
  for (const [tabId, value] of Object.entries(stored.tabJobPostings ?? {})) {
    if (value && typeof value === "object") tabs[Number(tabId)] = value as TrackedTab;
  }
  stored.tabJobPostings = tabs;

  return stored;
}

export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ apiToken: token });
}

export async function setAutoDetectEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ autoDetectEnabled: enabled });
}

export async function setActiveSessionId(sessionId: string | null): Promise<void> {
  await chrome.storage.local.set({ activeSessionId: sessionId });
}

// ---------------------------------------------------------------------------
// Tracked job tabs
// ---------------------------------------------------------------------------

export async function setTrackedTab(tabId: number, tracked: TrackedTab): Promise<void> {
  const { tabJobPostings } = await getStored();
  tabJobPostings[tabId] = tracked;
  await chrome.storage.local.set({ tabJobPostings });
}

export async function getTrackedTab(tabId: number): Promise<TrackedTab | null> {
  const { tabJobPostings } = await getStored();
  return tabJobPostings[tabId] ?? null;
}

/** Every open tab showing this posting (normally one; duplicates are harmless). */
export async function findTabsForPosting(jobPostingId: string): Promise<number[]> {
  const { tabJobPostings } = await getStored();
  return Object.entries(tabJobPostings)
    .filter(([, tracked]) => tracked.jobPostingId === jobPostingId)
    .map(([tabId]) => Number(tabId));
}

/** Records (or clears) the ribbon decision on every tab showing this posting. */
export async function setPostingDecision(
  jobPostingId: string,
  decision: Decision | null,
): Promise<void> {
  const { tabJobPostings } = await getStored();
  let changed = false;
  for (const tracked of Object.values(tabJobPostings)) {
    if (tracked.jobPostingId === jobPostingId) {
      tracked.decision = decision;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ tabJobPostings });
}

/** How many tracked tabs (open, decided or not) belong to this session. */
export async function countTrackedForSession(sessionId: string): Promise<number> {
  const { tabJobPostings } = await getStored();
  return Object.values(tabJobPostings).filter((t) => t.sessionId === sessionId).length;
}

/** Removes and returns the entry, so onRemoved can decide whether to prompt. */
export async function removeTrackedTab(tabId: number): Promise<TrackedTab | null> {
  const { tabJobPostings } = await getStored();
  const tracked = tabJobPostings[tabId];
  if (!tracked) return null;
  delete tabJobPostings[tabId];
  await chrome.storage.local.set({ tabJobPostings });
  return tracked;
}

/** Drops entries for tabs that no longer exist, so the map doesn't grow forever. */
export async function pruneTrackedTabs(openTabIds: Set<number>): Promise<void> {
  const { tabJobPostings } = await getStored();
  const pruned: Record<number, TrackedTab> = {};
  for (const [tabId, tracked] of Object.entries(tabJobPostings)) {
    if (openTabIds.has(Number(tabId))) pruned[Number(tabId)] = tracked;
  }
  await chrome.storage.local.set({ tabJobPostings: pruned });
}

// ---------------------------------------------------------------------------
// Closed-tab confirmations
// ---------------------------------------------------------------------------

export async function getPendingConfirmations(): Promise<PendingConfirmation[]> {
  const { pendingConfirmations } = await getStored();
  return pendingConfirmations;
}

export async function addPendingConfirmation(entry: PendingConfirmation): Promise<void> {
  const { pendingConfirmations } = await getStored();
  // One prompt per posting, however many tabs of it were closed.
  const rest = pendingConfirmations.filter((p) => p.jobPostingId !== entry.jobPostingId);
  await chrome.storage.local.set({ pendingConfirmations: [...rest, entry] });
}

export async function removePendingConfirmation(jobPostingId: string): Promise<void> {
  const { pendingConfirmations } = await getStored();
  await chrome.storage.local.set({
    pendingConfirmations: pendingConfirmations.filter((p) => p.jobPostingId !== jobPostingId),
  });
}

// ---------------------------------------------------------------------------
// Deferred (undoable) decisions
// ---------------------------------------------------------------------------

export async function getPendingDecisions(): Promise<Record<string, PendingDecision>> {
  const { pendingDecisions } = await getStored();
  return pendingDecisions;
}

export async function setPendingDecision(decision: PendingDecision): Promise<void> {
  const { pendingDecisions } = await getStored();
  pendingDecisions[decision.jobPostingId] = decision;
  await chrome.storage.local.set({ pendingDecisions });
}

/** Removes and returns the entry (null if there was nothing pending). */
export async function takePendingDecision(jobPostingId: string): Promise<PendingDecision | null> {
  const { pendingDecisions } = await getStored();
  const decision = pendingDecisions[jobPostingId];
  if (!decision) return null;
  delete pendingDecisions[jobPostingId];
  await chrome.storage.local.set({ pendingDecisions });
  return decision;
}
