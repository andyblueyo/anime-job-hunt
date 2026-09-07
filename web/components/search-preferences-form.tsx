"use client";

import { useActionState, useMemo, useState } from "react";
import { saveSearchPreferences, type ActionResult } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";
import { expandTitleVariants } from "@/lib/scraper/matching";
import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
  parseList,
  type ExperienceLevel,
  type SearchPreferences,
} from "@/lib/settings";

const CURRENCIES = ["USD", "GBP", "EUR", "CAD", "AUD"];
const PREVIEW_LIMIT = 36;

function Kind({ filter }: { filter: boolean }) {
  return (
    <span
      className="badge"
      style={{ color: filter ? "var(--color-magenta)" : "var(--color-teal)" }}
    >
      {filter ? "filter" : "not a filter"}
    </span>
  );
}

/**
 * The job-search preferences. Two of these decide what the scraper stores
 * and two don't, and the form says which is which on every field — the
 * failure mode this guards against is a filter so strict the queue stays
 * empty and the scraper looks broken.
 */
export function SearchPreferencesForm({ initial }: { initial: SearchPreferences }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    saveSearchPreferences,
    null,
  );
  const [rolesText, setRolesText] = useState(initial.target_roles.join("\n"));
  const [level, setLevel] = useState<ExperienceLevel>(initial.experience_level);

  const roles = useMemo(() => parseList(rolesText), [rolesText]);
  const variants = useMemo(() => expandTitleVariants(roles, level), [roles, level]);

  const currencyOptions = CURRENCIES.includes(initial.salary_currency)
    ? CURRENCIES
    : [initial.salary_currency, ...CURRENCIES];

  return (
    <form action={action} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <label className="block">
          <span className="flex items-center gap-2">
            <span className="eyebrow">Target job titles</span>
            <Kind filter />
          </span>
          <textarea
            name="target_roles"
            className="field mt-1.5 min-h-28 resize-y"
            placeholder={"Product Manager\nProduct Lead\nProduct Owner"}
            value={rolesText}
            onChange={(e) => setRolesText(e.target.value)}
          />
          <span className="mt-1.5 block text-xs text-dim">
            One per line (or commas). A scraped posting whose title matches none of these
            is logged as filtered out, not stored.
            {roles.length === 0 ? (
              <span style={{ color: "var(--color-magenta)" }}>
                {" "}
                Empty means keyword-search sources (Adzuna) have nothing to search for.
              </span>
            ) : null}
          </span>
        </label>

        <div>
          <span className="flex items-center gap-2">
            <span className="eyebrow">Experience level</span>
            <Kind filter={false} />
          </span>
          <div role="radiogroup" aria-label="Experience level" className="mt-1.5 grid grid-cols-3 gap-2">
            {EXPERIENCE_LEVELS.map((value) => {
              const selected = value === level;
              const { label, hint } = EXPERIENCE_LEVEL_LABELS[value];
              return (
                <label
                  key={value}
                  className="flex cursor-pointer flex-col items-center gap-1 border px-2 py-2.5 text-center transition"
                  style={
                    selected
                      ? { borderColor: "var(--ink)", backgroundColor: "var(--ink)" }
                      : { borderColor: "var(--line)", backgroundColor: "transparent" }
                  }
                >
                  <input
                    type="radio"
                    name="experience_level"
                    value={value}
                    checked={selected}
                    onChange={() => setLevel(value)}
                    className="sr-only"
                  />
                  <span
                    className="text-sm font-bold"
                    style={{ color: selected ? "var(--paper)" : "var(--ink)" }}
                  >
                    {label}
                  </span>
                  <span
                    className="text-[10px] leading-tight"
                    style={{ color: selected ? "var(--muted-3)" : "var(--muted)" }}
                  >
                    {hint}
                  </span>
                </label>
              );
            })}
          </div>
          <span className="mt-1.5 block text-xs text-dim">
            Postings don&apos;t carry an experience field — level lives in the title. This adds
            title variants to the matcher; it never removes a match.
          </span>
        </div>
      </div>

      <div className="border border-line-soft bg-paper-2 p-4">
        <p className="eyebrow">
          Titles the matcher accepts · {variants.length}
        </p>
        {variants.length === 0 ? (
          <p className="mt-2 text-sm text-dim">Add a target title to see what it expands to.</p>
        ) : (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {variants.slice(0, PREVIEW_LIMIT).map((v) => (
              <span
                key={v}
                className="border border-line-soft px-2 py-0.5 text-xs text-haze"
              >
                {v}
              </span>
            ))}
            {variants.length > PREVIEW_LIMIT ? (
              <span className="px-1 py-0.5 text-xs text-dim">
                +{variants.length - PREVIEW_LIMIT} more
              </span>
            ) : null}
          </p>
        )}
        <p className="mt-2 text-xs text-dim">
          A posting matches when its title contains any of these as a phrase (after
          normalizing Sr/Jr/Mgr and punctuation). &quot;Product Marketing Manager&quot; does
          not contain &quot;product manager&quot;; &quot;Senior Product Manager, Payments&quot; does.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <label className="block">
          <span className="flex items-center gap-2">
            <span className="eyebrow">Locations</span>
            <Kind filter />
          </span>
          <input
            name="target_locations"
            className="field mt-1.5"
            placeholder="Remote, San Francisco, US"
            defaultValue={initial.target_locations.join(", ")}
          />
          <span className="mt-1.5 block text-xs text-dim">
            Comma-separated. Empty = no location filter. A posting that lists no location
            is always kept; &quot;Remote&quot; also matches postings flagged remote.
          </span>
        </label>

        <div className="block">
          <span className="flex items-center gap-2">
            <span className="eyebrow">Salary floor (annual)</span>
            <Kind filter={false} />
          </span>
          <div className="mt-1.5 flex gap-2">
            <input
              name="salary_min"
              inputMode="numeric"
              className="field"
              placeholder="150000"
              defaultValue={initial.salary_min ?? ""}
            />
            <select
              name="salary_currency"
              className="field w-28 shrink-0"
              defaultValue={initial.salary_currency}
            >
              {currencyOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <span className="mt-1.5 block text-xs text-dim">
            Most curated boards don&apos;t publish pay, so this never drops a posting. Postings
            that do state a range at or above it get a badge and sort first on the queue.
          </span>
        </div>
      </div>

      <label className="block">
        <span className="flex items-center gap-2">
          <span className="eyebrow">Excluded companies</span>
          <Kind filter />
        </span>
        <input
          name="excluded_companies"
          className="field mt-1.5"
          placeholder="Current employer, Inc."
          defaultValue={initial.excluded_companies.join(", ")}
        />
        <span className="mt-1.5 block text-xs text-dim">
          Comma-separated, exact company names.
        </span>
      </label>

      <div className="flex items-center gap-3 pt-1">
        <SubmitPill className="pill pill-primary" pendingLabel="Saving…">
          Save preferences
        </SubmitPill>
        {result && !result.ok ? (
          <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
            {result.error}
          </p>
        ) : null}
        {result?.ok && !pending ? (
          <p className="text-sm" style={{ color: "var(--color-teal)" }}>
            Saved. The next scraper run uses these.
          </p>
        ) : null}
      </div>
    </form>
  );
}
