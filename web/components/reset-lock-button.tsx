"use client";

import { DemoTag } from "@/components/ui";

/**
 * RESET LOCK on the dashboard's active-lock card. There is no endpoint for
 * this yet, so the handler is a visibly inert stub: it logs and does nothing
 * else. Deliberately no optimistic UI — the card must not change on click.
 *
 * Wiring: replace `resetLockStub` with a server action / route call and drop
 * the `demo` prop (default true while unwired).
 */
export function ResetLockButton({ demo = true }: { demo?: boolean }) {
  function resetLockStub() {
    console.debug("[next.ep.lock] RESET LOCK is not wired: no endpoint resets an unlock session yet.");
  }

  return (
    <button type="button" className="pill pill-ghost" onClick={resetLockStub}>
      reset lock
      {demo ? <DemoTag /> : null}
    </button>
  );
}
