import Link from "next/link";
import {
  Card,
  EmptyState,
  ErrorNote,
  SectionHeading,
  SegmentedBar,
  StatTile,
  formatDate,
} from "@/components/ui";
import { getDb } from "@/lib/supabase/server";
import {
  POSTING_STATUSES,
  type ApplicationMethod,
  type PostingStatus,
  type UnlockSession,
} from "@/lib/types";

// Live database reads on every request — never prerender or cache this page.
export const dynamic = "force-dynamic";

type RecentApplication = {
  id: string;
  applied_at: string;
  method: ApplicationMethod;
  job_postings: { company: string; title: string; url: string } | null;
};

type Overview = {
  counts: Record<PostingStatus, number>;
  totalPostings: number;
  appliedThisWeek: number;
  recent: RecentApplication[];
  session: (UnlockSession & { progress: number }) | null;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function load(): Promise<Overview> {
  const db = await getDb();
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();

  const [statuses, thisWeek, recent, sessions] = await Promise.all([
    db.from("job_postings").select("status").returns<{ status: PostingStatus }[]>(),
    db
      .from("applications")
      .select("id", { count: "exact", head: true })
      .gte("applied_at", weekAgo),
    db
      .from("applications")
      .select("id, applied_at, method, job_postings(company, title, url)")
      .order("applied_at", { ascending: false })
      .limit(5)
      .returns<RecentApplication[]>(),
    // The extension opens a session per episode; at most one should be live.
    db
      .from("unlock_sessions")
      .select("*")
      .in("status", ["locked", "snoozed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .returns<UnlockSession[]>(),
  ]);

  for (const result of [statuses, thisWeek, recent, sessions]) {
    if (result.error) throw new Error(result.error.message);
  }

  const counts = {} as Record<PostingStatus, number>;
  for (const s of POSTING_STATUSES) counts[s] = 0;
  for (const row of statuses.data ?? []) counts[row.status] += 1;

  const live = sessions.data?.[0] ?? null;
  let session: Overview["session"] = null;

  if (live) {
    // Applications don't carry a session id — their posting does.
    const { count, error } = await db
      .from("applications")
      .select("id, job_postings!inner(session_id)", { count: "exact", head: true })
      .eq("job_postings.session_id", live.id);
    if (error) throw new Error(error.message);
    session = { ...live, progress: count ?? 0 };
  }

  return {
    counts,
    totalPostings: statuses.data?.length ?? 0,
    appliedThisWeek: thisWeek.count ?? 0,
    recent: recent.data ?? [],
    session,
  };
}

export default async function DashboardPage() {
  let overview: Overview | null = null;
  let error: string | null = null;
  try {
    overview = await load();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Dashboard</p>
        <h1 className="mt-2 text-3xl font-bold">
          One episode, <span className="text-magenta">five applications</span>
        </h1>
      </header>

      {error ? (
        <ErrorNote>
          {error}
          <br />
          <span className="text-dim">
            Check <code>web/.env.local</code> against <code>web/.env.local.example</code>.
          </span>
        </ErrorNote>
      ) : null}

      {overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Open queue"
              value={overview.counts.new + overview.counts.queued}
              hint={`${overview.counts.queued} lined up, ${overview.counts.new} untriaged`}
            />
            <StatTile
              label="Applied"
              value={overview.counts.applied}
              accent="teal"
              hint="all time"
            />
            <StatTile
              label="This week"
              value={overview.appliedThisWeek}
              accent="magenta"
              hint="applications sent"
            />
            <StatTile
              label="Postings tracked"
              value={overview.totalPostings}
              hint={`${overview.counts.skipped} skipped`}
            />
          </div>

          <Card>
            <SectionHeading eyebrow="Lock status" />
            {overview.session ? (
              <div className="space-y-3">
                <p className="text-sm text-haze">
                  {overview.session.status === "snoozed"
                    ? "Snoozed — the lock comes back shortly."
                    : "Locked until the count is met."}
                </p>
                <SegmentedBar
                  filled={overview.session.progress}
                  total={overview.session.required_count}
                />
                <p className="text-sm">
                  <span className="font-bold tabular-nums">
                    {overview.session.progress}
                  </span>
                  <span className="text-dim">
                    {" "}
                    / {overview.session.required_count} applications
                  </span>
                </p>
              </div>
            ) : (
              <p className="text-sm text-haze">
                No active lock. The extension opens one when an episode ends.
              </p>
            )}
          </Card>

          <Card>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <p className="eyebrow">Recent applications</p>
              <Link href="/queue?status=applied" className="underline-hover text-sm text-haze">
                See all
              </Link>
            </div>

            {overview.recent.length === 0 ? (
              <EmptyState>
                Nothing sent yet.{" "}
                <Link href="/queue" className="underline-hover text-glow">
                  Start with the queue
                </Link>
                .
              </EmptyState>
            ) : (
              <ul className="divide-y divide-white/8">
                {overview.recent.map((application) => (
                  <li
                    key={application.id}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">
                        {application.job_postings?.title ?? "Deleted posting"}
                      </p>
                      <p className="truncate text-xs text-dim">
                        {application.job_postings?.company ?? "—"} ·{" "}
                        {application.method === "auto-tab" ? "from a lock" : "by hand"}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-haze tabular-nums">
                      {formatDate(application.applied_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
