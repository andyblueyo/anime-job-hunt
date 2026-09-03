"use client";

import { useState } from "react";

/**
 * Copies the extension API token to the clipboard. A separate client
 * component so the /settings page itself can stay a server component (the
 * token value comes from process.env and should never round-trip through a
 * client bundle any more than this one rendered string).
 */
export function CopyTokenButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail (permissions, insecure context) — the token
      // is still selectable text right above the button, so this is a
      // silent no-op rather than an error state.
    }
  }

  return (
    <button type="button" onClick={handleCopy} className="pill pill-sm pill-primary">
      {copied ? "Copied!" : "Copy token"}
    </button>
  );
}
