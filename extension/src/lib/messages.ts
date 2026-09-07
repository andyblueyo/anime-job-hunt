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
  /**
   * Postings still handed out to this session and undecided. Present on
   * responses from GET /api/unlock-sessions/:id and the decision routes;
   * absent on the locally-built state right after a trigger. When
   * applied + outstanding < required the overlay offers "Open replacements".
   */
  outstanding_count?: number;
}

/**
 * The trimmed session shape the mark-applied / skip-posting routes return
 * (web/lib/unlock-sessions.ts `SessionProgress`) — no snooze fields, since
 * those routes never need them.
 */
export interface SessionProgress {
  id: string;
  required_count: number;
  applied_count: number;
  status: SessionState["status"];
  outstanding_count: number;
}

export interface ExtensionConfig {
  near_end_threshold_seconds: number;
  snooze_minutes: number;
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
  /**
   * How many applications one episode costs (1-5). Read from the website on
   * demand and never persisted extension-side — the website is the source of
   * truth, and a cached copy here would go stale the moment /settings changes
   * it. See the popup's difficulty control.
   */
  episode_required_count: number;
  /**
   * Seconds a handed-out job tab must have been open before closing it
   * undecided triggers the "did you apply?" prompt on the lock overlay.
   */
  close_prompt_min_seconds: number;
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

export type Decision = "applied" | "skipped";

/**
 * What the ribbon needs to know about the tab it's been injected into: which
 * posting this is, how to name it (five of these can be open at once), where
 * it sits in the episode's batch, and whether a decision has already been
 * made on it (the tab was reloaded after clicking).
 */
export interface TrackedPostingInfo {
  jobPostingId: string;
  sessionId: string;
  company: string | null;
  title: string;
  /** 1-based position among the postings handed out for this session. */
  position: number;
  /** The session's required_count. */
  total: number;
  decision: Decision | null;
  /** True while the decision is still inside its undo window. */
  undoAvailable: boolean;
}

/** A tracked job tab that was closed without a ribbon decision. */
export interface PendingConfirmation {
  jobPostingId: string;
  sessionId: string;
  company: string | null;
  title: string;
  secondsOpen: number;
  closedAt: number;
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
  | { type: "SKIP_POSTING"; jobPostingId: string }
  | { type: "UNDO_DECISION"; jobPostingId: string }
  | { type: "GET_PENDING_CONFIRMATIONS" }
  | { type: "RESOLVE_PENDING"; jobPostingId: string; applied: boolean }
  | { type: "REQUEST_REPLACEMENTS"; sessionId: string }
  | { type: "SAVE_TOKEN"; token: string }
  | { type: "CHECK_TOKEN" }
  | { type: "GET_QUOTE" }
  | { type: "GET_MY_JOB_POSTING_ID" }
  | { type: "GET_CONFIG" }
  | { type: "SET_EPISODE_REQUIRED_COUNT"; count: number };

export type DecisionResponse =
  | { ok: true; session: SessionState | null }
  | { ok: false; error: string };

export interface BackgroundResponseMap {
  TRIGGER_EPISODE_END:
    | { ok: true; session: SessionState; postings: JobPosting[] }
    | { ok: false; error: string; rateLimited?: boolean; session?: SessionState | null };
  GET_STATUS: ExtensionStatus;
  SET_AUTO_DETECT_ENABLED: { ok: true };
  SNOOZE_SESSION: { ok: true; session: SessionState } | { ok: false; error: string };
  POLL_SESSION: { ok: true; session: SessionState } | { ok: false; error: string };
  /**
   * From the ribbon these two are DEFERRED: the background holds the decision
   * for UNDO_WINDOW_MS before calling the API, and `session` is the projected
   * state (what it will be once committed), not a server read. The eventual
   * outcome arrives as a DECISION_COMMITTED broadcast to the job tab.
   */
  MARK_APPLIED: DecisionResponse;
  SKIP_POSTING: DecisionResponse;
  UNDO_DECISION: { ok: true };
  GET_PENDING_CONFIRMATIONS: { pending: PendingConfirmation[] };
  /** Immediate (no undo window) — the closed-tab prompt has no ribbon to undo from. */
  RESOLVE_PENDING: DecisionResponse;
  REQUEST_REPLACEMENTS: { ok: true; opened: number } | { ok: false; error: string };
  SAVE_TOKEN: TokenStatus;
  CHECK_TOKEN: TokenStatus;
  GET_QUOTE: { quote: string; author: string | null };
  GET_MY_JOB_POSTING_ID: { jobPostingId: string | null; posting: TrackedPostingInfo | null };
  GET_CONFIG: { ok: true; config: ExtensionConfig } | { ok: false; error: string };
  SET_EPISODE_REQUIRED_COUNT:
    | { ok: true; config: ExtensionConfig }
    | { ok: false; error: string };
}

// ---------------------------------------------------------------------------
// Broadcasts: background -> content scripts (chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

export type ContentBroadcast =
  | { type: "LOCK_ACTIVE"; session: SessionState }
  | { type: "LOCK_CLEARED" }
  | { type: "SESSION_UPDATED"; session: SessionState }
  /** Sent to a job tab's ribbon once its deferred decision hits the API. */
  | {
      type: "DECISION_COMMITTED";
      jobPostingId: string;
      decision: Decision;
      ok: boolean;
      error?: string;
      session: SessionState | null;
    };

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
