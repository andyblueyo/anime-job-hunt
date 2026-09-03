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
              className="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition disabled:opacity-60"
              style={
                selected
                  ? {
                      borderColor: "oklch(0.66 0.24 354 / 0.55)",
                      backgroundImage:
                        "linear-gradient(135deg, oklch(0.66 0.24 354 / 0.22), oklch(0.58 0.21 288 / 0.22))",
                      boxShadow: "0 0 16px oklch(0.66 0.24 354 / 0.25)",
                    }
                  : {
                      borderColor: "oklch(1 0 0 / 0.12)",
                      backgroundColor: "oklch(1 0 0 / 0.03)",
                    }
              }
            >
              <span
                className="text-2xl font-bold tabular-nums"
                style={{ color: selected ? "var(--color-magenta)" : "var(--color-haze)" }}
              >
                {n}
              </span>
              <span className="text-center text-[10px] leading-tight text-dim">
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
