/**
 * ISS-8554 / PLN-1853 Phase 2 — the reader seam over the TypedSQL summary
 * statements.
 *
 * This module does ONE thing: run statements 3–7 and return their results
 * already coerced out of Postgres types (D11) into the shapes the response
 * contract speaks. It deliberately does NOT build an `AgentSessionUsageSummary`.
 *
 * Keeping the seam here rather than inside a composition function is what lets
 * the flag-gated composition and the response differ both call the same reader,
 * so a divergence the differ reports is a divergence in COMPOSITION and never in
 * how the rows were read. A reader folded into the composer would have to be
 * re-implemented (or mocked) for the differ, which is exactly the shape that
 * lets two "identical" paths disagree.
 *
 * SCOPE, stated so the absence of a field here is not mistaken for the summary
 * omitting it. This module returns ROWS; the composer assembles them. Four
 * things the summary needs are therefore not found in this file, and all four
 * are now implemented in `usage-summary-sql.ts` rather than outstanding:
 * owner display names for `byUser` (`buildUsageOwnerMap`, a users read rather
 * than new SQL), the `byProject` labels (`readProjectNames`),
 * `modelFilterOptions` (`projectModelFilterOptions`), and the prior-window
 * comparison (`readComparison`, which re-runs statements 3, 4 and 6 against the
 * prior bounds and folds them through `foldUsageComparison`).
 *
 * An earlier revision of this note listed those four as still owed before the
 * flag could open. They landed; the note did not, which is exactly the kind of
 * stale prose that makes a reader trust a comment over the code.
 */

