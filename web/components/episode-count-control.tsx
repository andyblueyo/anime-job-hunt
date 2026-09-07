"use client";

import { useActionState } from "react";
import { setEpisodeCount, type ActionResult } from "@/app/actions";
import {
  EPISODE_REQUIRED_COUNT_LABELS,
  EPISODE_REQUIRED_COUNT_MAX,
  EPISODE_REQUIRED_COUNT_MIN,
} from "@/lib/settings";

const CHOICES = Array.from(
  { length: EPISODE_REQUIRED_COUNT_MAX - EPISODE_REQUIRED_COUNT_MIN + 1 },
  (_, i) => EPISODE_REQUIRED_COUNT_MIN + i,
);

/**
 * Segmented 1-5 difficulty picker. Each segment is its own submit button
 * carrying the value, so picking a number saves it in one click — no separate
 * "Save" step for a single-field setting.
 */
export function EpisodeCountControl({ current }: { current: number }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    setEpisodeCount,
    null,
  );

  return (
    <form action={action} className="space-y-3">
      <div role="group" aria-label="Applications per episode" className="grid grid-cols-5 gap-2">
        {CHOICES.map((n) => {
          const selected = n === current;
          return (
            <button
              key={n}
              type="submit"
              name="episode_required_count"
              value={n}
              aria-pressed={selected}
              disabled={pending}
              className="flex flex-col items-center gap-1.5 border px-2 py-3 transition disabled:opacity-60"
              style={
                selected
                  ? { borderColor: "var(--ink)", backgroundColor: "var(--ink)" }
                  : { borderColor: "var(--line)", backgroundColor: "transparent" }
              }
            >
              <span
                className="mono text-2xl tabular-nums"
                style={{ color: selected ? "var(--paper)" : "var(--ink)" }}
              >
                {n}
              </span>
              <span
                className="text-center text-[10px] leading-tight"
                style={{ color: selected ? "var(--muted-3)" : "var(--muted)" }}
              >
                {EPISODE_REQUIRED_COUNT_LABELS[n]}
              </span>
            </button>
          );
        })}
      </div>

      {result && !result.ok ? (
        <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
