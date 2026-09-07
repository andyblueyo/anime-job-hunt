import { getDb, getUserId } from "@/lib/supabase/server";
import { isExperienceLevel, parseList } from "@/lib/settings";
import { runScraper } from "@/lib/scraper/run";
import type { FilterPrefs } from "@/lib/scraper/matching";

export const dynamic = "force-dynamic";
// Vercel: Hobby allows up to 60s; the run's own budget (below) stays under it.
export const maxDuration = 60;

const CRON_BUDGET_MS = 50_000;

/**
 * Same shape as requireExtensionToken, different secret: Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>` when that env var is set on the
 * project. Fails closed when it isn't set.
 */
function requireCronSecret(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server is missing CRON_SECRET. Set it in web/.env.local." },
      { status: 500 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) {
    return Response.json({ error: "Missing or invalid bearer token." }, { status: 401 });
  }
  return null;
}

/**
 * The scheduled scraper (see web/vercel.json — daily). Also the manual and
 * dry-run entry point:
 *
 *   GET /api/cron/scrape                         real run, every enabled board
 *   GET /api/cron/scrape?dry_run=1               evaluate + report, write nothing
 *   ...&board=<id>                               only these boards (repeatable)
 *   ...&roles=Product+Manager,Product+Owner      dry run only: pretend prefs
 *   ...&locations=Remote,US&level=senior         dry run only
 *   ...&budget_ms=20000                          shorter time budget
 *
 * Runs as the app's single seeded user, like every other route this phase.
 */
export async function GET(request: Request) {
  const authError = requireCronSecret(request);
  if (authError) return authError;

  const params = new URL(request.url).searchParams;
  const dryRun = params.get("dry_run") === "1" || params.get("dry_run") === "true";
  const boardIds = params.getAll("board").filter(Boolean);
  const budgetParam = Number(params.get("budget_ms"));
  const budgetMs = Number.isFinite(budgetParam) && budgetParam > 0 ? Math.min(budgetParam, 55_000) : CRON_BUDGET_MS;

  const override: Partial<FilterPrefs> = {};
  if (dryRun) {
    if (params.has("roles")) override.target_roles = parseList(params.get("roles") ?? "");
    if (params.has("locations")) override.target_locations = parseList(params.get("locations") ?? "");
    const level = params.get("level");
    if (isExperienceLevel(level)) override.experience_level = level;
  }

  try {
    const db = await getDb();
    const userId = await getUserId();
    const summary = await runScraper({
      db,
      userId,
      dryRun,
      budgetMs,
      boardIds: boardIds.length > 0 ? boardIds : undefined,
      prefsOverride: dryRun ? override : undefined,
    });
    return Response.json({ ok: true, ...summary });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export const POST = GET;
