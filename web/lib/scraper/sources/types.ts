import type { JobBoard } from "@/lib/types";
import type { FetchOptions } from "../http";

/** One job as an adapter found it, before dedupe and filtering. */
export interface Candidate {
  title: string;
  company: string | null;
  /** As published; the run canonicalizes it (lib/scraper/normalize.ts). */
  url: string;
  location: string | null;
  remote: boolean;
  /** Annual figures, or null when unknown / not annual. */
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  /** Free-text salary when the source only had that. */
  salary_text: string | null;
  posted_at: string | null;
  closes_at: string | null;
}

/** Wall-clock budget for one scraper run (a serverless invocation has a hard cap). */
export interface Budget {
  remainingMs(): number;
  exhausted(): boolean;
}

export interface SourceContext {
  board: JobBoard;
  /** Roles to search for on keyword-search APIs. Boards that list everything ignore it. */
  targetRoles: string[];
  budget: Budget;
  /**
   * True when a canonical URL is already in job_postings or the rejection log.
   * Detail-page adapters use it to skip fetching pages they've already seen.
   */
  seen(url: string): boolean;
  fetchText(url: string, init?: RequestInit, options?: FetchOptions): Promise<string>;
  fetchJson<T>(url: string, init?: RequestInit, options?: FetchOptions): Promise<T>;
}

export interface SourceResult {
  candidates: Candidate[];
  /** The adapter stopped early (budget, fetch cap) with more left on the board. */
  partial: boolean;
  /** Set when the adapter did nothing on purpose (e.g. missing credentials). */
  skipped?: string;
  notes?: Record<string, unknown>;
}

export type Adapter = (ctx: SourceContext) => Promise<SourceResult>;

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
