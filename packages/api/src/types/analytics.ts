/**
 * Analytics API types for the Agents workspace (FEA-2923 / AC-018).
 *
 * Shared DTOs for the org-visible analytics endpoints:
 *   - GET /agent-components/ranking  — org-wide stack-ranked comparable components
 *   - GET /agent-components/compliance — required-installed-utilized gaps
 *
 * Types live in @repo/api (not @repo/app) because they are consumed by BOTH
 * apps/app (web surface) and apps/api (server). @repo/api MUST NOT import from
 * @repo/app or any app package.
 */

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * A single row in the org-wide component ranking/leaderboard.
 *
 * Components of the same `kind` + normalized name/key group are stack-ranked
 * against each other by usage + effectiveness metrics. This is the "best of
 * breed" surface that drives the promote-and-push admin action.
 */
export type RankingItem = {
  /** Org-level identity slug: `${kind}::${normalizedKey}`. */
  slug: string;
  /** Display name of the component. */
  name: string;
  /** AgentComponentKind value. */
  kind: string;
  /** 1-based rank within its kind group. Lower = better. */
  rank: number;
  /** Org-wide total invocation count across all sessions and devices. */
  invocations: number;
  /** Distinct session count in which this component was invoked. */
  sessions: number;
  /**
   * Number of distinct compute targets (devices) where the component is
   * installed / has been observed. Indicates adoption breadth.
   */
  adoptionBreadth: number;
  /**
   * Org-wide error rate: errorCount / invocationCount in [0,1].
   * Null when invocationCount is 0 (no invocations → no meaningful rate).
   */
  errorRate: number | null;
};

/**
 * Paginated response from GET /agent-components/ranking.
 *
 * Items are sorted by rank (ascending) within each kind group. All items
 * for all kinds are interleaved and sorted by invocation count descending
 * when no explicit kind filter is applied.
 */
export type RankingResponse = {
  items: RankingItem[];
  total: number;
};

/**
 * Per-pack org-wide analytics (`GET /agent-components/pack/{packId}`) — the
 * rollup over a pack's child components (usage, sessions, KLOC/$, adoption).
 * Powers the desktop-team overlay's Team-usage + Performance for a local pack,
 * joined to the cloud by the shared `packId`.
 */
export type PackAnalyticsResponse = {
  packId: string;
  /** Org-wide invocation count across the pack's components. */
  invocations: number;
  /** Distinct sessions that invoked any of the pack's components. */
  sessions: number;
  /** Merged KLOC per dollar over those sessions; null when not computable. */
  klocPerDollar: number | null;
  /** Distinct teammates who have used the pack (display names). */
  owners: string[];
  /** Adoption breadth — distinct compute targets (devices). */
  deviceCount: number;
};

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/**
 * A compliance gap row: one entry per Distribution in auto_install mode,
 * reporting how many of the org's compute targets are not fully compliant.
 *
 * "Compliant" = status is `installed` or `enabled` in DistributionTargetStatus.
 * "Not installed" = no DistributionTargetStatus row, or status is `pending`/`failed`.
 * "Installed but unused" = status is `installed`/`enabled` but zero
 * AgentComponentSessionUsage invocations for the linked component kind/key.
 */
export type ComplianceItem = {
  /** Distribution UUID. */
  distributionId: string;
  /** The CatalogItem name being distributed. */
  catalogItemName: string;
  /** The targetKind of the CatalogItem (plugin|skill|command|agent|hook|mcp). */
  kind: string;
  /** Distribution mode — always auto_install for compliance tracking. */
  mode: string;
  /**
   * Number of compute targets that have NOT installed/enabled the distribution.
   * Includes targets with no status row (pending) and those with failed status.
   */
  notInstalledCount: number;
  /**
   * Number of compute targets that have installed/enabled the distribution
   * but have zero recorded invocations for the component.
   */
  installedButUnusedCount: number;
  /**
   * Total number of compute targets this distribution targets.
   * For `targetingType=all`: all active compute targets in the org.
   * For `targetingType=specific`: the number of DistributionTargetingEntry rows.
   */
  totalTargetCount: number;
};

/**
 * Response from GET /agent-components/compliance.
 *
 * Items represent required distributions (auto_install mode) with at least one
 * gap. Distributions where every target is installed+used are omitted.
 */
export type ComplianceResponse = {
  items: ComplianceItem[];
  total: number;
};
