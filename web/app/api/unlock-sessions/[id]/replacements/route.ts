import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import {
  claimPostings,
  countSessionApplications,
  countSessionOutstanding,
  selectFreshPostings,
  selectReofferPostings,
  toWirePosting,
} from "@/lib/unlock-sessions";

export const dynamic = "force-dynamic";

/**
 * Refill a session that can no longer reach its count on its own.
 *
 * At creation, required_count = the postings claimed, so applied + outstanding
 * = required and nothing is missing. The only thing that opens a gap is a
 * Skip (POST /api/skip-posting): the posting goes back to `new`, detached,
 * and the session is one short. This route claims that shortfall —
 * required_count - applied - outstanding — and never touches required_count
 * itself. Creation is the only writer of that number; this just fills back up
 * to it, so the two routes can't disagree about the target.
 *
 * Order of preference:
 *   1. fresh — `new` postings this session hasn't declined (including ones
 *      skipped from *earlier* sessions, which are fair game again);
 *   2. re-offer — `new` postings this session itself skipped, only for
 *      whatever the fresh pool couldn't cover. Claiming is oldest-first and a
 *      skipped posting is older than anything left unclaimed, so without this
 *      split a Skip would hand the same tab straight back every time.
 *
 * When both pools are empty the response is 200 with `postings: []` and an
 * `unfilled` count: the session stays locked at its snapshot target, and the
 * ways out are adding postings (the /queue page's manual add, later the
 * scraper) and calling this again, applying to something, or snoozing.
 * Lowering the target here would turn Skip into a free unlock.
 *
 * Deliberately NOT counted against settings.tab_cap_per_hour: that cap stops
 * a binge night stacking sessions, and this doesn't create one. Rate-limiting
 * it would just rebuild the deadlock through a different door.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const db = await getDb();
    const userId = await getUserId();

    const { data: session, error: sessionError } = await db
      .from("unlock_sessions")
      .select("id, required_count, status")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (sessionError) {
      return Response.json({ error: sessionError.message }, { status: 500 });
    }
    if (!session) {
      return Response.json({ error: "Unlock session not found." }, { status: 404 });
    }
    if (session.status === "completed") {
      return Response.json({ error: "This session is already completed." }, { status: 409 });
    }

    const [applied, outstanding] = await Promise.all([
      countSessionApplications(db, session.id),
      countSessionOutstanding(db, session.id),
    ]);
    const shortfall = Math.max(session.required_count - applied - outstanding, 0);

    const respond = (postings: ReturnType<typeof toWirePosting>[], reoffered: number) =>
      Response.json({
        session_id: session.id,
        required_count: session.required_count,
        status: session.status,
        shortfall,
        unfilled: shortfall - postings.length,
        reoffered,
        postings,
      });

    if (shortfall === 0) return respond([], 0);

    // Use session.id (from the row) rather than the raw path param inside
    // the PostgREST filter string.
    const fresh = await claimPostings(
      db,
      session.id,
      (await selectFreshPostings(db, userId, shortfall, session.id)).map((p) => p.id),
    );

    const stillShort = shortfall - fresh.length;
    const reoffered =
      stillShort > 0
        ? await claimPostings(
            db,
            session.id,
            (await selectReofferPostings(db, userId, stillShort, session.id)).map((p) => p.id),
          )
        : [];

    return respond([...fresh, ...reoffered].map(toWirePosting), reoffered.length);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
