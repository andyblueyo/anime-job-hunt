// The preference filters. Pure and importable from client components.
//
// Two of these are filters and two are not, and the difference is the whole
// design (see migrations/20260906_add_search_preferences.sql):
//   - title    FILTER   matchTitle
//   - location FILTER   matchLocation — a posting with NO location passes
//   - level    not one  expandTitleVariants only ever ADDS accepted titles
//   - salary   not one  never consulted here; see lib/scraper/salary badge
// Lean permissive throughout: a false positive is one extra posting to skip,
// a false negative is an empty queue that looks like a broken scraper.

import type { ExperienceLevel } from "@/lib/settings";
import { containsSequence, normalizeText, tokenize } from "./normalize";

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/** Words that go in front of a role at each level. Already normalized. */
const LEVEL_MODIFIERS: Record<Exclude<ExperienceLevel, "any">, string[]> = {
  entry: ["associate", "junior", "entry level", "assistant", "apprentice", "early career"],
  mid: [],
  senior: ["senior", "staff"],
  lead: ["lead", "principal", "staff", "group"],
  executive: ["head of", "director of", "director", "vp", "vp of", "vice president", "chief"],
};

/**
 * Trailing words that name the job rather than the domain. Stripping them off
 * a role gives its "family" ("product manager" -> "product"), which is what
 * executive titles are built on: "Head of Product", "Director, Product
 * Management", "VP Product", "Chief Product Officer".
 */
const ROLE_NOUNS = new Set([
  "manager",
  "management",
  "lead",
  "owner",
  "director",
  "head",
  "analyst",
  "designer",
  "engineer",
  "specialist",
  "coordinator",
  "officer",
  "associate",
]);

function familyOf(roleTokens: string[]): string[] {
  const family = [...roleTokens];
  while (family.length > 1 && ROLE_NOUNS.has(family[family.length - 1])) family.pop();
  return family.length < roleTokens.length ? family : [];
}

/**
 * Expand target roles into every title form the matcher should accept.
 *
 * Always includes the bare roles. The level adds modifier forms
 * ("senior product manager"), family forms for executive titles ("head of
 * product"), and for product-manager roles the abbreviations people actually
 * post ("apm", "senior pm") — the bare "pm" is left out on purpose, it's a
 * project manager at least as often. `any` takes every level's forms.
 *
 * Note that most modifier forms are redundant with plain containment ("senior
 * product manager" already contains "product manager"); they matter for titles
 * that DON'T contain the bare role, which is exactly the executive and
 * abbreviated ones. Returned normalized and deduped.
 */
export function expandTitleVariants(roles: string[], level: ExperienceLevel): string[] {
  const levels: Array<Exclude<ExperienceLevel, "any">> =
    level === "any" ? ["entry", "mid", "senior", "lead", "executive"] : [level];
  const modifiers = new Set<string>();
  for (const l of levels) for (const m of LEVEL_MODIFIERS[l]) modifiers.add(m);

  const out = new Set<string>();
  for (const role of roles) {
    const normalized = normalizeText(role);
    if (!normalized) continue;
    out.add(normalized);
    const roleTokens = normalized.split(" ");

    for (const modifier of modifiers) out.add(`${modifier} ${normalized}`);

    const family = familyOf(roleTokens);
    if (family.length > 0 && levels.includes("executive")) {
      const familyText = family.join(" ");
      for (const modifier of LEVEL_MODIFIERS.executive) out.add(`${modifier} ${familyText}`);
      out.add(`chief ${familyText} officer`);
    }

    if (normalized === "product manager") {
      if (levels.includes("entry")) out.add("apm");
      for (const modifier of modifiers) if (modifier !== "entry level") out.add(`${modifier} pm`);
    }
  }
  return [...out];
}

export interface TitleMatch {
  matched: boolean;
  /** The variant that hit, normalized. */
  variant: string | null;
  normalized: string;
}

