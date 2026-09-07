"use client";

import { useRef } from "react";
import { deletePosting } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";

/**
 * "Delete" on a queue row: a native <dialog> confirm, then the same
 * hidden-id form the other row actions use. Hard delete — the FK cascade
 * takes the application row with it, which the dialog says out loud when
 * there is one. Needs JS for the confirm, so without it the button is a
 * no-op rather than an unconfirmed delete.
 */
export function DeletePostingButton({
  id,
  company,
  title,
  hasApplication,
}: {
  id: string;
  company: string;
  title: string;
  hasApplication: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="pill pill-ghost pill-sm"
        onClick={() => dialogRef.current?.showModal()}
        aria-haspopup="dialog"
      >
        Delete
      </button>

      <dialog ref={dialogRef} className="dialog" aria-labelledby={`delete-${id}-title`}>
        <div className="p-5 sm:p-6">
          <p className="eyebrow" style={{ color: "var(--spot)" }}>
            Delete posting
          </p>
          <p id={`delete-${id}-title`} className="mt-2 text-lg font-bold leading-snug">
            {title}
          </p>
          <p className="text-sm font-bold text-haze">{company}</p>

          <p className="mt-4 text-sm text-muted">
            This removes the posting permanently. It can be re-added or re-scraped later.
          </p>
          {hasApplication ? (
            <p className="mt-2 text-sm" style={{ color: "var(--spot)" }}>
              Its application record goes with it, so your applied count drops by one.
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="pill pill-ghost pill-sm"
              onClick={() => dialogRef.current?.close()}
              autoFocus
            >
              Cancel
            </button>
            <form action={deletePosting}>
              <input type="hidden" name="id" value={id} />
              <SubmitPill className="pill pill-danger pill-sm" pendingLabel="Deleting…">
                Delete
              </SubmitPill>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