import type { SessionQuality } from "@repo/api/src/agent-session-filters";
import { METERED_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { sql, withDb } from "@repo/database";
import {
  countToNumber,
  sumToNumber,
  sumToOptionalNumber,
  timestampToIso,
} from "./typed-sql-scalars";

/**
 * ISS-10150: the graduated `quality` predicate's SQL-facing shape —
 * `SessionQuality` minus its no-op `"all"` member, since "all" means "no
 * predicate" and is represented as `null` here rather than as a fourth string.
 * The single alias so this narrowing exists once rather than as three
 * hand-typed `"substantive" | "idle" | null` unions (this file's facet field
 * and tuple slot, plus `usage-summary-sql.ts`'s resolver) that a fifth
 * `SessionQuality` value could widen independently.
 */
export type QualityMode = Exclude<SessionQuality, "all"> | null;

/** The window every statement here shares. PLN-1853 D3: session activity only. */
export type UsageSqlWindow = {
  organizationId: string;
  /** Inclusive lower bound, or null for an unbounded start. */
  start: Date | null;
  /**
   * Exclusive upper bound — the half-open bound the statements are written
   * against — or null for an unbounded end.
   *
   * Both bounds are optional because `AgentSessionUsageQuery` declares them
   * optional. An unbounded read is a real request, and passing a sentinel date
   * to satisfy a required parameter would be a fabricated filter.
   */
  end: Date | null;
};

/**
 * The optional facet selections. An empty array means "no filter" — never "no
 * matches" — which is why every array is required here rather than optional: an
 * absent key and an empty array would otherwise be two spellings of the same
 * request, and only one of them survives a round trip through a query string.
 *
 * SOME FACETS DO NOT APPEAR AS FIELDS, and their absence is deliberate:
 *
 *   - The singular `userId` collapses into {@link UsageSqlFacets.ownerUserIds}
 *     and `viewerScope=self` into {@link UsageSqlFacets.creatorUserIds}
 *     (ISS-12251).
 *   - `harness`/`status` (the singular back-compat spellings) collapse into
 *     their plural fields.
 *   - `search` is accepted by the query schema for version-skewed desktop
 *     clients and is NOT implemented server-side, so there is nothing to pass.
 *
 * PLN-1853 D13 is now EMPTY (ISS-10753): `quality`, `costBuckets` and
 * `statuses` are all ordinary SQL predicates below, none resolved in
 * TypeScript and none riding a cohort id-list.
 */
export type UsageSqlFacets = {
  /**
   * ISS-12251: the Owner (the `userIds` facet intersected with the singular
   * `userId`), matched against `artifacts.assignee_id`.
   */
  ownerUserIds: string[];
  /**
   * ISS-12251 D-4: the `viewerScope=self` scope, matched against
   * `artifacts.created_by_id`.
   */
  creatorUserIds: string[];
  harnesses: string[];
  repositories: string[];
  models: string[];
  /** ISS-5355: the session->document link. ANDed with {@link projectId}. */
  projectIds: string[];
  /** ISS-5355: the session artifact's OWN parent. ANDed with {@link projectIds}. */
  projectId: string | null;
  /** FEA-3009: `sessionEndedAt >= completedAfter`. Excludes still-running rows. */
  completedAfter: Date | null;
  teamId: string | null;
  /** FEA-2505 ids: "has_changes" / "no_changes". */
  changePresence: string[];
  /** FEA-2505 ids: "has_pr" / "no_pr". */
  prAssociation: string[];
  /**
   * Autonomy tiers as half-open ranges, PAIRED BY POSITION with
   * {@link autonomyUpperBounds}. The label vocabulary stays in TypeScript
   * (`autonomyTierRange`), so only the resolved bounds reach SQL.
   */
  autonomyLowerBounds: number[];
  autonomyUpperBounds: number[];
  /** True when a selected tier is the null-autonomy tier. */
  autonomyIncludesNull: boolean;
  /**
   * ISS-10629 / ISS-10753: a plain equality on `artifacts.status`, resolved by
   * `resolvePersistedStatusFilter` — the SAME helper `applyStatusFacetFilter`
   * uses, so the two paths cannot disagree about which values are selectable.
   *
   * THREE-VALUED, and the third value is the one that matters: `null` is no
   * narrowing, a non-empty array is the equality set, and `[]` is a request
   * whose every value was a display-only status no producer persists —
   * a population that cannot exist. `[]` must NOT read as "no filter" here the
   * way every other array facet does, because `artifacts.status` is freeform
   * and rows literally storing `waiting` exist; widening to the whole org is
   * the exact silent widening the retirement exists to prevent.
   */
  statuses: string[] | null;
  /**
   * ISS-10150: the graduated `quality` predicate — "substantive" | "idle", or
   * null for "all" (no narrowing). Spliced from
   * `prisma/sql-fragments/session-substantive.sql`.
   */
  qualityMode: QualityMode;
  /**
   * ISS-7176 / ISS-10753: the SELECTED numeric cost buckets, as PARALLEL
   * half-open bound arrays — `costBucketRawBounds` stays the vocabulary's
   * single source of truth, only its OUTPUT crosses into SQL, exactly like
   * {@link autonomyLowerBounds}.
   */
  costBucketLowerBounds: number[];
  costBucketUpperBounds: number[];
  /** True when the caller selected the "Unknown" pseudo-bucket. */
  costBucketIncludesUnknown: boolean;
  /**
   * `SUBSCRIPTION_BILLING_MODES`, resolved once so the known/unknown-cost
   * split (`facet-common.sql`) and `sessionCostSplit.sql`'s own subscription
   * arm share one parameter rather than two copies of the same vocabulary.
   */
  subscriptionBillingModes: string[];
  /**
   * ISS-10332: the priority facet's two arms, as `splitPriorityFilter` resolves
   * them. Separate rather than one list because `= ANY(...)` never matches a
   * NULL priority, so folding the unset token into the members would select
   * nothing for it — the same split `buildPriorityFacetWhere` makes on the live
   * path.
   */
  priorityMembers: string[];
  priorityIncludesUnset: boolean;
};

export const EMPTY_USAGE_SQL_FACETS: UsageSqlFacets = {
  ownerUserIds: [],
  creatorUserIds: [],
  harnesses: [],
  repositories: [],
  models: [],
  projectIds: [],
  projectId: null,
  completedAfter: null,
  teamId: null,
  changePresence: [],
  prAssociation: [],
  autonomyLowerBounds: [],
  autonomyUpperBounds: [],
  autonomyIncludesNull: false,
  statuses: null,
  qualityMode: null,
  costBucketLowerBounds: [],
  costBucketUpperBounds: [],
  costBucketIncludesUnknown: false,
  subscriptionBillingModes: [],
  priorityMembers: [],
  priorityIncludesUnset: false,
};

/**
 * The window and facet parameters every summary statement takes, at positions
 * $1..$25. ONE builder, because the four statements are written against an
 * IDENTICAL parameter order on purpose: a facet applied to the totals but not to
 * the cost split is a filtered view reporting unfiltered spend, which is the
 * defect this tuple exists to make structurally impossible. A statement with
 * extra parameters (cost split's own `meteredBillingModes`) appends them AFTER
 * $25 rather than interleaving, so this prefix never has to be special-cased.
 *
 * `packages/database/prisma/sql-fragments/` holds the matching SQL, expanded
 * into each statement by `pnpm run sync:typed-sql` and guarded by
 * `pnpm check:typed-sql-fragments`.
 */
type UsageSqlFacetArgs = [
  organizationId: string,
  windowStart: Date | null,
  windowEnd: Date | null,
  ownerUserIds: string[],
  completedAfter: Date | null,
  repositories: string[],
  harnesses: string[],
  models: string[],
  projectIds: string[],
  teamId: string | null,
  changePresence: string[],
  prAssociation: string[],
  autonomyLowerBounds: number[],
  autonomyUpperBounds: number[],
  autonomyIncludesNull: boolean,
  statuses: string[] | null,
  projectId: string | null,
  qualityMode: QualityMode,
  costBucketLowerBounds: number[],
  costBucketUpperBounds: number[],
  costBucketIncludesUnknown: boolean,
  subscriptionBillingModes: string[],
  priorityMembers: string[],
  priorityIncludesUnset: boolean,
  creatorUserIds: string[],
];

/**
 * ISS-8554 Phase 3: exported so the list-sort reader can build the SAME
 * 25-slot prefix the summary statements take, keeping the facet tuple's
 * ordering to ONE builder across both phases.
 */
export function facetArgs(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): UsageSqlFacetArgs {
  return [
    window.organizationId,
    window.start,
    window.end,
    facets.ownerUserIds,
    facets.completedAfter,
    facets.repositories,
    facets.harnesses,
    facets.models,
    facets.projectIds,
    facets.teamId,
    facets.changePresence,
    facets.prAssociation,
    facets.autonomyLowerBounds,
    facets.autonomyUpperBounds,
    facets.autonomyIncludesNull,
    facets.statuses,
    facets.projectId,
    facets.qualityMode,
    facets.costBucketLowerBounds,
    facets.costBucketUpperBounds,
    facets.costBucketIncludesUnknown,
    facets.subscriptionBillingModes,
    facets.priorityMembers,
    facets.priorityIncludesUnset,
    facets.creatorUserIds,
  ];
}

export type UsageSqlTotals = {
  sessionCount: number;
  earliestSessionAt: string | null;
  latestSessionAt: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

/**
 * The three ledgers, each kept OPTIONAL.
 *
 * Unlike the totals, a null ledger here is not "the population was empty" — it
 * is "nothing classified into this ledger", and a caller deciding what to
 * publish may care which. `resolveLocPerDollarCostBasis` picks a divisor from
 * these, and dividing by a fabricated 0 is not the same failure as declining to
 * divide at all.
 */
export type UsageSqlCostSplit = {
  subscriptionCost: number | null;
  meteredCost: number | null;
  unclassifiedCost: number | null;
};

/**
 * One facet option, with the per-option totals its breakdown publishes.
 *
 * Every dimension carries the same fields even where its response type ignores
 * some — `byUser` publishes no error count, `byRepository` no cache tokens. The
 * statement returns a uniform row on purpose (see its header), and narrowing
 * here per dimension would just move that asymmetry into a second place.
 */
export type UsageSqlFacetCount = {
  dimension: "owner" | "harness" | "repository" | "model" | "project";
  /** Null is a real option — an unattributed repository, model, or project. */
  value: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  errorCount: number;
};

export type UsageSqlMergedPrLoc = {
  mergedPrCount: number;
  /** Null when no merged pull request carried usable line counts (D4). */
  mergedLoc: number | null;
  /** Merged pull requests dropped for a null `additions` or `deletions` (D4). */
  excludedPrCount: number;
  /**
   * Median lines changed across the merged population, or null when none
   * carried usable counts.
   *
   * Arrives as `double precision` — `percentile_cont` already returns a
   * JavaScript number, so unlike every other figure here it needs no coercion.
   * The statement uses `percentile_cont` rather than `percentile_disc` to match
   * the JS median it replaces; on `[10, 90]` those differ by 40.
   */
  medianPrSize: number | null;
};

/**
 * The four counts `foldLocPerDollarCoverage` folds. That fold is pure and is
 * reused unchanged; only the reads moved here.
 *
 * The population is WIDER than statement 6's on purpose (ISS-7905): the Metric
 * session-to-PR arms PLUS a non-prose session-to-branch link. See the statement.
 */
export type UsageSqlLocCoverageCounts = {
  numeratorSessionCount: number;
  coveredNumeratorSessionCount: number;
  migrationPendingSessionCount: number;
  unrevisionedSessionCount: number;
};

export type UsageSqlLastSyncTarget = {
  id: string;
  /** NOT NULL in the column; the statement inner-joins so this cannot be absent. */
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  lastAgentSessionSyncAttemptAt: Date | null;
  /** `compute_targets.user_id` is NOT NULL, so every target has one. */
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
};

const FACET_DIMENSIONS = new Set<UsageSqlFacetCount["dimension"]>([
  "owner",
  "harness",
  "repository",
  "model",
  "project",
]);

export function readUsageTotals(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): Promise<UsageSqlTotals> {
  return withDb(async (db) => {
    const [row] = await db.$queryRawTyped(
      sql.sessionUsageTotals(...facetArgs(window, facets))
    );
    return {
      sessionCount: countToNumber(row?.session_count ?? null),
      earliestSessionAt: timestampToIso(row?.earliest_session_at ?? null),
      latestSessionAt: timestampToIso(row?.latest_session_at ?? null),
      inputTokens: sumToNumber(row?.input_tokens ?? null),
      outputTokens: sumToNumber(row?.output_tokens ?? null),
      cacheReadTokens: sumToNumber(row?.cache_read_tokens ?? null),
      cacheWriteTokens: sumToNumber(row?.cache_write_tokens ?? null),
      estimatedCost: sumToNumber(row?.estimated_cost ?? null),
    };
  });
}

/**
 * `facets.subscriptionBillingModes` is already the shared vocabulary
 * (`facetArgs` carries it at $22); `meteredBillingModes` is THIS statement's
 * own extra parameter at $26, appended after the shared prefix that ISS-10332's
 * two priority arms and ISS-12251's creator scope extended to $25. Both
 * vocabularies are passed rather than inlined in the statement, so
 * `billing-mode.ts` stays the single source of truth. Sorted so the emitted
 * parameter is stable between
 * calls — a `Set` preserves insertion order, which is not a contract worth
 * depending on for a query key.
 */
export function readCostSplit(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): Promise<UsageSqlCostSplit> {
  return withDb(async (db) => {
    const [row] = await db.$queryRawTyped(
      sql.sessionCostSplit(
        ...facetArgs(window, facets),
        [...METERED_BILLING_MODES].sort()
      )
    );
    return {
      subscriptionCost: sumToOptionalNumber(row?.subscription_cost ?? null),
      meteredCost: sumToOptionalNumber(row?.metered_cost ?? null),
      unclassifiedCost: sumToOptionalNumber(row?.unclassified_cost ?? null),
    };
  });
}

export function readFacetCounts(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): Promise<UsageSqlFacetCount[]> {
  return withDb(async (db) => {
    const rows = await db.$queryRawTyped(
      sql.sessionFacetCounts(...facetArgs(window, facets))
    );
    return rows.flatMap((row) => {
      // The statement's `dimension` is a SQL literal, so this narrowing can only
      // fail if a branch is added there without a matching member here. Dropping
      // the row rather than widening the type keeps that mismatch loud in tests
      // instead of leaking an unhandled dimension to a caller's switch.
      const dimension = row.dimension as UsageSqlFacetCount["dimension"];
      if (!FACET_DIMENSIONS.has(dimension)) {
        return [];
      }
      return [
        {
          dimension,
          value: row.value,
          sessionCount: countToNumber(row.session_count),
          // Collapsed rather than kept optional: a facet option only exists
          // because at least one session produced it, so a null sum here means
          // that option's sessions totalled nothing — a real zero, not an
          // absent population. `sessionCount` is the recovery signal.
          inputTokens: sumToNumber(row.input_tokens),
          outputTokens: sumToNumber(row.output_tokens),
          cacheReadTokens: sumToNumber(row.cache_read_tokens),
          cacheWriteTokens: sumToNumber(row.cache_write_tokens),
          estimatedCost: sumToNumber(row.estimated_cost),
          errorCount: countToNumber(row.error_count),
        },
      ];
    });
  });
}

export function readMergedPrLoc(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): Promise<UsageSqlMergedPrLoc> {
  return withDb(async (db) => {
    const [row] = await db.$queryRawTyped(
      sql.sessionMergedPrLoc(...facetArgs(window, facets))
    );
    return {
      mergedPrCount: countToNumber(row?.merged_pr_count ?? null),
      // Kept optional: no merged pull request with usable counts is not the same
      // as a merged population that changed zero lines, and the LOC/$ numerator
      // is the one place that difference decides whether to publish a ratio.
      mergedLoc: sumToOptionalNumber(row?.merged_loc ?? null),
      excludedPrCount: countToNumber(row?.excluded_pr_count ?? null),
      // Already a number, and null carries the same meaning as mergedLoc's:
      // no merged pull request had usable counts, which is not a median of 0.
      medianPrSize: row?.median_pr_size ?? null,
    };
  });
}

export function readLocCoverageCounts(
  window: UsageSqlWindow,
  facets: UsageSqlFacets
): Promise<UsageSqlLocCoverageCounts> {
  return withDb(async (db) => {
    const [row] = await db.$queryRawTyped(
      sql.sessionLocCoverageCounts(...facetArgs(window, facets))
    );
    return {
      numeratorSessionCount: countToNumber(
        row?.numerator_session_count ?? null
      ),
      coveredNumeratorSessionCount: countToNumber(
        row?.covered_numerator_session_count ?? null
      ),
      migrationPendingSessionCount: countToNumber(
        row?.migration_pending_session_count ?? null
      ),
      unrevisionedSessionCount: countToNumber(
        row?.unrevisioned_session_count ?? null
      ),
    };
  });
}

/**
 * The freshness card's page.
 *
 * `userId` and `teamId` mirror `buildLastSyncTargetWhere`: when the caller
 * selected an owner or a team, this card narrows with the rest of the summary.
 * Null means no filter. Omitting them widened the card to every target in the
 * organisation while every other figure on the page stayed scoped.
 */
export function readLastSyncTargets(
  organizationId: string,
  pageSize: number,
  scope: { userId: string | null; teamId: string | null } = {
    userId: null,
    teamId: null,
  }
): Promise<UsageSqlLastSyncTarget[]> {
  return withDb(async (db) => {
    const rows = await db.$queryRawTyped(
      sql.sessionLastSyncTargets(
        organizationId,
        pageSize,
        scope.userId,
        scope.teamId
      )
    );
    return rows.map((row) => ({
      id: row.id,
      machineName: row.machine_name,
      isOnline: row.is_online,
      lastSeenAt: row.last_seen_at,
      lastAgentSessionSyncAt: row.last_agent_session_sync_at,
      lastAgentSessionSyncAttemptAt: row.last_agent_session_sync_attempt_at,
      user: {
        id: row.user_id,
        email: row.user_email,
        firstName: row.first_name,
        lastName: row.last_name,
        avatarUrl: row.avatar_url,
      },
    }));
  });
}
