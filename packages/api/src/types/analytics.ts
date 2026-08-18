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
 * Comparison-based delivery metrics for a cohort of sessions (the prototype's
 * Performance-tab shape): how sessions that use a pack/component compare to a
 * BASELINE of org sessions that do not. Every value is REAL — computed from the
 * cohort and a bounded baseline — never fabricated. A `*Delta` is `null` when the
 * baseline is not computable (rendered without a delta, never faked). These
 * fields complement (do not replace) the absolute `locPerDollar` /
 * `invocations` / `sessions` already carried by the analytics DTOs.
 *
 * `qualityScore`/`qualityDelta` are computed best-effort (session → source loop
 * → artifact evaluation → judge score) but are intentionally NOT rendered yet:
 * most sessions carry no attached evaluation until judging is wired deeper into
 * the UX, so they are `null` for most packs and the card lights up with zero
 * backend change once scores populate.
 */
export type CohortDeliveryMetrics = {
  /** ISS-4667: % lift in LOC/$ vs. the baseline; null when not computable. */
  locDelta: number | null;
  /**
   * @deprecated ISS-4667 — the KLOC-unit predecessor of {@link locDelta}. A
   * PERCENTAGE lift is unit-free, so a producer that predates ISS-4667 sends the
   * same number under the old name; consumers read it as a straight fallback (no
   * scaling). Never emitted by this repo's producers.
   */
  klocDelta?: number | null;
  /** % of cohort sessions that reach a merged PR (0–100); null when no sessions. */
  successRate: number | null;
  /** Percentage-point lift in success rate vs. baseline; null when not computable. */
  successDelta: number | null;
  /**
   * Token efficiency vs. baseline as a % (positive = fewer tokens per KLOC of
   * work than baseline sessions). Directional — normalized per KLOC since there
   * is no canonical comparable-task unit. Null when not computable.
   */
  tokenEfficiencyDelta: number | null;
  /** Token-efficiency trend (KLOC per 1k tokens per window, oldest → newest). */
  efficiencyTrend: number[];
  /** Distinct merged PRs produced by the cohort's sessions. */
  mergedPrs: number | null;
  /**
   * ISS-5521: whether {@link mergedPrs} was counted over a bounded SAMPLE of the
   * cohort rather than all of it — i.e. the cohort held more than
   * {@link COHORT_SCAN_CAP} sessions and only the first that many were scanned.
   *
   * When true the count is a FLOOR, not a total: distinct merged PRs over a
   * subset can only be less than or equal to the figure over the whole cohort.
   * The card must say so, because "996 merged PRs" described as covering "every
   * session" of a 7,247-session component is a metric whose population silently
   * disagrees with its own label. Same contract as
   * `AgentComponentDetail.branchesTabTruncated` (ISS-5464).
   *
   * OPTIONAL and additive, and its absence is a THIRD state, not a `false`
   * (codex review, #4962). A producer that predates this field omits it while
   * still applying the very same cap, so a consumer that reads omission as "not
   * truncated" re-asserts the full-cohort claim under version skew — the exact
   * defect this field exists to remove. Read omission as UNKNOWN: say nothing
   * about the population's completeness in either direction.
   */
  mergedPrsTruncated?: boolean;
  /**
   * Best-effort avg judge score (0–10) over the cohort's sessions; computed but
   * NOT rendered yet (sparse until judging is integrated). Null for most cohorts.
   */
  qualityScore: number | null;
  /** % lift in quality vs. baseline; null when not computable. */
  qualityDelta: number | null;
};

/**
 * The canonical empty {@link CohortDeliveryMetrics} — every value in its "nothing
 * computable" state (deltas/rates `null`, the efficiency trend `[]`). Used
 * wherever a surface has no org baseline to compare against: the cloud reader's
 * empty-cohort early return (`apps/api/app/agent-components/cohort-performance.ts`)
 * and the desktop-LOCAL component detail, which has no org baseline at all
 * (`apps/desktop/src/main/shared-agent-components-api.ts`). Single-sourced here,
 * next to the type, so the two surfaces can never drift.
 */
export const EMPTY_COHORT_DELIVERY_METRICS: CohortDeliveryMetrics = {
  locDelta: null,
  successRate: null,
  successDelta: null,
  tokenEfficiencyDelta: null,
  efficiencyTrend: [],
  mergedPrs: null,
  mergedPrsTruncated: false,
  qualityScore: null,
  qualityDelta: null,
};

