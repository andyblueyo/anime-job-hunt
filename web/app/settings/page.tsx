import { Card, ErrorNote, SectionHeading } from "@/components/ui";
import { CopyTokenButton } from "@/components/copy-token-button";
import { EpisodeCountControl } from "@/components/episode-count-control";
import { SearchPreferencesForm } from "@/components/search-preferences-form";
import { getDb, getUserId } from "@/lib/supabase/server";
import { clampEpisodeRequiredCount, getSettings, type SearchPreferences } from "@/lib/settings";

// Reads process.env and live settings on every request — never prerender (an
// env change shouldn't require a rebuild to show up here).
export const dynamic = "force-dynamic";

/**
 * Connect-extension token, the per-episode difficulty, and (Phase 3) the
 * job-search preferences the scraper filters on. Lock-behavior tunables
 * (tab cap, snooze length, close-prompt threshold) still have no UI.
 */
export default async function SettingsPage() {
  const token = process.env.EXTENSION_API_TOKEN ?? null;

  // Deliberately tolerant: this page is where you come to fix a broken
  // connection, so a settings read that fails (most likely
  // 20260903_add_episode_required_count.sql not applied yet) must not take
  // the token section down with it.
  let episodeCount: number | null = null;
  let preferences: SearchPreferences | null = null;
  let settingsError: string | null = null;
  try {
    const db = await getDb();
    const userId = await getUserId();
    const settings = await getSettings(db, userId);
    episodeCount = clampEpisodeRequiredCount(settings.episode_required_count);
    preferences = {
      target_roles: settings.target_roles,
      target_locations: settings.target_locations,
      excluded_companies: settings.excluded_companies,
      experience_level: settings.experience_level,
      salary_min: settings.salary_min,
      salary_currency: settings.salary_currency,
    };
  } catch (error) {
    settingsError = error instanceof Error ? error.message : String(error);
  }

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
            <code className="block break-all border border-line-soft bg-paper-2 px-3 py-2.5 text-xs text-haze">
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

      <Card>
        <SectionHeading
          eyebrow="Jobs per episode"
          title="How much does one episode cost?"
        />
        <p className="mb-4 max-w-2xl text-sm text-haze">
          The most applications one episode can cost. If your queue has fewer postings
          than this when an episode ends, the lock asks for what&apos;s there instead — an
          empty queue costs nothing. Changing this only affects the <em>next</em> episode —
          a lock that&apos;s already open keeps the target it was created with.
        </p>
        {episodeCount !== null ? (
          <EpisodeCountControl current={episodeCount} />
        ) : (
          <ErrorNote>
            Couldn&apos;t load your settings: {settingsError}. If{" "}
            <code>episode_required_count</code> is the problem, apply{" "}
            <code>migrations/20260903_add_episode_required_count.sql</code> and reload.
          </ErrorNote>
        )}
      </Card>

      <Card>
        <SectionHeading eyebrow="Job search" title="What the scraper looks for" />
        <p className="mb-5 max-w-2xl text-sm text-haze">
          Titles and locations decide what gets stored. Experience level and salary
          don&apos;t — they shape matching and ranking. Anything filtered out is kept on
          the <a href="/boards" className="underline-hover text-glow">Boards</a> page so
          you can see whether the filter is too strict.
        </p>
        {preferences ? (
          <SearchPreferencesForm initial={preferences} />
        ) : (
          <ErrorNote>
            Couldn&apos;t load your settings: {settingsError}. If the missing column is one
            of <code>experience_level</code> / <code>salary_min</code>, apply{" "}
            <code>migrations/20260906_add_search_preferences.sql</code> and reload.
          </ErrorNote>
        )}
      </Card>
    </div>
  );
}
