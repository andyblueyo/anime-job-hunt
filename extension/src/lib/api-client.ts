// Talks to the Next.js API routes under web/app/api/*. Imported ONLY by
// background.ts — see messages.ts's header for why content scripts and the
// popup/options UI never call this directly.

import { WEB_APP_ORIGIN } from "./env";
import type { ExtensionConfig, JobPosting, SessionProgress, SessionState } from "./messages";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${WEB_APP_ORIGIN}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON error body (e.g. a proxy 502 page) still surfaces via
    // response.ok below rather than throwing here.
  }

  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export interface CreateUnlockSessionResult {
  session_id: string;
  required_count: number;
  postings: JobPosting[];
}

export function createUnlockSession(token: string): Promise<CreateUnlockSessionResult> {
  return request(token, "/api/unlock-sessions", { method: "POST" });
}

export function getUnlockSession(token: string, sessionId: string): Promise<SessionState> {
  return request(token, `/api/unlock-sessions/${encodeURIComponent(sessionId)}`);
}

export function snoozeUnlockSession(token: string, sessionId: string): Promise<SessionState> {
  return request(token, `/api/unlock-sessions/${encodeURIComponent(sessionId)}/snooze`, {
    method: "POST",
  });
}

/**
 * Same response shape as createUnlockSession, minus a new session: the
 * postings the session is still short, freshly claimed. See
 * web/app/api/unlock-sessions/[id]/replacements/route.ts for why this exists.
 */
export function requestReplacements(
  token: string,
  sessionId: string,
): Promise<CreateUnlockSessionResult> {
  return request(token, `/api/unlock-sessions/${encodeURIComponent(sessionId)}/replacements`, {
    method: "POST",
  });
}

export interface PostingDecisionResult {
  ok: true;
  job_posting_id: string;
  session: SessionProgress | null;
}

export function markApplied(token: string, jobPostingId: string): Promise<PostingDecisionResult> {
  return request(token, "/api/mark-applied", {
    method: "POST",
    body: JSON.stringify({ job_posting_id: jobPostingId }),
  });
}

/** Puts a handed-out posting back to `new`, detached from its session. */
export function skipPosting(token: string, jobPostingId: string): Promise<PostingDecisionResult> {
  return request(token, "/api/skip-posting", {
    method: "POST",
    body: JSON.stringify({ job_posting_id: jobPostingId }),
  });
}

export function getExtensionConfig(token: string): Promise<ExtensionConfig> {
  return request(token, "/api/extension-config");
}

/** Returns the config as it landed server-side, not as it was requested. */
export function updateEpisodeRequiredCount(
  token: string,
  count: number,
): Promise<ExtensionConfig> {
  return request(token, "/api/extension-config", {
    method: "PATCH",
    body: JSON.stringify({ episode_required_count: count }),
  });
}
