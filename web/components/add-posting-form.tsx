"use client";

import { useActionState, useState, type FormEvent } from "react";
import { addPosting, parsePosting, type ActionResult } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";
import type { ParsePostingResult, ParsedFieldName } from "@/lib/posting-parser/types";

/**
 * Two steps. Paste: one URL, "Fetch details". Review: the same five fields
 * the hand-typed form always had, pre-filled from the parse and all editable,
 * with a quiet marker on the ones the parser actually sourced. A parse that
 * fails still lands on Review (URL kept, rest blank, one line saying why),
 * and "type it in by hand" skips the paste step entirely.
 */
type Stage = { step: "paste" } | { step: "review"; parsed: ParsePostingResult | null };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function AddPostingForm() {
  const [stage, setStage] = useState<Stage>({ step: "paste" });
  const [justAdded, setJustAdded] = useState(false);

  // The stage changes are made inside the actions themselves (React batches
  // them with the transition), so there's no effect syncing state to results.
  const [, parseAction, parsePending] = useActionState<ParsePostingResult | null, FormData>(
    async (prev, formData) => {
      const result = await parsePosting(prev, formData);
      // A finished parse — good or bad — lands on Review.
      setStage({ step: "review", parsed: result });
      return result;
    },
    null,
  );
  const [saveResult, saveAction, savePending] = useActionState<ActionResult | null, FormData>(
    async (prev, formData) => {
      const result = await addPosting(prev, formData);
      if (result.ok) {
        // Back to Paste, ready for the next one.
        setStage({ step: "paste" });
        setJustAdded(true);
      }
      return result;
    },
    null,
  );

  if (stage.step === "paste") {
    return (
      <PasteStep
        action={parseAction}
        pending={parsePending}
        justAdded={justAdded}
        onManual={() => {
          setJustAdded(false);
          setStage({ step: "review", parsed: null });
        }}
        onSubmit={() => setJustAdded(false)}
      />
    );
  }

  return (
    <ReviewStep
      parsed={stage.parsed}
      action={saveAction}
      pending={savePending}
      error={saveResult && !saveResult.ok ? saveResult.error : null}
      onStartOver={() => setStage({ step: "paste" })}
    />
  );
}

// ---------------------------------------------------------------------------

function PasteStep({
  action,
  pending,
  justAdded,
  onManual,
  onSubmit,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  justAdded: boolean;
  onManual: () => void;
  onSubmit: () => void;
}) {
  const [url, setUrl] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!isHttpUrl(url)) {
      event.preventDefault();
      setClientError("Paste a full link starting with http:// or https://");
      return;
    }
    setClientError(null);
    onSubmit();
  };

  return (
    <form action={action} onSubmit={handleSubmit} className="space-y-3">
      <label className="block">
        <span className="eyebrow">Posting URL</span>
        <input
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          className="field mt-1.5"
          placeholder="https://jobs.lever.co/…"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (clientError) setClientError(null);
          }}
          disabled={pending}
          required
        />
        <span className="mt-1.5 block text-xs text-dim">
          We fetch the page and pre-fill company, role, location, and salary from its job
          data. You check and edit everything before it&apos;s saved.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <SubmitPill className="pill pill-primary" pendingLabel="Fetching…">
          Fetch details
        </SubmitPill>
        <button type="button" className="pill pill-ghost" onClick={onManual} disabled={pending}>
          Type it in by hand
        </button>
        {pending ? (
          <p className="text-sm text-muted" role="status">
            Reading the posting…
          </p>
        ) : null}
        {clientError ? (
          <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
            {clientError}
          </p>
        ) : null}
        {justAdded && !pending ? (
          <p className="text-sm" style={{ color: "var(--color-teal)" }}>
            Added to the queue.
          </p>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function ReviewStep({
  parsed,
  action,
  pending,
  error,
  onStartOver,
}: {
  parsed: ParsePostingResult | null;
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  onStartOver: () => void;
}) {
  const fields = parsed?.fields;
  const wasParsed = (name: ParsedFieldName) =>
    parsed !== null && name !== "url" && parsed.provenance[name] !== "none";
  const showPostedDate = wasParsed("posted_date");

  return (
    <form action={action} className="space-y-3">
      {parsed ? (
        <p className="text-sm text-muted" role="status">
          {parsed.message ??
            "Pulled these from the page — check them over, edit anything that's off, then save."}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company" name="company" parsed={wasParsed("company")}>
          <input
            name="company"
            className="field mt-1.5"
            placeholder="Studio Ghibli"
            defaultValue={fields?.company ?? ""}
            data-parsed={wasParsed("company")}
            required
          />
        </Field>
        <Field label="Role" name="title" parsed={wasParsed("title")}>
          <input
            name="title"
            className="field mt-1.5"
            placeholder="Product Manager"
            defaultValue={fields?.title ?? ""}
            data-parsed={wasParsed("title")}
            required
          />
        </Field>
      </div>

      <Field label="Posting URL" name="url" parsed={false}>
        <input
          name="url"
          type="url"
          className="field mt-1.5"
          placeholder="https://…"
          defaultValue={fields?.url ?? ""}
          required
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Location (optional)" name="location" parsed={wasParsed("location")}>
          <input
            name="location"
            className="field mt-1.5"
            placeholder="Remote — US"
            defaultValue={fields?.location ?? ""}
            data-parsed={wasParsed("location")}
          />
        </Field>
        <Field label="Salary (optional)" name="salary_range" parsed={wasParsed("salary_range")}>
          <input
            name="salary_range"
            className="field mt-1.5"
            placeholder="$140k–$170k"
            defaultValue={fields?.salary_range ?? ""}
            data-parsed={wasParsed("salary_range")}
          />
        </Field>
      </div>

      {showPostedDate ? (
        <Field label="Posted date (optional)" name="posted_date" parsed>
          <input
            name="posted_date"
            type="date"
            className="field mt-1.5 sm:w-1/2"
            defaultValue={fields?.posted_date ?? ""}
            data-parsed
          />
        </Field>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <SubmitPill className="pill pill-primary" pendingLabel="Saving…">
          Add posting
        </SubmitPill>
        <button type="button" className="pill pill-ghost" onClick={onStartOver} disabled={pending}>
          Start over
        </button>
        {error ? (
          <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  parsed,
  children,
}: {
  label: string;
  name: ParsedFieldName;
  parsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block" data-field={name}>
      <span className="flex items-center">
        <span className="eyebrow">{label}</span>
        {parsed ? (
          <span className="field-tag ml-2" title="Filled in from the page — double-check it">
            parsed
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
