import type { ReactNode } from "react";
import type { PostingStatus } from "@/lib/types";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`card p-5 ${className}`}>{children}</section>;
}

export function SectionHeading({ eyebrow, title }: { eyebrow: string; title?: string }) {
  return (
    <div className="mb-4">
      <p className="eyebrow">{eyebrow}</p>
      {title ? <h2 className="mt-1.5 text-xl font-bold">{title}</h2> : null}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  accent = "violet",
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: "violet" | "magenta" | "teal";
}) {
  const color = `var(--color-${accent})`;
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 text-3xl font-bold tabular-nums" style={{ color }}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-dim">{hint}</p> : null}
    </div>
  );
}

const STATUS_COLOR: Record<PostingStatus, string> = {
  new: "var(--color-violet)",
  queued: "var(--color-magenta)",
  applied: "var(--color-teal)",
  skipped: "var(--color-dim)",
  rejected: "var(--color-dim)",
};

export function StatusBadge({ status }: { status: PostingStatus }) {
  return (
    <span className="badge" style={{ color: STATUS_COLOR[status] }}>
      {status}
    </span>
  );
}

/**
 * Segmented (not smooth) progress bar — one segment per required application,
 * matching the lock screen's meter.
 */
export function SegmentedBar({ filled, total }: { filled: number; total: number }) {
  const segments = Math.max(total, 1);
  return (
    <div
      className="flex gap-1.5"
      role="progressbar"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      {Array.from({ length: segments }, (_, i) => {
        const on = i < filled;
        return (
          <span
            key={i}
            className="h-2.5 flex-1 rounded-full"
            style={
              on
                ? {
                    backgroundImage:
                      "linear-gradient(135deg, var(--color-magenta), var(--color-violet))",
                    boxShadow: "0 0 12px oklch(0.66 0.24 354 / 0.55)",
                  }
                : { backgroundColor: "oklch(1 0 0 / 0.1)" }
            }
          />
        );
      })}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-white/12 px-4 py-8 text-center text-sm text-haze">
      {children}
    </p>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="card p-5 text-sm"
      style={{ borderColor: "oklch(0.66 0.24 354 / 0.5)" }}
    >
      <p className="eyebrow" style={{ color: "var(--color-magenta)" }}>
        Something broke
      </p>
      <p className="mt-2 text-haze">{children}</p>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return DATE.format(new Date(iso));
}
