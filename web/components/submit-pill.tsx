"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * Submit button that disables itself while its enclosing form's action runs.
 * Lives in its own client component so the rows around it stay server-rendered.
 */
export function SubmitPill({
  children,
  className = "pill pill-ghost pill-sm",
  pendingLabel,
}: {
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className={className} disabled={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
