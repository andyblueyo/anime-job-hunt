import Link from "next/link";
import { AddPostingForm } from "@/components/add-posting-form";
import { PostingRow } from "@/components/posting-row";
import { Card, EmptyState, ErrorNote, SectionHeading } from "@/components/ui";
import { getDb, getUserId } from "@/lib/supabase/server";
import { meetsSalaryFloor, type SalaryFloor } from "@/lib/salary";
import { getSettings } from "@/lib/settings";
import {
  POSTING_STATUSES,
  isPostingStatus,
  type JobPostingWithApplication,
  type PostingStatus,
} from "@/lib/types";

// Live database reads on every request — never prerender or cache this page.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

type Loaded = {
  postings: JobPostingWithApplication[];
  counts: Record<PostingStatus | "all", number>;
  salaryFloor: SalaryFloor | null;
};

async function load(status: PostingStatus | null): Promise<Loaded> {
  const db = await getDb();
  const userId = await getUserId();

  let query = db
    .from("job_postings")
    .select("*, applications(applied_at, method)")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (status) query = query.eq("status", status);

  const [list, all, settings] = await Promise.all([
    query.returns<JobPostingWithApplication[]>(),
    db.from("job_postings").select("status").returns<{ status: PostingStatus }[]>(),
    // Settings failing (an unapplied migration) shouldn't take the queue down.
    getSettings(db, userId).catch(() => null),
  ]);

  if (list.error) throw new Error(list.error.message);
  if (all.error) throw new Error(all.error.message);

  const counts = { all: all.data.length } as Record<PostingStatus | "all", number>;
  for (const s of POSTING_STATUSES) counts[s] = 0;
  for (const row of all.data) counts[row.status] += 1;

  const salaryFloor: SalaryFloor | null =
    settings?.salary_min != null
      ? { min: settings.salary_min, currency: settings.salary_currency }
      : null;

  // Salary is a preference, not a filter: it ranks. Postings that state a
  // range meeting the floor float up; everything else keeps its date order.
  const postings = salaryFloor
    ? [...list.data].sort(
        (a, b) =>
          Number(meetsSalaryFloor(b.salary_range, salaryFloor)) -
          Number(meetsSalaryFloor(a.salary_range, salaryFloor)),
      )
    : list.data;

  return { postings, counts, salaryFloor };
}

export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  const { status: raw } = await searchParams;
  const status = isPostingStatus(raw) ? raw : null;

  let loaded: Loaded | null = null;
  let error: string | null = null;
  try {
    loaded = await load(status);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Postings queue</p>
        <h1 className="mt-2 text-3xl font-bold">
          What you&apos;re applying to{" "}
          <span className="text-magenta">next</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-haze">
          Everything the scraper finds — plus anything you add by hand — lands here.
          Marking a posting applied is what the lock screen counts.
        </p>
      </header>

      <Card>
        <SectionHeading eyebrow="Add a posting" />
        <AddPostingForm />
      </Card>

      <section>
        <nav className="mb-4 flex flex-wrap gap-2">
          {(["all", ...POSTING_STATUSES] as const).map((tab) => {
            const active = tab === "all" ? status === null : status === tab;
            return (
              <Link
                key={tab}
                href={tab === "all" ? "/queue" : `/queue?status=${tab}`}
                className={`pill pill-sm ${active ? "pill-primary" : "pill-ghost"}`}
              >
                {tab}
                {loaded ? (
                  <span className="tabular-nums opacity-70">{loaded.counts[tab]}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {loaded && loaded.postings.length === 0 ? (
          <EmptyState>
            {status
              ? `Nothing with status “${status}” yet.`
              : "No postings yet — add one above to get started."}
          </EmptyState>
        ) : null}

        {loaded && loaded.postings.length > 0 ? (
          <ul className="space-y-3">
            {loaded.postings.map((posting) => (
              <PostingRow
                key={posting.id}
                posting={posting}
                meetsSalary={meetsSalaryFloor(posting.salary_range, loaded.salaryFloor)}
              />
            ))}
          </ul>
        ) : null}

        {loaded && loaded.postings.length === PAGE_SIZE ? (
          <p className="mt-4 text-xs text-dim">
            Showing the {PAGE_SIZE} most recent postings.
          </p>
        ) : null}
      </section>
    </div>
  );
}
