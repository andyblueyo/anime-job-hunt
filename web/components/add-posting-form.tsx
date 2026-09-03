"use client";

import { useActionState, useEffect, useRef } from "react";
import { addPosting, type ActionResult } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";

export function AddPostingForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(
    addPosting,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the fields once a posting lands, ready for the next one.
  useEffect(() => {
    if (result?.ok) formRef.current?.reset();
  }, [result]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Company</span>
          <input name="company" className="field mt-1.5" placeholder="Studio Ghibli" required />
        </label>
        <label className="block">
          <span className="eyebrow">Role</span>
          <input
            name="title"
            className="field mt-1.5"
            placeholder="Product Manager"
            required
          />
        </label>
      </div>

      <label className="block">
        <span className="eyebrow">Posting URL</span>
        <input
          name="url"
          type="url"
          className="field mt-1.5"
          placeholder="https://…"
          required
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Location (optional)</span>
          <input name="location" className="field mt-1.5" placeholder="Remote — US" />
        </label>
        <label className="block">
          <span className="eyebrow">Salary (optional)</span>
          <input name="salary_range" className="field mt-1.5" placeholder="$140k–$170k" />
        </label>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <SubmitPill className="pill pill-primary" pendingLabel="Saving…">
          Add posting
        </SubmitPill>
        {result && !result.ok ? (
          <p className="text-sm" style={{ color: "var(--color-magenta)" }}>
            {result.error}
          </p>
        ) : null}
        {result?.ok ? (
          <p className="text-sm" style={{ color: "var(--color-teal)" }}>
            Added to the queue.
          </p>
        ) : null}
      </div>
    </form>
  );
}
