import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { reportSessionProgress } from "@/lib/unlock-sessions";

export const dynamic = "force-dynamic";

/**
 * The ribbon's "Skip" / the closed-tab prompt's "I didn't" — an explicit
 * decline for a posting an unlock session handed out. Puts the posting back
 * in the pool (`status = 'new'`) and detaches it from the session
 * (`session_id = null`) so a later episode can hand it out again.
 *
 * Clearing session_id matters: POST /api/unlock-sessions selects on
 * `status = 'new'` alone, so a row left pointing at an old session would be
 * handed out again fine — but an application against it would then count
 * toward that long-completed session instead of the one that opened it.
 * `skipped_from_session_id` keeps the provenance instead, without joining
 * into anything: it only steers which postings that session's replacements
 * route reaches for first.
 *
 * Distinct from the /queue page's `skipPosting` action, which sets
 * `status = 'skipped'` — that's "never show me this again"; this is "not
 * right now".
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

  try {
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
    if (posting.status === "applied") {
      // There's an applications row behind this; silently dropping it here
      // would lose data. Reopening an applied posting is the /queue page's
      // job (`reopenPosting`), which deletes the application deliberately.
      return Response.json(
        { error: "This posting is already marked applied. Reopen it from the queue instead." },
        { status: 409 },
      );
    }

    // Remember which session it belonged to before detaching, so the caller
    // still gets that session's progress back — and so that session's
    // replacements can prefer postings it hasn't declined (see
    // selectFreshPostings / selectReofferPostings in lib/unlock-sessions.ts).
    // A posting skipped while not attached to any session leaves the marker
    // as it was.
    const sessionId = posting.session_id as string | null;

    const { error: updateError } = await db
      .from("job_postings")
      .update({
        status: "new",
        session_id: null,
        ...(sessionId ? { skipped_from_session_id: sessionId } : {}),
      })
      .eq("id", jobPostingId);
    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 500 });
    }

    // Null when that session had already completed — reporting it would
    // make the extension clear the current lock (see reportSessionProgress).
    const session = sessionId ? await reportSessionProgress(db, sessionId) : null;
    return Response.json({ ok: true, job_posting_id: jobPostingId, session });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
