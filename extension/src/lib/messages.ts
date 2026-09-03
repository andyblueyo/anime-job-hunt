/**
 * Typed chrome.runtime message contracts shared across every script in the
 * extension.
 *
 * Design rule (see the Phase 2 plan, "Why message-passing through the
 * background script"): content scripts and the popup/options pages never
 * call the website's API directly and never read the stored token
 * themselves. Every request funnels through the background service worker,
 * which is the only place that touches `chrome.storage` for the token and
 * the only place that calls `fetch()` against the API — background is
 * exempt from the page-level CORS/CSP that content scripts inherit, as long
 * as `host_permissions` covers the API's origin.
 */

export interface JobPosting {
  id: string | null;
  company: string | null;
  title: string;
  url: string;
  location: string | null;
  isSearchFallback: boolean;
}

export interface SessionState {
  id: string;
  required_count: number;
  applied_count: number;
  status: "locked" | "snoozed" | "completed";
  snooze_until: string | null;
  snooze_count: number;
}

export interface ExtensionConfig {
  near_end_threshold_seconds: number;
  snooze_minutes: number;
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
}

export interface TokenStatus {
  hasToken: boolean;
  valid: boolean | null; // null = not checked yet
  config: ExtensionConfig | null;
  error: string | null;
}

export interface ExtensionStatus {
  autoDetectEnabled: boolean;
  activeSession: SessionState | null;
  hasToken: boolean;
}

// ---------------------------------------------------------------------------
// Requests: popup / options / content scripts -> background
// ---------------------------------------------------------------------------

export type BackgroundRequest =
  | { type: "TRIGGER_EPISODE_END"; source: "manual" | "auto-detect" }
  | { type: "GET_STATUS" }
  | { type: "SET_AUTO_DETECT_ENABLED"; enabled: boolean }
  | { type: "SNOOZE_SESSION"; sessionId: string }
  | { type: "POLL_SESSION"; sessionId: string }
  | { type: "MARK_APPLIED"; jobPostingId: string }
  | { type: "SAVE_TOKEN"; token: string }
  | { type: "CHECK_TOKEN" }
  | { type: "GET_QUOTE" }
  | { type: "GET_MY_JOB_POSTING_ID" };

export interface BackgroundResponseMap {
  TRIGGER_EPISODE_END:
    | { ok: true; session: SessionState; postings: JobPosting[] }
    | { ok: false; error: string; rateLimited?: boolean; session?: SessionState | null };
  GET_STATUS: ExtensionStatus;
  SET_AUTO_DETECT_ENABLED: { ok: true };
  SNOOZE_SESSION: { ok: true; session: SessionState } | { ok: false; error: string };
  POLL_SESSION: { ok: true; session: SessionState } | { ok: false; error: string };
  MARK_APPLIED: { ok: true; session: SessionState | null } | { ok: false; error: string };
  SAVE_TOKEN: TokenStatus;
  CHECK_TOKEN: TokenStatus;
  GET_QUOTE: { quote: string; author: string | null };
  GET_MY_JOB_POSTING_ID: { jobPostingId: string | null };
}

// ---------------------------------------------------------------------------
// Broadcasts: background -> content scripts (chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

export type ContentBroadcast =
  | { type: "LOCK_ACTIVE"; session: SessionState }
  | { type: "LOCK_CLEARED" }
  | { type: "SESSION_UPDATED"; session: SessionState };

/**
 * Promise-wrapped chrome.runtime.sendMessage with a typed response and
 * chrome.runtime.lastError surfaced as a rejection instead of silently
 * swallowed (the classic MV3 footgun).
 */
export function sendToBackground<T extends BackgroundRequest["type"]>(
  message: Extract<BackgroundRequest, { type: T }>,
): Promise<BackgroundResponseMap[T]> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as BackgroundResponseMap[T]);
    });
  });
}