/**
 * Per-pack org-wide analytics (`GET /agent-components/pack/{packId}`) — the
 * rollup over a pack's child components (usage, sessions, LOC/$, adoption).
 * Powers the desktop-team overlay's Team-usage + Performance for a local pack,
 * joined to the cloud by the shared `packId`.
 */
export type PackAnalyticsResponse = {
  packId: string;
  /** Org-wide invocation count across the pack's components. */
  invocations: number;
  /** Distinct sessions that invoked any of the pack's components. */
  sessions: number;
  /**
   * ISS-4667: merged LOC per dollar over those sessions — raw lines per dollar,
   * higher is better. Null when not computable.
   */
  locPerDollar: number | null;
  /**
   * @deprecated ISS-4667 — the KLOC-unit predecessor of {@link locPerDollar}.
   * Present ONLY so a cloud response that predates ISS-4667 is still understood
   * on read (resolve via `resolveLocPerDollar`, which scales it into LOC/$).
   */
  klocPerDollar?: number | null;
  /** Distinct teammates who have used the pack (display names). */
  owners: string[];
  /** Adoption breadth — distinct compute targets (devices). */
  deviceCount: number;
} & CohortDeliveryMetrics;

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
 *
 * The server scans every auto_install distribution to compute `total` (the full
 * gap count), then returns at most `limit` of them in `items`. `truncated` is
 * true when there are more gap rows than `items` carries, so the client can
 * distinguish a genuinely compliant org (empty `items`, `truncated: false`)
 * from a capped page (`truncated: true`). Optional for back-compat: an older
 * client that omits it degrades to treating an empty page as compliant.
 */
export type ComplianceResponse = {
  items: ComplianceItem[];
  total: number;
  truncated?: boolean;
};

/**
 * ISS-5521: upper bound on the number of cohort sessions scanned when computing
 * {@link CohortDeliveryMetrics}. The scan runs on the db-host worker and a busy
 * org's component can hold tens of thousands of sessions, so the bound is the
 * FEA-3132 OOM guard and is deliberate — the defect it caused was never the cap
 * itself, only a capped figure described to the user as covering everything.
 *
 * Owned here, beside the contract whose {@link CohortDeliveryMetrics.mergedPrsTruncated}
 * semantics it defines, so the server that applies the bound
 * (`apps/api/app/agent-components/cohort-performance.ts`) and the card copy that
 * discloses it (`packages/app/agents/lib/detail-data.ts`) read ONE number
 * instead of each spelling it out.
 */
export const COHORT_SCAN_CAP = 2000;

/**
 * How much of a cohort a {@link CohortDeliveryMetrics.mergedPrs} count actually
 * covered — the THREE states {@link CohortDeliveryMetrics.mergedPrsTruncated}
 * can express, named.
 */
export const MergedPrsCoverage = {
  /**
   * The producer declared it scanned only the first {@link COHORT_SCAN_CAP}
   * cohort sessions, so the count is a FLOOR and must be rendered as one.
   */
  Capped: "capped",
  /** The producer declared the count covered the whole session cohort. */
  WholeCohort: "whole-cohort",
  /**
   * The producer declared nothing. A server predating the disclosure applied the
   * same cap and simply could not report it, so this is NOT
   * {@link MergedPrsCoverage.WholeCohort}: say nothing about completeness in
   * either direction.
   */
  Unknown: "unknown",
} as const;
export type MergedPrsCoverage =
  (typeof MergedPrsCoverage)[keyof typeof MergedPrsCoverage];

/**
 * Read {@link CohortDeliveryMetrics.mergedPrsTruncated} as the tri-state it is.
 *
 * Owned here, beside the field whose semantics it decodes, because every surface
 * that renders `mergedPrs` owes the reader the same three claims: the Agents
 * component-detail card (ISS-5521, `packages/app/agents/lib/detail-data.ts`) and
 * the Packs performance tile (ISS-6462,
 * `packages/app/packs/lib/merged-prs-readout.ts`). Re-deriving `=== true` /
 * `=== false` per surface is how one of them ends up folding the omission to
 * "not truncated" and re-asserting a full-cohort claim under version skew.
 */
export function resolveMergedPrsCoverage(
  mergedPrsTruncated: boolean | undefined
): MergedPrsCoverage {
  if (mergedPrsTruncated === true) {
    return MergedPrsCoverage.Capped;
  }
  if (mergedPrsTruncated === false) {
    return MergedPrsCoverage.WholeCohort;
  }
  return MergedPrsCoverage.Unknown;
}
