/**
 * Canonical, runtime-agnostic filter contracts for the Agent Sessions list —
 * the single source of truth shared by every surface that filters sessions:
 *   • the shared Sessions filter menu (@repo/app/agents/lib/session-filter-adapter),
 *   • the cloud query builder (apps/api/app/agent-sessions/service.ts), and
 *   • the desktop local source (apps/desktop/src/main/shared-agent-sessions-api.ts).
 *
 * Keeping the autonomy-tier boundaries and cost-bucket bounds here (pure data +
 * pure matchers, no React/Prisma) guarantees the web cloud path and the desktop
 * local path classify a session identically — the Repository/Status facets set
 * the precedent that a filter's meaning lives in one place, not per surface.
 *
 * Harness and model need no contract here: their options are data-derived from
 * the usage summary (byHarness/byModel) and the filter is a plain membership
 * test on the session's `harness`/`model` value.
 */

/** Autonomy is an integer 0–100 synced from the desktop (FEA-2094). */
export type AutonomyTier = "high" | "mixed" | "guided" | "unknown";

/**
 * Inclusive lower bound of each scored autonomy tier. The one place the 80/50
 * threshold boundaries are defined; `@repo/app/agents/lib/autonomy` re-exports
 * the classifier so the sessions-list column, the detail Properties panel, and
 * the new Autonomy filter all agree.
 */
export const AUTONOMY_TIER_MIN_SCORE = {
  high: 80,
  mixed: 50,
  guided: 0,
} as const;

/** Classify a raw autonomy score into its tier; null/undefined = "unknown". */
export function classifyAutonomyTier(
  value: number | null | undefined
): AutonomyTier {
  if (value == null) {
    return "unknown";
  }
  if (value >= AUTONOMY_TIER_MIN_SCORE.high) {
    return "high";
  }
  if (value >= AUTONOMY_TIER_MIN_SCORE.mixed) {
    return "mixed";
  }
  return "guided";
}

/** True when a session's autonomy score falls in the requested tier. */
export function matchesAutonomyTier(
  value: number | null | undefined,
  tier: string
): boolean {
  return classifyAutonomyTier(value) === tier;
}

/**
 * The autonomy-score range for a tier, as a half-open interval `[gte, lt)`.
 * Derived from `AUTONOMY_TIER_MIN_SCORE` so the tier adjacency (mixed capped by
 * the high threshold, guided capped by the mixed threshold) lives in exactly one
 * place. `isNull` marks the null-autonomy "unknown" tier; returns null for an
 * unrecognized tier id. The cloud query builder maps this to a Prisma predicate;
 * the desktop matcher classifies with {@link classifyAutonomyTier} directly.
 */
export type AutonomyTierRange = { gte?: number; lt?: number; isNull?: boolean };

export function autonomyTierRange(tier: string): AutonomyTierRange | null {
  switch (tier) {
    case "high":
      return { gte: AUTONOMY_TIER_MIN_SCORE.high };
    case "mixed":
      return {
        gte: AUTONOMY_TIER_MIN_SCORE.mixed,
        lt: AUTONOMY_TIER_MIN_SCORE.high,
      };
    case "guided":
      return {
        gte: AUTONOMY_TIER_MIN_SCORE.guided,
        lt: AUTONOMY_TIER_MIN_SCORE.mixed,
      };
    case "unknown":
      return { isNull: true };
    default:
      return null;
  }
}

export type SessionAutonomyTierFilterOption = {
  value: AutonomyTier;
  label: string;
};

/** Fixed Autonomy facet options (a scored SSOT enum, like the Status facet). */
export const SESSION_AUTONOMY_TIER_FILTER_OPTIONS: readonly SessionAutonomyTierFilterOption[] =
  [
    { value: "high", label: "High" },
    { value: "mixed", label: "Mixed" },
    { value: "guided", label: "Guided" },
    { value: "unknown", label: "Unknown" },
  ];

export type SessionCostBucketId =
  | "under_1"
  | "from_1_to_10"
  | "from_10_to_50"
  | "from_50";

/**
 * A cost threshold bucket (USD). `minCost` is inclusive, `maxCost` exclusive; a
 * null `maxCost` means no upper bound. Selecting several buckets ORs them, so
 * the coarse ranges compose into the "high-cost sessions" slice users need.
 */
