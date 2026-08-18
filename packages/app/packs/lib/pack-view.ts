/**
 * Canonical view-model for the unified Packs / Plugin Catalog UX.
 *
 * One surface-agnostic shape (`PackView`) that the shared components render,
 * regardless of where the data came from:
 *  - single-player desktop  → desktop IPC catalog (`getCatalog` + installed packs)
 *  - multiplayer desktop     → desktop IPC + cloud team/perf overlay
 *  - admin org-wide web      → cloud `CatalogItem` / `Distribution` + team/perf reads
 *
 * A `PackView` composes the canonical `Pack` domain concept
 * (`@repo/app/agents/lib/session-types`) with the superset fields the packs
 * discovery experience needs — `verified`, `publisher`, bundled `contents`, and
 * the optional multiplayer/analytics blocks (`teamUsage`, `activity`,
 * `performance`, `distribution`). The data adapters map their source rows onto
 * this shape; the components never see raw IPC/DTO rows.
 */

import type {
  DistributionMode,
  DistributionTargetingEntry,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import type { PackInstallState } from "./install-state";
import type { PackComponentInstallMatrix } from "./pack-install-matrix";

// ---------------------------------------------------------------------------
// Content kinds (superset)
// ---------------------------------------------------------------------------

/**
 * The full superset of kinds a pack (plugin) can bundle. The first five are the
 * kinds the discovery prototype surfaced; `plugin` and `tool` are the extended
 * kinds carried by the canonical desktop catalog contents. All kinds render on
 * every surface (FEA-4132 graduated the extended kinds to always-on).
 */
export const PackContentKind = {
  Agent: "agent",
  Skill: "skill",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
  Plugin: "plugin",
  Tool: "tool",
} as const;
export type PackContentKind =
  (typeof PackContentKind)[keyof typeof PackContentKind];

/**
 * Full render order for a pack's bundled contents: the five discovery-prototype
 * kinds first, then the extended kinds (`plugin`, `tool`). Every surface renders
 * all of them (FEA-4132 graduated the extended kinds to always-on).
 */
export const CONTENT_KIND_ORDER: readonly PackContentKind[] = [
  PackContentKind.Agent,
  PackContentKind.Skill,
  PackContentKind.Command,
  PackContentKind.Hook,
  PackContentKind.Mcp,
  PackContentKind.Plugin,
  PackContentKind.Tool,
];

/**
 * Human label for each content kind — the single source of truth for how a kind
 * reads on screen. `CONTENT_KIND_META` (icons/colors, in `pack-meta.tsx`) reuses
 * these strings for its `label`, and the same-name disambiguator renders a pack's
 * `targetKind` category through this map so "mcp" reads as "MCP tool" everywhere
 * (never the ad-hoc title-cased "Mcp").
 */
export const CONTENT_KIND_LABEL: Record<PackContentKind, string> = {
  [PackContentKind.Agent]: "Agent",
  [PackContentKind.Skill]: "Skill",
  [PackContentKind.Command]: "Command",
  [PackContentKind.Hook]: "Hook",
  [PackContentKind.Mcp]: "MCP tool",
  [PackContentKind.Plugin]: "Plugin",
  [PackContentKind.Tool]: "Tool",
};

/**
 * Coerce an arbitrary content-kind string (desktop `ContentItem.type`, cloud
 * `targetKind`, …) to a known `PackContentKind`, defaulting unknowns to `plugin`
 * (the generic "bundled thing" bucket).
 */
export function toPackContentKind(
  raw: string | null | undefined
): PackContentKind {
  const value = (raw ?? "").toLowerCase();
  return (CONTENT_KIND_ORDER as readonly string[]).includes(value)
    ? (value as PackContentKind)
    : PackContentKind.Plugin;
}

export type PackContentEntry = {
  name: string;
  kind: PackContentKind;
  description?: string | null;
  /** Canonical catalog version body for authored components, detail-only. */
  content?: string | null;
  /**
   * Per-component install state on the CURRENT machine (FEA-4071).
   *
   * ADDITIVE and back-compat: a surface that can't resolve per-component install
   * state — the web catalog read (no local filesystem), or an older desktop that
   * predates the per-component signal — omits this, and the Contents tab renders
   * the component with no install indicator (never a fabricated "not installed").
   * Present only on the DESKTOP detail read, where `deriveContentInstallStates`
   * (`./content-install-state`) resolves each component against the machine's
   * installed-component set from `getPackDetail(packId)`. The state is one member
   * of the canonical FEA-4083 `PackInstallState` vocabulary, so the Contents tab
   * renders it through the same `InstallStateStatus` treatment every other packs
   * surface uses.
   */
  installState?: PackInstallState | null;
};

// ---------------------------------------------------------------------------
// People (installers, activity actors)
// ---------------------------------------------------------------------------

/** A team member rendered in installer stacks, usage rosters, and the activity feed. */
export type PackUser = {
  id: string;
  name: string;
  initials: string;
  avatarUrl?: string | null;
  /** Stable accent color for the avatar (hex). */
  color?: string | null;
};

export type PackActivityEvent = {
  id: string;
  user: PackUser;
  /** Display verb, e.g. "installed" / "updated to a new version of". */
  action: string;
  packId: string;
  packName: string;
  /** Relative timestamp label, e.g. "12 minutes ago". */
  agoLabel: string;
};

// ---------------------------------------------------------------------------
// Multiplayer / analytics blocks (optional; present per context)
// ---------------------------------------------------------------------------

/**
 * Canonical org-wide adoption, sourced from the agent-component analytics
 * (`AgentComponentDetail.owner` + `collaborators` + `computeTargetIds`). "Team
 * usage" is who has actually used the pack across the org and on how many devices.
 */
export type PackTeamUsage = {
  /** Teammates who have used the pack (attributed owner + collaborators). */
  installers: PackUser[];
  /** Optional roster of org members without the pack (only when a source exists). */
  notInstalled?: PackUser[];
  /** Distinct teammates who have used it. */
  installedCount: number;
  /** Active org-member denominator for the adoption ring, when known. */
  teamSize?: number;
  /** Adoption breadth — distinct compute targets (devices) that have observed it. */
  deviceCount?: number;
  /** Usage trend over recent windows, oldest → newest (sparkline / trend slope). */
  installTrend: number[];
};

/**
 * Canonical per-pack performance, sourced from the agent-component analytics.
 * The prototype's Performance tab is the source of truth for the SHAPE (compare
 * sessions that use the pack against a baseline of sessions that do not); every
 * value here is a REAL computed metric — no fabricated numbers. A `delta` is the
 * signed lift vs. the "sessions without the pack" baseline cohort, or `null`
 * when the baseline is not computable (rendered without a delta, never faked).
 *
 * Six of these fields are exposed as cards (locPerDollar, successRate,
 * tokenEfficiency, invocations, sessions, mergedPrs). `qualityScore` is computed
 * best-effort (session → source loop → artifact evaluation → judge score) but is
 * intentionally NOT rendered yet: most sessions carry no attached evaluation
 * until judging is wired deeper into the UX, so it stays `null` for now and the
 * card lights up with zero backend change once scores populate.
 */
export type PackPerformance = {
  /** Merged thousands-of-lines-of-code per dollar; null when not computable. */
  locPerDollar: number | null;
  /** % lift in LOC/$ vs. the no-pack baseline; null when not computable. */
  locDelta: number | null;
  /** % of pack sessions that reach a merged PR (0–100); null when no sessions. */
  successRate: number | null;
  /** Percentage-point lift in success rate vs. baseline; null when not computable. */
  successDelta: number | null;
  /**
   * Token efficiency vs. baseline as a % (positive = fewer tokens per unit of
   * merged work than sessions without the pack). Directional — normalized per
   * merged-PR-KLOC since there is no canonical comparable-task unit. Null when
   * not computable.
   */
  tokenEfficiencyDelta: number | null;
  /** Token-efficiency trend for the sparkline (oldest → newest). */
  efficiencyTrend: number[];
  /** Org-wide invocation count. */
  invocations: number | null;
  /** Distinct sessions that invoked the pack. */
  sessions: number | null;
  /** Distinct merged PRs produced by the pack's sessions. */
  mergedPrs: number | null;
  /**
   * ISS-6462: whether {@link mergedPrs} was counted over a bounded SAMPLE of the
   * cohort rather than all of it — the pass-through of
   * `CohortDeliveryMetrics.mergedPrsTruncated`, whose tri-state semantics
   * (`resolveMergedPrsCoverage`) this field keeps. OPTIONAL, and its absence is
   * a THIRD state, not a `false`: a producer predating the disclosure applied
   * the same cap while unable to report it.
   */
  mergedPrsTruncated?: boolean;
  /**
   * Best-effort avg judge score (0–10) over the pack's sessions. Computed but
   * NOT rendered yet (sparse until judging is integrated); null for most packs.
   */
  qualityScore: number | null;
  /** % lift in quality vs. baseline; null when not computable. */
  qualityDelta: number | null;
  /** Usage trend for the invocations sparkline (oldest → newest). */
  usageTrend: number[];
};

/** Per-target install/enable row for the admin distribution table. */
export type PackDistributionTarget = {
  id: string;
  user?: PackUser | null;
  computeTargetId?: string | null;
  computeTargetName?: string | null;
  status: DistributionTargetStatusValue;
  installedVersion?: string | null;
  failureReason?: string | null;
};

/**
 * Admin-managed org-wide distribution of a required pack (auto-install / opt-in).
 * Present only in the web-admin context. Preserves the existing distribution
 * platform (FEA-2923) — the admin UI reads and manages this block.
 */
export type PackDistribution = {
  id: string;
  mode: DistributionMode;
  targetingType: DistributionTargetingType;
  desiredEnabled: boolean;
  targetCount: number;
  installedCount: number;
  pendingCount: number;
  failedCount: number;
  /**
   * The distribution's targeting entries (per-user / per-compute-target ids) for
   * a `specific`-targeting distribution; empty for `all` targeting. Carried on
   * both the list and detail read so a member surface can decide whether *this*
   * member is in the targeted cohort — an `auto_install specific` distribution
   * that names other members (or only other devices) must NOT read as Required
   * for everyone. Empty for `all` (which does target every member).
   */
  targetingEntries: DistributionTargetingEntry[];
  /** Per-target rows (populated on detail only). */
  targets?: PackDistributionTarget[];
  /**
   * Whether per-member install status was actually loaded for this
   * distribution, making the installed/target counts real. Set explicitly by
   * the mapper from whether the source read carried `targetStatuses` — do NOT
   * infer it from `targets` being present, because a genuinely loaded-but-empty
   * distribution (zero targets) drops `targets` to `undefined` and would then
   * be indistinguishable from an unloaded list read. `false` means adoption is
   * unavailable (list read), not zero.
   */
  adoptionLoaded: boolean;
};

// ---------------------------------------------------------------------------
// The view-model
// ---------------------------------------------------------------------------

export type PackView = {
  id: string;
  name: string;
  publisher?: string | null;
  /** Catalog version (e.g. "1.2.0"); a glanceable disambiguator for same-named packs. */
  version?: string | null;
  category?: string | null;
  description?: string | null;
  githubUrl?: string | null;
  marketplaceUrl?: string | null;
  stars?: number | null;
  /** Star history for the card sparkline (oldest → newest). */
  starHistory?: number[];
  verified: boolean;
  harnesses: Harness[];
  /** Harnesses the current user has the pack installed on (empty on web). */
  installedHarnesses: Harness[];
  /** Whether the current user has the pack installed. */
  installedByMe: boolean;
  installNotes?: string | null;
  placeholderReason?: string | null;
  /** Local tool-call usage count (single-player desktop). */
  usageCount?: number | null;
  contents: PackContentEntry[];
  teamUsage?: PackTeamUsage | null;
  activity?: PackActivityEvent[] | null;
  performance?: PackPerformance | null;
  distribution?: PackDistribution | null;
  /**
   * Every distribution the org has for this catalog item, not just the summary
   * `distribution` above (FEA-4166 review). A single catalog item can carry
   * several distributions at once — e.g. an `auto_install all` alongside a
   * newer `auto_install specific` that names other members. The admin summary
   * card folds to one (`distribution`, the first), but the member projection
   * (`groupMemberPacks`) must consider ALL of them so a required pack governed
   * by an older `all`/matching distribution isn't misclassified as Available
   * just because a newer distribution targets someone else. Additive and
   * back-compat: when absent, member grouping falls back to `distribution`.
   */
  allDistributions?: PackDistribution[] | null;
  /**
   * Per-(compute target × harness × component) install state (FEA-4072a).
   *
   * ADDITIVE and back-compat: the single-target booleans above
   * (`installedByMe` / `installedHarnesses`) keep working unchanged; this is the
   * multi-target axis the manage-across-targets UX (FEA-4072) branches from.
   * One `PackComponentInstallMatrix` per component (the pack and any child
   * components), each carrying one `PackInstallState` cell per (target × harness)
   * coordinate. Present only where the multi-target distribution status was
   * loaded (the admin/detail read); `null`/absent elsewhere, so single-target
   * surfaces are unaffected. See `./pack-install-matrix`.
   */
  installMatrix?: PackComponentInstallMatrix[] | null;
};

// ---------------------------------------------------------------------------
// Small shared derivations
// ---------------------------------------------------------------------------

/** Team install count (falls back to the installer roster length). */
export function installCount(pack: PackView): number {
  return (
    pack.teamUsage?.installedCount ?? pack.teamUsage?.installers.length ?? 0
  );
}

/** Adoption share as a 0–100 percentage, or null when team size is unknown. */
export function adoptionShare(pack: PackView): number | null {
  const size = pack.teamUsage?.teamSize ?? 0;
  if (size <= 0) {
    return null;
  }
  return Math.round((installCount(pack) / size) * 100);
}

/** Slope of the install trend — how fast adoption is climbing this window. */
export function trendSlope(pack: PackView): number {
  const trend = pack.teamUsage?.installTrend ?? [];
  if (trend.length < 2) {
    return 0;
  }
  return (trend.at(-1) ?? 0) - (trend.at(0) ?? 0);
}

/**
 * The packs that stand out as *trending* relative to the rest of the catalog
 * (FEA-3236). A per-card "any positive slope" rule badges nearly every card,
 * which stops the marker reading as a marker — it just becomes card frame.
 * So "trending" is catalog-relative: a pack qualifies only when its slope is
 * positive AND at least as steep as the median slope across the packs that are
 * climbing at all. When adoption is broadly flat (fewer than two climbers) the
 * set is empty — nothing is meaningfully "moving" against the field.
 *
 * The set is computed once over the full catalog (not the current filter), so a
 * card's badge reflects its standing in the whole catalog rather than flickering
 * as filters change. Packs with no trend data (e.g. list rows before the org
 * analytics overlay loads) simply never qualify.
 */
export function trendingPackIds(packs: readonly PackView[]): Set<string> {
  const climbing = packs
    .map((pack) => ({ id: pack.id, slope: trendSlope(pack) }))
    .filter((entry) => entry.slope > 0);
  if (climbing.length < 2) {
    return new Set<string>();
  }
  const slopes = climbing.map((entry) => entry.slope).sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  const median =
    slopes.length % 2 === 0
      ? ((slopes[mid - 1] ?? 0) + (slopes[mid] ?? 0)) / 2
      : (slopes[mid] ?? 0);
  return new Set(
    climbing.filter((entry) => entry.slope >= median).map((entry) => entry.id)
  );
}

// ---------------------------------------------------------------------------
// Same-name disambiguation (FEA-3972)
// ---------------------------------------------------------------------------

const COLLAPSE_WHITESPACE = /\s+/g;
const CATEGORY_TOKEN_SEPARATOR = /[\s_-]+/;
const LEADING_V_PREFIX = /^v/i;
/** UUIDs (incl. UUIDv7 catalog ids) are all-hex + dashes; slugs are not. */
const HEX_ID = /^[0-9a-f-]+$/i;

/**
 * Normalize a display name for collision detection: trim, collapse *internal*
 * runs of whitespace to a single space, and case-fold. HTML collapses internal
 * whitespace when it renders, so "Security  Privacy" and "Security Privacy"
 * read identically and must group together (otherwise neither gets a qualifier).
 */
function normalizeName(name: string): string {
  return name.trim().replace(COLLAPSE_WHITESPACE, " ").toLowerCase();
}

/**
 * The display label for a pack category. A known content kind (`targetKind` on
 * the web catalog) reads from the canonical content-kind map, so "mcp" renders
 * as "MCP tool" (matching the detail Contents tab and the category dropdown),
 * never the ad-hoc "Mcp". A free-text category (desktop catalogs carry human
 * categories, not kinds) is title-cased, collapsing separator variants so
 * "plan-review" and "plan_review" both read "Plan Review".
 */
export function categoryDisplayLabel(category: string): string {
  const trimmed = category.trim();
  const value = trimmed.toLowerCase();
  if ((CONTENT_KIND_ORDER as readonly string[]).includes(value)) {
    return CONTENT_KIND_LABEL[value as PackContentKind];
  }
  return trimmed
    .split(CATEGORY_TOKEN_SEPARATOR)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** The version label as the card renders it — a single leading "v", normalized. */
function renderVersionLabel(version: string): string {
  return `v${version.replace(LEADING_V_PREFIX, "")}`;
}

/**
 * The *rendered* value for an axis, or null when this pack has nothing to show
 * on it. Rendered — not raw — because the card shows the rendered form, so
 * "plan-review"/"plan_review" (both "Plan Review") and "1.0.0"/"v1.0.0" (both
 * "v1.0.0") must be treated as the same value: they would print the same
 * qualifier and disambiguate nothing.
 */
function renderedAxisValue(
  pack: PackView,
  axis: (candidate: PackView) => string | null | undefined,
  render: (raw: string) => string
): string | null {
  const raw = axis(pack)?.trim();
  return raw ? render(raw) : null;
}

/**
 * True when every pack in the group has a non-empty *rendered* value on this
 * axis and those values are all distinct — i.e. the axis, chosen once for the
 * whole group, separates all of them. Picking the axis per-group (not per-pack)
 * keeps the qualifiers on a single, comparable dimension, so three same-named
 * cards don't read "Agent", "v2.0.0", "v3.0.0" side by side (nothing to compare).
 */
function axisSeparatesGroup(
  group: readonly PackView[],
  axis: (candidate: PackView) => string | null | undefined,
  render: (raw: string) => string
): boolean {
  const seen = new Set<string>();
  for (const pack of group) {
    const value = renderedAxisValue(pack, axis, render);
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

/**
 * A person-actionable last-resort qualifier for a group that name, category,
 * and version all fail to separate. Prefer the publisher (a real, human word
 * someone can act on) when it tells everyone apart; otherwise fall back to the
 * shortest id fragment that is unique within the group. A chopped hash tells
 * nobody which pack to install, so we only reach for it when there is genuinely
 * nothing else, and we never truncate a slug id ("code", "self-learning") into
 * a broken word — slugs are shown whole.
 */
function lastResortQualifiers(group: readonly PackView[]): Map<string, string> {
  if (
    axisSeparatesGroup(
      group,
      (candidate) => candidate.publisher,
      (raw) => raw
    )
  ) {
    const byPublisher = new Map<string, string>();
    for (const pack of group) {
      byPublisher.set(pack.id, pack.publisher?.trim() ?? "");
    }
    return byPublisher;
  }
  return idFragmentQualifiers(group);
}

/**
 * Shortest id fragment that is unique within the group. Opaque hash ids (UUIDs,
 * incl. same-timestamp-window UUIDv7 collisions) are sliced only as far as they
 * must be to separate — 8 chars is not enough for UUIDv7 ids minted in the same
 * ~65s window. Slug ids (`code`, `self-learning`) are shown whole; a chopped
 * slug ("#self-lea") reads as a bug.
 */
function idFragmentQualifiers(group: readonly PackView[]): Map<string, string> {
  const allHex = group.every((pack) => HEX_ID.test(pack.id));
  if (!allHex) {
    // At least one slug id in play — show every id whole rather than chop a word.
    const whole = new Map<string, string>();
    for (const pack of group) {
      whole.set(pack.id, `#${pack.id}`);
    }
    return whole;
  }

  const longest = Math.max(...group.map((pack) => pack.id.length));
  for (let length = 8; length <= longest; length++) {
    const fragments = new Map<string, string>();
    const seen = new Set<string>();
    let unique = true;
    for (const pack of group) {
      const fragment = pack.id.slice(0, length);
      if (seen.has(fragment)) {
        unique = false;
        break;
      }
      seen.add(fragment);
      fragments.set(pack.id, `#${fragment}`);
    }
    if (unique) {
      return fragments;
    }
  }

  // Ids are identical up to their full length — fall back to the whole id.
  const whole = new Map<string, string>();
  for (const pack of group) {
    whole.set(pack.id, `#${pack.id}`);
  }
  return whole;
}

/**
 * Choose ONE axis for the whole collision `group` and return each pack's
 * qualifier on it, so every card in the group is compared on the same dimension:
 *   1. category (kind/target) when it separates everyone;
 *   2. else version when it separates everyone;
 *   3. else a person-actionable last resort (publisher, then a unique id
 *      fragment) for everyone.
 * Axis selection is per-group, not per-pack: mixing axes across cards ("Agent",
 * "v2.0.0", "v3.0.0") gives the user nothing to compare.
 */
function qualifiersForGroup(group: readonly PackView[]): Map<string, string> {
  if (
    axisSeparatesGroup(group, (pack) => pack.category, categoryDisplayLabel)
  ) {
    const byCategory = new Map<string, string>();
    for (const pack of group) {
      byCategory.set(
        pack.id,
        categoryDisplayLabel(pack.category?.trim() ?? "")
      );
    }
    return byCategory;
  }

  if (axisSeparatesGroup(group, (pack) => pack.version, renderVersionLabel)) {
    const byVersion = new Map<string, string>();
    for (const pack of group) {
      byVersion.set(pack.id, renderVersionLabel(pack.version?.trim() ?? ""));
    }
    return byVersion;
  }

  return lastResortQualifiers(group);
}

/**
 * Compute a per-pack disambiguating qualifier for every pack whose display name
 * collides (case-insensitively, after collapsing internal whitespace) with
 * another pack in `packs`. Packs with a unique name are omitted from the map
 * (they need no qualifier).
 *
 * The returned qualifier is a short, glanceable secondary line the card renders
 * beneath the pack name so two same-named cards become distinguishable at a
 * glance and each carries a unique catalog identity (FEA-3972). The qualifier is
 * chosen once per collision group so all its cards read on the same dimension.
 */
export function packDisambiguators(
  packs: readonly PackView[]
): Map<string, string> {
  const byName = new Map<string, PackView[]>();
  for (const pack of packs) {
    const key = normalizeName(pack.name);
    const bucket = byName.get(key);
    if (bucket) {
      bucket.push(pack);
    } else {
      byName.set(key, [pack]);
    }
  }

  const qualifiers = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const [id, qualifier] of qualifiersForGroup(group)) {
      qualifiers.set(id, qualifier);
    }
  }
  return qualifiers;
}
