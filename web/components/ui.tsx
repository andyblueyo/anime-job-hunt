import type { CSSProperties, ReactNode } from "react";
import type { PostingStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Halftone layers — the visual identity, as components. See globals.css for
// the technique; each panel passes its own bloom mask (comma-separated radial
// gradients with stepped alpha stops, copied per surface from the export).
// ---------------------------------------------------------------------------

/** Layer 1: a dot field masked into soft blooms. `dark` = ink dots on paper. */
export function Tone({ mask, dark = false }: { mask: string; dark?: boolean }) {
  return (
    <div
      aria-hidden
      className={dark ? "tone tone-dark" : "tone"}
      style={{ "--mask": mask } as CSSProperties}
    />
  );
}

/** Soft light wash behind the dots on dark panels. */
export function Wash() {
  return <div aria-hidden className="wash" />;
}

/** Layer 2: paper grain over a whole panel. */
export function Grain({ light = false }: { light?: boolean }) {
  return <div aria-hidden className={light ? "grain grain-light" : "grain"} />;
}

/**
 * Layer 3: a CSS clip-path sparkle. Position it in a corner or margin with
 * `style`; never over headline or body text.
 */
export function Sparkle({
  style,
  five = false,
  spot = false,
  duration = 5,
  delay = 0,
}: {
  style: CSSProperties;
  five?: boolean;
  spot?: boolean;
  duration?: number;
  delay?: number;
}) {
  const className = ["sparkle", five ? "sparkle-5" : "", spot ? "sparkle-spot" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      aria-hidden
      className={className}
      style={{
        ...style,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Panels + text
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = "",
  recessed = false,
}: {
  children: ReactNode;
  className?: string;
  recessed?: boolean;
}) {
  return (
    <section className={`card ${recessed ? "card-recessed" : ""} p-5 sm:p-6 ${className}`}>
      {children}
    </section>
  );
}

export function SectionHeading({ eyebrow, title }: { eyebrow: string; title?: string }) {
  return (
    <div className="mb-4">
      <p className="eyebrow">{eyebrow}</p>
      {title ? <h2 className="mt-2 text-xl font-bold tracking-tight">{title}</h2> : null}
    </div>
  );
}

/**
 * Quiet mono marker for a value with no backend behind it yet. Placed beside
 * the fake value, so it's distinguishable without hovering; removed by
 * dropping the `demo` prop on the parent.
 */
export function DemoTag() {
  return (
    <span className="demo-tag ml-2" title="Placeholder — not wired to real data yet">
      demo
    </span>
  );
}

const STAT_TONE_MASK =
  "radial-gradient(circle 96px at 106% 142%, #000 0 12%, rgba(0,0,0,0.5) 46%, transparent 90%), radial-gradient(circle 60px at 78% 156%, #000 0 14%, rgba(0,0,0,0.42) 48%, transparent 90%)";

/**
 * Stat tile: mono label, big mono number, body-text note. `demo` marks a
 * value that isn't live yet — it renders the number at reduced opacity with a
 * DEMO tag, so a placeholder can't be misread next to the real counts.
 */
export function StatTile({
  label,
  value,
  note,
  demo = false,
}: {
  label: string;
  value: number | string;
  note?: string;
  demo?: boolean;
}) {
  return (
    <div className="card card-recessed relative min-w-0 overflow-hidden px-[17px] pb-[18px] pt-4">
      <Tone mask={STAT_TONE_MASK} dark />
      <p className="eyebrow relative flex items-center">
        {label}
        {demo ? <DemoTag /> : null}
      </p>
      <p
        className="mono relative mt-3.5 text-[clamp(40px,3.8vw,52px)] leading-[0.9] text-ink tabular-nums"
        style={demo ? { opacity: 0.45 } : undefined}
      >
        {value}
      </p>
      {note ? <p className="relative mt-2 text-xs leading-normal text-muted">{note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const POSTING_BADGE_CLASS: Record<PostingStatus, string> = {
  new: "badge",
  queued: "badge badge-spot",
  applied: "badge",
  skipped: "badge badge-muted",
  rejected: "badge badge-muted",
};

export function StatusBadge({ status }: { status: PostingStatus }) {
  return <span className={POSTING_BADGE_CLASS[status]}>{status}</span>;
}

export type ApplicationChip = "applied" | "rejected" | "screen";

/**
 * Chip on a recent-application row, from `applications.outcome`. A null
 * outcome is APPLIED. Anything else is shown verbatim; "rejected" and
 * "screen" (a phone screen — NOT a value in any enum yet, styled here so it
 * sits beside the real two) get their own treatment.
 */
export function outcomeToChip(outcome: string | null): { kind: ApplicationChip; label: string } {
  const text = outcome?.trim() ?? "";
  if (!text) return { kind: "applied", label: "applied" };
  if (/reject/i.test(text)) return { kind: "rejected", label: text };
  if (/screen|interview/i.test(text)) return { kind: "screen", label: text };
  return { kind: "applied", label: text };
}

const APPLICATION_CHIP_CLASS: Record<ApplicationChip, string> = {
  applied: "badge",
  rejected: "badge badge-muted",
  screen: "badge badge-spot",
};

export function ApplicationStatusChip({ outcome }: { outcome: string | null }) {
  const chip = outcomeToChip(outcome);
  return <span className={APPLICATION_CHIP_CLASS[chip.kind]}>{chip.label}</span>;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Segmented (not smooth) progress row — one slot per required application,
 * matching the lock screen's meter. Filled slots are solid ink; the current
 * slot blinks crimson. Slot count follows `total` (the session's snapshot of
 * episode_required_count), never a fixed five.
 */
export function SegmentedBar({
  filled,
  total,
  className = "",
}: {
  filled: number;
  total: number;
  className?: string;
}) {
  const slots = Math.max(total, 1);
  return (
    <div
      className={`slots ${className}`}
      role="progressbar"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          className="slot"
          data-on={i < filled}
          data-cur={i === filled && filled < total}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="border border-dashed border-line-soft px-4 py-8 text-center text-sm text-muted">
      {children}
    </p>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="card p-5 text-sm" style={{ borderColor: "var(--spot)" }}>
      <p className="eyebrow" style={{ color: "var(--spot)" }}>
        Something broke
      </p>
      <p className="mt-2 text-muted">{children}</p>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "Sep 5". A missing date is a hyphen: the mono face has no dash glyphs. */
export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return DATE.format(new Date(iso));
}
