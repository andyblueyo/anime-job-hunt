import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

/**
 * Polled every ~5s by the lock-overlay content script while a session is
 * active. Stands in for the Realtime subscription the architecture doc
 * originally called for — see the Phase 2 plan for why: Realtime needs a
 * real Supabase JWT, and the extension only carries a static app token this
 * phase.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const { id } = await params;
  const db = await getDb();
  const userId = await getUserId();

  const { data: session, error: sessionError } = await db
    .from("unlock_sessions")
    .select("id, required_count, status, snooze_until, snooze_count, created_at, completed_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionError) {
    return Response.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session) {
    return Response.json({ error: "Unlock session not found." }, { status: 404 });
  }

  const { count: appliedCount, error: countError } = await db
    .from("applications")
    .select("id, job_postings!inner(session_id)", { count: "exact", head: true })
    .eq("job_postings.session_id", id);
  if (countError) {
    return Response.json({ error: countError.message }, { status: 500 });
  }

  return Response.json({
    ...session,
    applied_count: appliedCount ?? 0,
  });
}
