import { markApplied, queuePosting, reopenPosting, skipPosting } from "@/app/actions";
import { SubmitPill } from "@/components/submit-pill";
import { StatusBadge, formatDate } from "@/components/ui";
import type { JobPostingWithApplication } from "@/lib/types";

/** One action = one small form, so the buttons work without JS too. */
function ActionForm({
  action,
  id,
  children,
  className,
  pendingLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitPill className={className} pendingLabel={pendingLabel}>
        {children}
      </SubmitPill>
    </form>
  );
}

export function PostingRow({ posting }: { posting: JobPostingWithApplication }) {
  const application = posting.applications;
  const open = posting.status === "new" || posting.status === "queued";

  const meta = [
    posting.location,
    posting.salary_range,
    posting.source === "scraped" ? "scraped" : "added by hand",
    application ? `applied ${formatDate(application.applied_at)}` : null,
  ].filter(Boolean);

  return (
    <li className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <StatusBadge status={posting.status} />
          <p className="truncate text-sm font-bold text-haze">{posting.company}</p>
        </div>

        <a
          href={posting.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline-hover mt-1.5 block truncate text-lg font-bold"
        >
          {posting.title}
        </a>

        {meta.length > 0 ? (
          <p className="mt-1 truncate text-xs text-dim">{meta.join(" · ")}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {open ? (
          <>
            <ActionForm
              action={markApplied}
              id={posting.id}
              className="pill pill-teal pill-sm"
              pendingLabel="…"
            >
              Applied
            </ActionForm>

            {posting.status === "new" ? (
              <ActionForm
                action={queuePosting}
                id={posting.id}
                className="pill pill-ghost pill-sm"
                pendingLabel="…"
              >
                Queue
              </ActionForm>
            ) : null}

            <ActionForm
              action={skipPosting}
              id={posting.id}
              className="pill pill-ghost pill-sm"
              pendingLabel="…"
            >
              Skip
            </ActionForm>
          </>
        ) : (
          <ActionForm
            action={reopenPosting}
            id={posting.id}
            className="pill pill-ghost pill-sm"
            pendingLabel="…"
          >
            Reopen
          </ActionForm>
        )}
      </div>
    </li>
  );
}
