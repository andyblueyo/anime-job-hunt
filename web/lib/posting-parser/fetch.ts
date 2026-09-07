// Hardened fetch for user-pasted URLs. The URL comes straight from a form
// field, and the request leaves from our server, so this is the one place in
// the app that must not be talked into reaching something internal.
//
//   - http(s) only
//   - hostname must not resolve to loopback, link-local, or private space —
//     checked on every hop of a redirect chain, not just the first URL
//   - at most MAX_REDIRECTS hops, MAX_BYTES of body, TIMEOUT_MS wall clock
//   - Content-Type must be HTML
//
// DNS is resolved here and then again by fetch() itself, so a hostname whose
// record flips between the two lookups could slip past (classic rebinding).
// Closing that needs pinning the connection to the checked IP, which Node's
// fetch doesn't expose. Acceptable for a single-user tool; noted so nobody
// mistakes this for a complete guard when the app goes multi-tenant.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { USER_AGENT } from "@/lib/scraper/http";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 8_000;

export type FetchFailureKind =
  | "invalid_url"
  | "blocked_target"
  | "timeout"
  | "network"
  | "http_error"
  | "not_html";

export class FetchFailure extends Error {
  constructor(
    readonly kind: FetchFailureKind,
    message: string,
    readonly status: number | null = null,
    readonly contentType: string | null = null,
  ) {
    super(message);
    this.name = "FetchFailure";
  }
}

export interface FetchedPage {
  html: string;
  /** Where the chain ended, after redirects. */
  finalUrl: string;
  status: number;
  /** True when the body was cut at MAX_BYTES. */
  truncated: boolean;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export interface FetchDeps {
  fetch?: typeof fetch;
  resolve?: Resolver;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base) as number;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable: refuse
  return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expand an IPv6 literal to 8 hextets, or null if it isn't one. */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // ::ffff:1.2.3.4 — pull the embedded IPv4 out and let the v4 rules judge it.
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) {
    const n = ipv4ToInt(mapped[1]);
    if (n === null) return null;
    return [0, 0, 0, 0, 0, 0xffff, n >>> 16, n & 0xffff];
  }
  const zoneAt = text.indexOf("%");
  if (zoneAt !== -1) text = text.slice(0, zoneAt);
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPrivateV6(ip: string): boolean {
  const groups = expandV6(ip);
  if (!groups) return true;
  const [g0, , , , , g5, g6, g7] = groups;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    // v4-mapped
    return isPrivateV4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for any address a pasted job URL has no business reaching. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true;
}

function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localdomain") ||
    h === "metadata.google.internal" ||
    h === "instance-data"
  );
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchFailure("invalid_url", "That doesn't look like a URL — include https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchFailure("invalid_url", "Only http and https links can be fetched.");
  }
  if (url.username || url.password) {
    throw new FetchFailure("invalid_url", "Links with embedded credentials aren't fetched.");
  }
  return url;
}

const defaultResolve: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * Throws FetchFailure("blocked_target") when `url` points anywhere private.
 * Exported for tests, which pass a fake resolver.
 */
export async function assertPublicTarget(url: URL, resolve: Resolver = defaultResolve): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const blocked = () =>
    new FetchFailure("blocked_target", "That link points at a private or local address, which can't be fetched.");
  if (isForbiddenHostname(hostname)) throw blocked();
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw blocked();
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new FetchFailure("network", `Couldn't look up ${hostname}.`);
  }
  if (addresses.length === 0) throw new FetchFailure("network", `Couldn't look up ${hostname}.`);
  if (addresses.some(isPrivateAddress)) throw blocked();
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

function isHtml(contentType: string | null): boolean {
  if (!contentType) return true; // no header: sniff the body instead
  return /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

async function readCapped(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: await response.text(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > MAX_BYTES) {
        chunks.push(value.subarray(0, MAX_BYTES - total));
        total = MAX_BYTES;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

/**
 * Fetch one page for parsing. Every failure is a FetchFailure whose `kind`
 * the caller turns into a one-line message; nothing here is retried.
 */
export async function fetchPostingHtml(raw: string, deps: FetchDeps = {}): Promise<FetchedPage> {
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? defaultResolve;

  let url = parseHttpUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      await assertPublicTarget(url, resolve);

      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          redirect: "manual",
          signal: controller.signal,
          cache: "no-store",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "Accept-Language": "en-US,en;q=0.8",
          },
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new FetchFailure("timeout", `Gave up after ${TIMEOUT_MS / 1000}s waiting for the page.`);
        }
        throw new FetchFailure(
          "network",
          `Couldn't reach ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new FetchFailure("http_error", `Redirect with no destination (HTTP ${response.status}).`, response.status);
        if (hop >= MAX_REDIRECTS) throw new FetchFailure("network", `Too many redirects (more than ${MAX_REDIRECTS}).`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchFailure("http_error", "Redirected to an invalid address.", response.status);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new FetchFailure("blocked_target", "Redirected to a non-web address.", response.status);
        }
        url = next;
        continue;
      }

      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchFailure("http_error", `The page answered HTTP ${response.status}.`, response.status, contentType);
      }
      if (!isHtml(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchFailure("not_html", `That link returned ${contentType?.split(";")[0].trim()}, not a web page.`, response.status, contentType);
      }

      let text: string;
      let truncated: boolean;
      try {
        ({ text, truncated } = await readCapped(response, controller.signal));
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new FetchFailure("timeout", `Gave up after ${TIMEOUT_MS / 1000}s waiting for the page.`);
        }
        throw new FetchFailure("network", "The connection dropped while reading the page.");
      }
      if (!contentType && !/^\s*(<!doctype\s+html|<html|<head|<meta|<script|<title)/i.test(text.slice(0, 2000))) {
        throw new FetchFailure("not_html", "That link didn't return a web page.", response.status, null);
      }
      return { html: text, finalUrl: url.toString(), status: response.status, truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}
