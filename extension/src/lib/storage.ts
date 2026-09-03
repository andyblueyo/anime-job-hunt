// chrome.storage.local wrapper. This is the ONLY module that reads or writes
// the API token — content scripts and the popup/options UI never touch
// storage directly, only background.ts does (see messages.ts's header).
//
// Everything here is persisted rather than kept in a module-level variable
// because the MV3 service worker can be terminated and restarted at any
// time; anything that needs to survive that (the active session id, which
// tab is applying to which posting) has to live in chrome.storage instead of
// plain memory.

export interface StoredState {
  apiToken: string | null;
  autoDetectEnabled: boolean;
  activeSessionId: string | null;
  /** tabId -> job_posting_id, for tabs opened as part of an unlock session. */
  tabJobPostings: Record<number, string>;
}

const DEFAULTS: StoredState = {
  apiToken: null,
  autoDetectEnabled: false, // off by default — see the Phase 2 plan's scope section
  activeSessionId: null,
  tabJobPostings: {},
};

export async function getStored(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return stored as StoredState;
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

export async function setTabJobPosting(tabId: number, jobPostingId: string): Promise<void> {
  const { tabJobPostings } = await getStored();
  tabJobPostings[tabId] = jobPostingId;
  await chrome.storage.local.set({ tabJobPostings });
}

export async function getJobPostingForTab(tabId: number): Promise<string | null> {
  const { tabJobPostings } = await getStored();
  return tabJobPostings[tabId] ?? null;
}

export async function removeTabJobPosting(tabId: number): Promise<void> {
  const { tabJobPostings } = await getStored();
  if (!(tabId in tabJobPostings)) return;
  delete tabJobPostings[tabId];
  await chrome.storage.local.set({ tabJobPostings });
}

/** Drops entries for tabs that no longer exist, so the map doesn't grow forever. */
export async function pruneTabJobPostings(openTabIds: Set<number>): Promise<void> {
  const { tabJobPostings } = await getStored();
  const pruned: Record<number, string> = {};
  for (const [tabId, jobPostingId] of Object.entries(tabJobPostings)) {
    if (openTabIds.has(Number(tabId))) pruned[Number(tabId)] = jobPostingId;
  }
  await chrome.storage.local.set({ tabJobPostings: pruned });
}
