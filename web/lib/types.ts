// Row shapes for the `anime_jobs` schema. Kept hand-written (rather than
// generated) so the app has no dependency on the Supabase CLI; the source of
// truth is migrations/20260903_create_anime_jobs_tables.sql.

export type PostingStatus = "new" | "queued" | "applied" | "skipped" | "rejected";
export type PostingSource = "scraped" | "manual";
export type SessionStatus = "locked" | "snoozed" | "completed";
export type ApplicationMethod = "auto-tab" | "manual";
export type BoardSourceType = "structured_data" | "custom_selector" | "api";

export interface JobPosting {
  id: string;
  user_id: string;
  company: string;
  title: string;
  url: string;
  location: string | null;
  source: PostingSource;
  source_board: string | null;
  session_id: string | null;
  posted_date: string | null;
  salary_range: string | null;
  status: PostingStatus;
  scraped_at: string | null;
  created_at: string;
}

export interface Application {
  id: string;
  user_id: string;
  job_posting_id: string;
  applied_at: string;
  method: ApplicationMethod;
  resume_version: string | null;
  notes: string | null;
  follow_up_date: string | null;
  outcome: string | null;
}

export interface UnlockSession {
  id: string;
  user_id: string;
  required_count: number;
  status: SessionStatus;
  snooze_until: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Settings {
  user_id: string;
  target_roles: string[];
  target_locations: string[];
  excluded_companies: string[];
  tab_cap_per_hour: number;
  default_anime_mode: boolean;
  near_end_threshold_seconds: number;
  snooze_minutes: number;
  episode_required_count: number;
  updated_at: string;
}

export interface JobBoard {
  id: string;
  owner_user_id: string | null;
  name: string;
  url: string;
  source_type: BoardSourceType;
  scrape_config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

/**
 * A posting with its application embedded.
 *
 * `applications.job_posting_id` is UNIQUE, so PostgREST resolves this as a
 * one-to-one relationship and returns an object or null — not the array you'd
 * get from a plain one-to-many embed.
 */
export type JobPostingWithApplication = JobPosting & {
  applications: Pick<Application, "applied_at" | "method"> | null;
};

export const POSTING_STATUSES: PostingStatus[] = [
  "new",
  "queued",
  "applied",
  "skipped",
  "rejected",
];

export function isPostingStatus(value: unknown): value is PostingStatus {
  return POSTING_STATUSES.includes(value as PostingStatus);
}
