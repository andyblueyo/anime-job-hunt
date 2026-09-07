// fetch() with the things every adapter needs: an honest User-Agent, a
// timeout, no caching, and a loud error on non-2xx. Kept apart from run.ts so
// the adapters can be driven without a database (see the dry-run harness).

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchOptions {
  /** Per-request cap. Sources that build their whole payload on demand need more. */
  timeoutMs?: number;
}

export const USER_AGENT =
  "Mozilla/5.0 (compatible; NextEpLock/0.1; personal job-search tool; +https://github.com/andyblueyo/anime-job-hunt)";

export async function fetchText(
  url: string,
  init: RequestInit = {},
  options: FetchOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...(init.headers ?? {}) },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  options: FetchOptions = {},
): Promise<T> {
  const text = await fetchText(
    url,
    { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } },
    options,
  );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}, got ${text.slice(0, 80)}…`);
  }
}

/** Wall-clock budget for one run — a serverless invocation has a hard cap. */
export function makeBudget(ms: number) {
  const deadline = Date.now() + ms;
  return {
    remainingMs: () => Math.max(0, deadline - Date.now()),
    exhausted: () => Date.now() >= deadline,
  };
}