export type SessionCostBucket = {
  id: SessionCostBucketId;
  label: string;
  minCost: number;
  maxCost: number | null;
};

export const SESSION_COST_BUCKETS: readonly SessionCostBucket[] = [
  { id: "under_1", label: "< $1", minCost: 0, maxCost: 1 },
  { id: "from_1_to_10", label: "$1 to $10", minCost: 1, maxCost: 10 },
  { id: "from_10_to_50", label: "$10 to $50", minCost: 10, maxCost: 50 },
  { id: "from_50", label: "$50+", minCost: 50, maxCost: null },
];

const SESSION_COST_BUCKET_BY_ID = new Map<string, SessionCostBucket>(
  SESSION_COST_BUCKETS.map((bucket) => [bucket.id, bucket])
);

/** Look up a cost bucket by id (undefined for unknown ids). */
export function getSessionCostBucket(
  id: string
): SessionCostBucket | undefined {
  return SESSION_COST_BUCKET_BY_ID.get(id);
}

/** True when an estimated cost (USD) falls inside the requested bucket. */
export function matchesCostBucket(cost: number, bucketId: string): boolean {
  const bucket = SESSION_COST_BUCKET_BY_ID.get(bucketId);
  if (!bucket) {
    return false;
  }
  return (
    cost >= bucket.minCost && (bucket.maxCost === null || cost < bucket.maxCost)
  );
}

/**
 * The scalar diff-count columns the Sessions surface reads to decide whether a
 * session produced changes. Kept minimal so the same shape is satisfied by the
 * cloud `SessionDetail` row and the desktop `SyncedAgentSession`.
 */
export type SessionChangeCounts = {
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
};

/**
 * Whether a session produced changes, defined against the very columns the
 * Sessions detail row renders (`+linesAdded / -linesRemoved`, plus the
 * files-changed count). A session "has changes" when any of files/lines
 * added/removed is greater than zero; null/0 across all three means "no
 * changes". Keeping this predicate here guarantees the filter and the row agree,
 * and that the cloud query and the desktop matcher classify a session the same
 * way (FEA-2505).
 */
export function sessionHasChanges(counts: SessionChangeCounts): boolean {
  return (
    (counts.filesChanged ?? 0) > 0 ||
    (counts.linesAdded ?? 0) > 0 ||
    (counts.linesRemoved ?? 0) > 0
  );
}

export type SessionChangePresenceId = "has_changes" | "no_changes";

export type SessionFilterToggleOption<TId extends string> = {
  id: TId;
  label: string;
};

/**
 * Fixed Changes facet options (FEA-2505). Selecting "Has changes" excludes the
 * empty sessions users skip when reviewing meaningful work; "No changes"
 * isolates the empty ones. Two options compose with the other facets through the
 * same OR-within / AND-across contract as autonomy/cost.
 */
export const SESSION_CHANGE_PRESENCE_OPTIONS: readonly SessionFilterToggleOption<SessionChangePresenceId>[] =
  [
    { id: "has_changes", label: "Has changes" },
    { id: "no_changes", label: "No changes" },
  ];

/** True when a session's change-presence matches the requested option. */
export function matchesChangePresence(
  hasChanges: boolean,
  optionId: string
): boolean {
  if (optionId === "has_changes") {
    return hasChanges;
  }
  if (optionId === "no_changes") {
    return !hasChanges;
  }
  return false;
}

export type SessionPrAssociationId = "has_pr" | "no_pr";

/**
 * Fixed Pull request facet options (FEA-2505). "Has PR" narrows to sessions with
 * an associated pull request (legacy JSON or the canonical session→PR artifact
 * link); "No PR" is its complement.
 */
export const SESSION_PR_ASSOCIATION_OPTIONS: readonly SessionFilterToggleOption<SessionPrAssociationId>[] =
  [
    { id: "has_pr", label: "Has PR" },
    { id: "no_pr", label: "No PR" },
  ];

/** True when a session's pull-request association matches the requested option. */
export function matchesPrAssociation(
  hasPr: boolean,
  optionId: string
): boolean {
  if (optionId === "has_pr") {
    return hasPr;
  }
  if (optionId === "no_pr") {
    return !hasPr;
  }
  return false;
}
