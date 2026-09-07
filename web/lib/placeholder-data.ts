// Every fake value the website renders, in one place. These exist because
// the restyle builds elements the backend has no data for yet. Each one is
// the DEFAULT of a real prop on the component that shows it, so wiring a
// value means passing the live one at the call site (and deleting the entry
// here) — never reaching into this module from inside a component.
//
// Anything rendered from here sits beside real numbers the user actually
// reads, so every consumer shows a <DemoTag /> until its `demo` prop is
// dropped.

/**
 * Dashboard: DAY STREAK stat tile (days in a row with at least one
 * application, and the best run).
 * TODO: wire to a streak computed from `applications.applied_at` — no data
 * model exists for this yet.
 */
export const PLACEHOLDER_STREAK = { days: 4, best: 6 };

/**
 * Dashboard active-lock card: what's waiting behind the lock.
 * TODO: wire to a show title + episode on `unlock_sessions` (columns don't
 * exist; the extension doesn't read the title from reanime.to yet either).
 * Set in the mono face, so the separator is a bullet, not a middle dot.
 */
export const PLACEHOLDER_WAITING_EPISODE = "BLEACH: TYBW - The Calamity • Episode 5 is waiting.";
