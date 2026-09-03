import { Card, SectionHeading } from "@/components/ui";
import { CopyTokenButton } from "@/components/copy-token-button";

// Reads process.env on every request — never prerender (an env change
// shouldn't require a rebuild to show up here).
export const dynamic = "force-dynamic";

/**
 * Deliberately minimal for Phase 2: this page exists only to unblock the
 * extension's "paste a token" connect step (see the Phase 2 plan's Decision
 * 3). Full settings — target roles, locations, tab cap editing — stay out of
 * scope until the scraper/role-filter work needs them.
 */
export default function SettingsPage() {
  const token = process.env.EXTENSION_API_TOKEN ?? null;

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-2 text-3xl font-bold">
          Connect the <span className="text-magenta">extension</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-haze">
          The browser extension needs this token to talk to your account. Paste it into the
          extension&apos;s options page (right-click the extension icon → Options).
        </p>
      </header>

      <Card>
        <SectionHeading eyebrow="Extension API token" />
        {token ? (
          <div className="space-y-3">
            <code className="block break-all rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-haze">
              {token}
            </code>
            <CopyTokenButton token={token} />
          </div>
        ) : (
          <p className="text-sm text-haze">
            <code className="text-magenta">EXTENSION_API_TOKEN</code> isn&apos;t set in{" "}
            <code>web/.env.local</code> yet. Generate one (e.g. <code>openssl rand -hex 32</code>
            ) and add it, then reload this page.
          </p>
        )}
      </Card>
    </div>
  );
}
