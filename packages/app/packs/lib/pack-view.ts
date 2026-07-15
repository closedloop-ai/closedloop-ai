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
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";

// ---------------------------------------------------------------------------
// Content kinds (superset)
// ---------------------------------------------------------------------------

/**
 * The full superset of kinds a pack (plugin) can bundle. The first five are the
 * kinds the discovery prototype surfaces; `plugin` and `tool` are the extended
 * kinds carried by the canonical desktop catalog contents. Extended kinds only
 * render when the surface enables them (see `PacksContext.showExtendedContentKinds`).
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

/** Kinds shown by default (the discovery prototype set). */
export const PROTOTYPE_CONTENT_KINDS: readonly PackContentKind[] = [
  PackContentKind.Agent,
  PackContentKind.Skill,
  PackContentKind.Command,
  PackContentKind.Hook,
  PackContentKind.Mcp,
];

/** Kinds shown only when extended content kinds are enabled. */
export const EXTENDED_CONTENT_KINDS: readonly PackContentKind[] = [
  PackContentKind.Plugin,
  PackContentKind.Tool,
];

/** Full render order: prototype kinds first, then the flagged extended kinds. */
export const CONTENT_KIND_ORDER: readonly PackContentKind[] = [
  ...PROTOTYPE_CONTENT_KINDS,
  ...EXTENDED_CONTENT_KINDS,
];

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
 * Canonical per-pack performance, sourced from the agent-component analytics
 * (`klocPerDollar`, `invocations`, `sessions`, usage `trend`). Real computed
 * metrics — no fabricated deltas.
 */
export type PackPerformance = {
  /** Merged thousands-of-lines-of-code per dollar; null when not computable. */
  klocPerDollar: number | null;
  /** Org-wide invocation count. */
  invocations: number | null;
  /** Distinct sessions that invoked the pack. */
  sessions: number | null;
  /** Usage trend for the sparkline (oldest → newest). */
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
  /** Per-target rows (populated on detail only). */
  targets?: PackDistributionTarget[];
};

// ---------------------------------------------------------------------------
// The view-model
// ---------------------------------------------------------------------------

export type PackView = {
  id: string;
  name: string;
  publisher?: string | null;
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