export function matchTitle(title: string, variants: string[]): TitleMatch {
  const tokens = tokenize(title);
  const normalized = tokens.join(" ");
  for (const variant of variants) {
    if (containsSequence(tokens, variant.split(" "))) {
      return { matched: true, variant, normalized };
    }
  }
  return { matched: false, variant: null, normalized };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Spellings that mean the same place, normalized. A target that appears in a
 * group matches any member; a target in no group matches only itself. The
 * `remote` group also matches a posting's remote flag.
 */
const LOCATION_GROUPS: string[][] = [
  ["remote", "anywhere", "worldwide", "distributed", "work from home", "wfh", "telecommute", "global"],
  ["san francisco", "sf", "bay area", "san francisco bay area", "sf bay area"],
  ["new york", "nyc", "new york city", "ny"],
  ["washington dc", "washington d c", "dc", "washington", "district of columbia"],
  ["los angeles", "la"],
  ["united states", "usa", "us", "u s", "u s a", "united states of america"],
  ["united kingdom", "uk", "u k", "great britain", "england"],
  ["european union", "eu", "europe"],
];

const REMOTE_GROUP = LOCATION_GROUPS[0];

function groupFor(target: string): string[] {
  const normalized = normalizeText(target);
  return LOCATION_GROUPS.find((group) => group.includes(normalized)) ?? [normalized];
}

export interface LocationMatch {
  matched: boolean;
  /** Why it passed or failed, for the rejection log. */
  how: "no-targets" | "no-location" | "remote" | "alias" | "no-match";
  target: string | null;
}

/**
 * A posting matches if any target (or an alias of it) appears in its location
 * text, or the target means "remote" and the posting is remote. No targets
 * configured = everything passes. No location on the posting = passes: it's
 * a missing optional field, not a mismatch.
 */
export function matchLocation(
  location: string | null,
  remote: boolean,
  targets: string[],
): LocationMatch {
  if (targets.length === 0) return { matched: true, how: "no-targets", target: null };

  const text = location?.trim() ?? "";
  if (!text && !remote) return { matched: true, how: "no-location", target: null };

  const tokens = tokenize(text);
  for (const target of targets) {
    const aliases = groupFor(target);
    const wantsRemote = aliases === REMOTE_GROUP;
    if (wantsRemote && remote) return { matched: true, how: "remote", target };
    for (const alias of aliases) {
      if (containsSequence(tokens, alias.split(" "))) {
        return { matched: true, how: "alias", target };
      }
    }
  }
  if (!text) return { matched: true, how: "no-location", target: null };
  return { matched: false, how: "no-match", target: null };
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

export interface FilterPrefs {
  target_roles: string[];
  target_locations: string[];
  excluded_companies: string[];
  experience_level: ExperienceLevel;
}

export interface EvaluationInput {
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean;
}

export type Evaluation =
  | { keep: true; titleVariant: string | null; locationHow: LocationMatch["how"] }
  | {
      keep: false;
      reason: "title" | "location" | "excluded_company";
      details: Record<string, unknown>;
    };

/**
 * `variants` is expandTitleVariants(prefs.target_roles, prefs.experience_level),
 * passed in so a run computes it once. Empty variants (no target roles) means
 * no title filter — see the run orchestrator for how API sources handle that.
 */
export function evaluate(
  input: EvaluationInput,
  prefs: FilterPrefs,
  variants: string[],
): Evaluation {
  if (input.company) {
    const company = normalizeText(input.company);
    const excluded = prefs.excluded_companies.find((c) => normalizeText(c) === company);
    if (excluded) {
      return { keep: false, reason: "excluded_company", details: { excluded } };
    }
  }

  let titleVariant: string | null = null;
  if (variants.length > 0) {
    const title = matchTitle(input.title, variants);
    if (!title.matched) {
      return {
        keep: false,
        reason: "title",
        details: {
          normalized_title: title.normalized,
          variants_tried: variants.length,
          target_roles: prefs.target_roles,
          experience_level: prefs.experience_level,
        },
      };
    }
    titleVariant = title.variant;
  }

  const location = matchLocation(input.location, input.remote, prefs.target_locations);
  if (!location.matched) {
    return {
      keep: false,
      reason: "location",
      details: {
        location: input.location,
        remote: input.remote,
        target_locations: prefs.target_locations,
      },
    };
  }

  return { keep: true, titleVariant, locationHow: location.how };
}
