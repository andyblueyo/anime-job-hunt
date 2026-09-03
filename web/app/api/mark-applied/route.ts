import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { completeSessionIfDone } from "@/lib/unlock-sessions";

export const dynamic = "force-dynamic";

/** Postgres unique-violation, e.g. re-clicking an already-applied posting. */
const UNIQUE_VIOLATION = "23505";

/**
 * The extension's JSON equivalent of the website's `markApplied` server
 * action (web/app/actions.ts) — same two writes (applications upsert +
 * job_postings status flip), called from the "Mark Applied" button injected
 * into an opened job-posting tab instead of from a form submit. Additionally
 * flips the tied unlock_session to `completed` the moment its count is hit,
 * so the extension doesn't need a second round trip to notice.
 */
export async function POST(request: Request) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  let body: { job_posting_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  const jobPostingId = body.job_posting_id;
  if (typeof jobPostingId !== "string" || !jobPostingId) {
    return Response.json({ error: "job_posting_id is required." }, { status: 400 });
  }

  const db = await getDb();
  const userId = await getUserId();

  const { data: posting, error: postingError } = await db
    .from("job_postings")
    .select("id, session_id, status")
    .eq("id", jobPostingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (postingError) {
    return Response.json({ error: postingError.message }, { status: 500 });
  }
  if (!posting) {
    return Response.json({ error: "Job posting not found." }, { status: 404 });
  }

  const { error: applicationError } = await db.from("applications").upsert(
    {
      user_id: userId,
      job_posting_id: jobPostingId,
      method: "auto-tab",
      applied_at: new Date().toISOString(),
    },
    { onConflict: "job_posting_id", ignoreDuplicates: true },
  );
  if (applicationError && applicationError.code !== UNIQUE_VIOLATION) {
    return Response.json({ error: applicationError.message }, { status: 500 });
  }

  const { error: statusError } = await db
    .from("job_postings")
    .update({ status: "applied" })
    .eq("id", jobPostingId);
  if (statusError) {
    return Response.json({ error: statusError.message }, { status: 500 });
  }

  // Shared with the /queue server action so both paths clear the lock.
  const session = await completeSessionIfDone(db, jobPostingId);

  return Response.json({ ok: true, job_posting_id: jobPostingId, session });
}
