import Link from "next/link";
import { ResetLockButton } from "@/components/reset-lock-button";
import {
  ApplicationStatusChip,
  DemoTag,
  EmptyState,
  ErrorNote,
  Grain,
  SegmentedBar,
  Sparkle,
  StatTile,
  Tone,
  Wash,
  formatDate,
} from "@/components/ui";
import {
  PLACEHOLDER_STREAK,
  PLACEHOLDER_WAITING_EPISODE,
} from "@/lib/placeholder-data";
import { getDb } from "@/lib/supabase/server";
import {
  POSTING_STATUSES,
  type ApplicationMethod,
  type PostingStatus,
  type SessionStatus,
  type UnlockSession,
} from "@/lib/types";

// Live database reads on every request — never prerender or cache this page.
export const dynamic = "force-dynamic";

type RecentApplication = {
  id: string;
  applied_at: string;
  method: ApplicationMethod;
  outcome: string | null;
  job_postings: { company: string; title: string; url: string } | null;
};

type Overview = {
  counts: Record<PostingStatus, number>;
  totalPostings: number;
  appliedThisWeek: number;
  /** Completed unlock sessions, i.e. episodes earned. */
  episodesUnlocked: number;
  /** Snoozes spent across every session. */
  snoozesSpent: number;
  recent: RecentApplication[];
  session: (UnlockSession & { progress: number }) | null;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function load(): Promise<Overview> {
  const db = await getDb();
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();

  const [statuses, thisWeek, recent, sessions, allSessions] = await Promise.all(
    [
      db
        .from("job_postings")
        .select("status")
        .returns<{ status: PostingStatus }[]>(),
      db
        .from("applications")
        .select("id", { count: "exact", head: true })
        .gte("applied_at", weekAgo),
      db
        .from("applications")
        .select(
          "id, applied_at, method, outcome, job_postings(company, title, url)",
        )
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
      db
        .from("unlock_sessions")
        .select("status, snooze_count")
        .returns<{ status: SessionStatus; snooze_count: number }[]>(),
    ],
  );

  for (const result of [statuses, thisWeek, recent, sessions, allSessions]) {
    if (result.error) throw new Error(result.error.message);
  }

  const counts = {} as Record<PostingStatus, number>;
  for (const s of POSTING_STATUSES) counts[s] = 0;
  for (const row of statuses.data ?? []) counts[row.status] += 1;

  let episodesUnlocked = 0;
  let snoozesSpent = 0;
  for (const row of allSessions.data ?? []) {
    if (row.status === "completed") episodesUnlocked += 1;
    snoozesSpent += row.snooze_count ?? 0;
  }

  const live = sessions.data?.[0] ?? null;
  let session: Overview["session"] = null;

  if (live) {
    // Applications don't carry a session id — their posting does.
    const { count, error } = await db
      .from("applications")
      .select("id, job_postings!inner(session_id)", {
        count: "exact",
        head: true,
      })
      .eq("job_postings.session_id", live.id);
    if (error) throw new Error(error.message);
    session = { ...live, progress: count ?? 0 };
  }

  return {
    counts,
    totalPostings: statuses.data?.length ?? 0,
    appliedThisWeek: thisWeek.count ?? 0,
    episodesUnlocked,
    snoozesSpent,
    recent: recent.data ?? [],
    session,
  };
}

const HERO_TONE_MASK = [
  "radial-gradient(circle 200px at 96% 150%, #000 0 10%, rgba(0,0,0,0.5) 42%, transparent 90%)",
  "radial-gradient(circle 140px at 76% 164%, #000 0 12%, rgba(0,0,0,0.45) 46%, transparent 90%)",
  "radial-gradient(circle 100px at 60% 172%, #000 0 14%, rgba(0,0,0,0.4) 48%, transparent 90%)",
  "radial-gradient(circle 170px at 112% -20%, #000 0 10%, rgba(0,0,0,0.38) 44%, transparent 88%)",
].join(", ");

const LOCK_TONE_MASK = [
  "radial-gradient(circle 170px at -4% 150%, #000 0 10%, rgba(0,0,0,0.5) 42%, transparent 90%)",
  "radial-gradient(circle 110px at 14% 164%, #000 0 12%, rgba(0,0,0,0.42) 46%, transparent 90%)",
  "radial-gradient(circle 180px at 103% 148%, #000 0 10%, rgba(0,0,0,0.45) 42%, transparent 90%)",
].join(", ");

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The card for the one live unlock session (or the lack of one). Takes the
 * episode line as a prop with the placeholder as its default: wiring it is
 * passing the real title and dropping `demo`.
 */
function ActiveLockCard({
  session,
  waitingEpisode = PLACEHOLDER_WAITING_EPISODE,
  demo = true,
}: {
  session: Overview["session"];
  waitingEpisode?: string;
  demo?: boolean;
}) {
  const tag = !session
    ? "unlocked"
    : session.status === "snoozed"
      ? "snoozed"
      : "locked";
  const remaining = session
    ? Math.max(session.required_count - session.progress, 0)
    : 0;

  let line: string;
  if (!session) {
    line = "No active lock. The extension opens one when an episode ends.";
  } else if (session.status === "snoozed") {
    line = `Snoozed. ${plural(remaining, "more application")} to unlock.`;
  } else if (remaining === 0) {
    line = "Count met. Go watch it.";
  } else {
    line = `${plural(remaining, "more application")} to unlock.`;
  }

  return (
    <section className="card card-recessed relative flex flex-wrap items-center gap-x-8 gap-y-6 overflow-hidden p-[clamp(20px,2.4vw,30px)]">
      <Tone mask={LOCK_TONE_MASK} dark />

      <div className="relative min-w-0 flex-[1_1_300px]">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <p className="eyebrow">active lock</p>
          <span
            className={`badge ${tag === "locked" || tag === "snoozed" ? "badge-spot" : ""}`}
          >
            {tag}
          </span>
        </div>

        <p className="mt-4 text-[clamp(21px,2.3vw,30px)] font-bold leading-tight tracking-[-0.015em] text-balance">
          {line}
        </p>

        <p className="mono mt-2 flex flex-wrap items-center text-[11px] normal-case tracking-[0.06em] text-[#4A4740]">
          {waitingEpisode}
          {demo ? <DemoTag /> : null}
        </p>

        {session ? (
          <SegmentedBar
            filled={session.progress}
            total={session.required_count}
            className="mt-[18px] max-w-[360px]"
          />
        ) : null}
      </div>

      <div className="relative flex flex-none flex-col gap-2">
        <Link href="/queue" className="pill pill-primary">
          open job queue
        </Link>
        <ResetLockButton />
      </div>
    </section>
  );
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
    <div className="card relative grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 overflow-hidden p-3">
      <Grain />

      {/* Dark hero: brand copy over tone blooms. Decoration stays right and low. */}
      <header className="card card-dark relative col-span-full overflow-hidden px-[clamp(20px,2.8vw,38px)] pb-[clamp(30px,3.6vw,48px)] pt-[clamp(20px,2.6vw,34px)]">
        <Tone mask={HERO_TONE_MASK} />
        <Wash />
        <Sparkle
          five
          style={{
            bottom: "4%",
            right: "-7%",
            width: "clamp(110px,13vw,190px)",
            aspectRatio: "1",
            transform: "rotate(-7deg)",
          }}
          duration={5.2}
        />
        <Sparkle
          style={{
            top: "26%",
            right: "17%",
            width: "clamp(20px,2.2vw,30px)",
            aspectRatio: "1",
            transform: "rotate(10deg)",
          }}
          duration={6.8}
          delay={1.4}
        />
        <p className="eyebrow relative text-muted-2">dashboard</p>
        <h1 className="display relative mt-[clamp(16px,2vw,26px)] max-w-[19ch] text-[clamp(28px,4vw,54px)] text-paper">
          Unemployed or a weeb?
        </h1>
        <p className="relative mt-3 max-w-[38ch] text-[clamp(13px,1.3vw,15px)] leading-relaxed text-muted-3">
          You can&apos;t do both. Only watch the next episode once the count is
          met.
        </p>
      </header>

      {error ? (
        <div className="col-span-full">
          <ErrorNote>
            {error}
            <br />
            <span className="text-muted-2">
              Check <code>web/.env.local</code> against{" "}
              <code>web/.env.local.example</code>.
            </span>
          </ErrorNote>
        </div>
      ) : null}

      {overview ? (
        <>
          <div className="col-span-full grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="open queue"
              value={overview.counts.new + overview.counts.queued}
              note={`${overview.counts.queued} lined up • ${overview.counts.new} untriaged`}
            />
            <StatTile
              label="applied"
              value={overview.counts.applied}
              note={`all time • ${overview.appliedThisWeek} this week`}
            />
            <StatTile
              label="unlocked"
              value={overview.episodesUnlocked}
              note={`episodes • ${plural(overview.snoozesSpent, "snooze")} spent`}
            />
            <StatTile
              label="tracked"
              value={overview.totalPostings}
              note={`postings • ${overview.counts.skipped} skipped`}
            />
            {/* Placeholder: no streak model exists. Drop `demo` when it does. */}
            <StatTile
              label="day streak"
              value={PLACEHOLDER_STREAK.days}
              note={`days • best run ${PLACEHOLDER_STREAK.best}`}
              demo
            />
          </div>

          <div className="col-span-full">
            <ActiveLockCard session={overview.session} />
          </div>

          <section className="card col-span-full px-[clamp(18px,2.4vw,28px)] pb-1.5 pt-[clamp(18px,2.2vw,26px)]">
            <div className="flex items-baseline justify-between gap-3.5 border-b border-[rgba(26,26,24,0.28)] pb-3">
              <p className="eyebrow">recent applications</p>
              <Link
                href="/queue?status=applied"
                className="mono text-[11px] tracking-[0.12em] text-muted hover:text-spot"
              >
                see all
              </Link>
            </div>

            {overview.recent.length === 0 ? (
              <div className="py-4">
                <EmptyState>
                  Nothing sent yet.{" "}
                  <Link href="/queue" className="underline-hover text-ink">
                    Start with the queue
                  </Link>
                  .
                </EmptyState>
              </div>
            ) : (
              <ul>
                {overview.recent.map((application) => (
                  <li
                    key={application.id}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-b border-line-faint py-4 transition-colors last:border-b-0 hover:bg-paper-2"
                  >
                    <div className="min-w-0 flex-[1_1_250px]">
                      <p className="truncate text-[15.5px] font-medium leading-snug text-ink">
                        {application.job_postings?.title ?? "Deleted posting"}
                      </p>
                      <p className="mono mt-1.5 truncate text-[11px] tracking-[0.1em] text-muted">
                        {application.job_postings?.company ?? "-"} •{" "}
                        {application.method === "auto-tab"
                          ? "from a lock"
                          : "by hand"}
                      </p>
                    </div>
                    <ApplicationStatusChip outcome={application.outcome} />
                    <span className="mono w-14 text-right text-[12px] tracking-[0.06em] text-muted-2 tabular-nums">
                      {formatDate(application.applied_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
