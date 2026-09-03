import { getDb, getUserId } from "@/lib/supabase/server";
import { requireExtensionToken } from "@/lib/extension-auth";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Snoozes are unlimited but tracked (decision from the Phase 2 plan) —
 * snooze_count just increments every call, shown back on the lock screen as
 * "SNOOZED Nx THIS SESSION" and, later, as a dashboard self-accountability
 * stat. The background script schedules a chrome.alarms wake for
 * snooze_until to re-show the overlay; this route only owns the DB state.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireExtensionToken(request);
  if (authError) return authError;

  const { id } = await params;
  const db = await getDb();
  const userId = await getUserId();
  const settings = await getSettings(db, userId);

  const { data: current, error: fetchError } = await db
    .from("unlock_sessions")
    .select("id, status, snooze_count")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 });
  }
  if (!current) {
    return Response.json({ error: "Unlock session not found." }, { status: 404 });
  }
  if (current.status === "completed") {
    return Response.json({ error: "This session is already completed." }, { status: 409 });
  }

  const snoozeUntil = new Date(Date.now() + settings.snooze_minutes * 60 * 1000).toISOString();

  const { data: updated, error: updateError } = await db
    .from("unlock_sessions")
    .update({
      status: "snoozed",
      snooze_until: snoozeUntil,
      snooze_count: current.snooze_count + 1,
    })
    .eq("id", id)
    .select("id, status, snooze_until, snooze_count")
    .single();
  if (updateError || !updated) {
    return Response.json(
      { error: updateError?.message ?? "Could not snooze session." },
      { status: 500 },
    );
  }

  return Response.json(updated);
}
