// Cohort delivery-performance metrics (FEA-2923 — Performance tab restore).
//
// One shared computation for BOTH analytics surfaces that carry a Performance
// tab, keyed off a set of session ids (the "cohort"):
//   - per-pack   → `getPackAnalytics` (desktop-team overlay), cohort = pack's
//                  child-usage sessions
//   - per-agent  → `getDetailForOrg` (web admin/member), cohort = the agent
//                  component's sessions
//
// The prototype's Performance tab is the SoT for the SHAPE: compare sessions
// that USE the pack/component against a BASELINE of org sessions that do not.
// Every value here is REAL — no fabricated numbers; a delta is `null` when its
// baseline is not computable (the card renders without a delta, never faked).
//
// POPULATION (ISS-9853, PRD-666: "a retained prefix is never the population").
// The cohort is walked in full — every id the caller hands over, in bounded
// chunks (`./cohort-walk.ts`) — so `successRate`, `mergedPrs` and the LOC/token
// figures describe every cohort session, never the first 2,000. What the walk
// cannot know is whether the id list IS the cohort: the component-detail path
// hands over its usage lane's bounded SAMPLE (ISS-9852), so the caller attests
// that with `cohortSampled`, which is published as `mergedPrsTruncated`.
//
// BOUNDEDNESS (this repo has a documented history of db-host OOMs from
// unbounded scans — see FEA-3132 / the insights bounded-fan-out rule): the
// baseline never materializes an org's full session history. LOC/token deltas
// use exact DB `_sum` aggregates (no rows returned); the success-rate
// comparator reads a most-recent baseline SAMPLE of
// `BASELINE_SAMPLE_CAP` rows, and the response DISCLOSES that sample's size so
// the "vs. baseline" chip never presents the sample as the population.

import {
  type CohortDeliveryMetrics,
  EMPTY_COHORT_DELIVERY_METRICS,
} from "@repo/api/src/types/analytics";
import {
  type LocPerDollarCostMember,
  locPerDollarDenominatorCost,
  locPerDollarFromPopulation,
} from "@repo/api/src/utils/loc-per-dollar";
import {
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "@repo/api/src/utils/session-loc";
import type { withDb } from "@repo/database";
import { isLocEnriched } from "@repo/lib/branches/loc-per-dollar";
import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import {
  type BaselineSessionWindow,
  baselineSessionWhere,
  computeDedupedBaselineLoc,
} from "./cohort-baseline-loc";
import {
  CohortMetricScope,
  type CorruptCohortMetricCounts,
  hasNegativeLoc,
  reportBaselineOverBindCeiling,
  reportCorruptCohortMetric,
} from "./cohort-metric-integrity";
import {
  COHORT_SESSION_SELECT,
  type CohortSessionScalars,
  loadCohortFallbackBranchIdentities,
  type PrOutcome,
  prOutcomeOf,
  walkCohort,
} from "./cohort-walk";
import {
  type SessionLocBranchIdentity,
  sessionLocEntryBranchIdentity,
} from "./session-loc-branch-identity";
import { BIND_PARAMETERS_RESERVED_PER_STATEMENT } from "./usage-bind-budget";

type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * Most-recent baseline sessions sampled for the success-rate comparator.
 *
 * ISS-9853 (RULING 4): a deliberate COMPARATOR sample, kept. PRD-666 permits a
 * bound on one batch, and a comparator is not a record a user retrieves; what it
 * forbids is presenting the sample as the population, so the size actually read
 * is published as `CohortDeliveryMetrics.baselineSampleSize` whenever the window
 * held more than this, and the Success-rate chip names it. The LOC/token deltas
 * beside it are whole-window aggregates and carry no sample.
 */
export const BASELINE_SAMPLE_CAP = 500;
/** Buckets in the token-efficiency sparkline (matches the prototype's 8). */
const EFFICIENCY_TREND_BUCKETS = 8;

/**
 * Empty result — no cohort sessions, so nothing is computable. Re-exported from
 * the canonical `EMPTY_COHORT_DELIVERY_METRICS` SSOT (in
 * `@repo/api/src/types/analytics`) so the cloud and desktop-local surfaces share
 * one empty-metrics literal instead of each redeclaring it.
 */
export const EMPTY_COHORT_METRICS: CohortDeliveryMetrics =
  EMPTY_COHORT_DELIVERY_METRICS;

/**
 * What the caller knows about its id list that the walk cannot see.
 *
 * `cohortSampled` is true when the ids are a bounded SAMPLE of the cohort — the
 * component-detail usage lane hit its row bound (ISS-9852), so the sessions
 * behind the rows it kept are all it could name. Required rather than defaulted:
 * a default of `false` would fold a producer's silence into a whole-cohort claim,
 * the ISS-5521 hazard one layer down.
 */
export type CohortPerformanceOptions = {
  cohortSampled: boolean;
};

// ---------------------------------------------------------------------------
// Pure math (unit-tested without a DB)
// ---------------------------------------------------------------------------

/** Total local-git lines a session changed (added + removed), 0 when unknown. */
export function sessionLoc(
  linesAdded: number | null,
  linesRemoved: number | null
): number {
  return (linesAdded ?? 0) + (linesRemoved ?? 0);
}

/**
 * Tokens spent per LINE of work: tokens / LOC. Null unless both positive.
 *
 * ISS-8184 ruling 5 dropped the `/ 1000`, so this reads ~1000x smaller than it
 * did. Safe to rescale because the only thing downstream of it is
 * `tokenEfficiencyDeltaOf`, a PERCENTAGE delta — and a ratio's percentage change
 * does not depend on the ratio's scale, so the rendered Performance-tab figure
 * moves by nothing. Nothing renders this value raw; `BaselineComparators` is
 * file-local and unexported, so it is not a wire type either.
 */
export function tokensPerLocOf(
  tokenTotal: number,
  locTotal: number
): number | null {
  if (tokenTotal <= 0 || locTotal <= 0) {
    return null;
  }
  return tokenTotal / locTotal;
}

/** KLOC produced per 1k tokens — the "efficiency" sparkline unit (higher = better). */
export function klocPer1kTokensOf(
  locTotal: number,
  tokenTotal: number
): number | null {
  if (locTotal <= 0 || tokenTotal <= 0) {
    return null;
  }
  return locTotal / 1000 / (tokenTotal / 1000);
}

/**
 * Signed % lift of `cohort` over `baseline`. Null when either is null or
 * baseline is 0. Rounded to a whole percent — mirroring the insights SSOT
 * (`pctDelta` in `packages/loops-api/src/insights.ts`, `Math.round` to whole
 * percent) — because the UI delta chip (`MetricCard`) renders this value raw
 * (`{delta}%`), so an unrounded float would show as e.g. `+18.473684%`.
 */
export function pctDelta(
  cohort: number | null,
  baseline: number | null
): number | null {
  if (cohort === null || baseline === null || baseline === 0) {
    return null;
  }
  return Math.round(((cohort - baseline) / Math.abs(baseline)) * 100);
}

/**
 * Token-efficiency % lift: positive means the cohort spends FEWER tokens per
 * KLOC than the baseline (inverted vs. `pctDelta`, since lower tokens/KLOC is
 * better). Null when either input is null or the baseline is 0. Rounded to a
 * whole percent (same insights-SSOT convention as {@link pctDelta}) since the
 * value renders raw in the UI as a `%` headline.
 */
export function tokenEfficiencyDeltaOf(
  cohortTokensPerLoc: number | null,
  baselineTokensPerLoc: number | null
): number | null {
  if (
    cohortTokensPerLoc === null ||
    baselineTokensPerLoc === null ||
    baselineTokensPerLoc === 0
  ) {
    return null;
  }
  return Math.round(
    ((baselineTokensPerLoc - cohortTokensPerLoc) / baselineTokensPerLoc) * 100
  );
}

/**
 * Percentage-point delta between two rates (already 0–100). Null when either is
 * null. Rounded to a whole percentage point (same insights-SSOT convention as
 * {@link pctDelta}) since the value renders raw in the UI delta chip.
 */
export function ppDelta(
  cohortPct: number | null,
  baselinePct: number | null
): number | null {
  if (cohortPct === null || baselinePct === null) {
    return null;
  }
  return Math.round(cohortPct - baselinePct);
}

/**
 * Bucket time-stamped `(loc, tokens)` points into `bucketCount` equal windows
 * over [min, max] time and return each window's KLOC-per-1k-tokens efficiency
 * (0 for empty windows), oldest → newest. Empty input → `[]`.
 */
export function efficiencyTrendOf(
  points: readonly EfficiencyTrendPoint[],
  bucketCount = EFFICIENCY_TREND_BUCKETS
): number[] {
  if (points.length === 0) {
    return [];
  }
  const { min, max } = timeBounds(points);
  const span = max - min;
  // FEA-3633: LOC per bucket is deduped PER BRANCH — a branch's fallback total
  // counts once within a bucket, not once per authoring session. Collect the
  // per-bucket LOC entries and reduce them with the shared dedup helper.
  const locEntriesByBucket: SessionLocEntry[][] = Array.from(
    { length: bucketCount },
    () => []
  );
  const tokByBucket = new Array<number>(bucketCount).fill(0);
  for (const point of points) {
    // span === 0 (all sessions same instant) collapses to the last bucket.
    const ratio = span === 0 ? 1 : (point.time - min) / span;
    const index = Math.min(bucketCount - 1, Math.floor(ratio * bucketCount));
    locEntriesByBucket[index].push({
      loc: point.loc,
      locSource: point.locSource,
      repositoryFullName: point.repositoryFullName,
      branch: point.branch,
    });
    tokByBucket[index] += point.tokens;
  }
  return locEntriesByBucket.map(
    (entries, i) =>
      klocPer1kTokensOf(
        sumSessionLocDedupedByBranch(entries),
        tokByBucket[i]
      ) ?? 0
  );
}

/**
 * One session's contribution to the efficiency-trend sparkline (FEA-3633): a
 * `SessionLocEntry` (LOC + branch provenance for the per-branch dedup) plus the
 * session's time and token totals.
 */
export type EfficiencyTrendPoint = SessionLocEntry & {
  time: number;
  tokens: number;
};

// ---------------------------------------------------------------------------
// DB aggregation (bounded)
// ---------------------------------------------------------------------------

/** Success rate (%) over a PR outcome, or null when the cohort has no sessions. */
function successRateOf(outcome: PrOutcome): number | null {
  if (outcome.total === 0) {
    return null;
  }
  return (outcome.sessionsWithMergedPr / outcome.total) * 100;
}

/**
 * FEA-3633: a cohort row's LOC contribution tagged with the provenance needed to
 * dedup the branch/PR-total fallback per branch (see `sumSessionLocDedupedByBranch`).
 */
function cohortLocEntry(
  row: CohortSessionScalars,
  fallbackBranchBySession: ReadonlyMap<string, SessionLocBranchIdentity>
): SessionLocEntry {
  const branchIdentity = sessionLocEntryBranchIdentity(
    row.artifactId,
    fallbackBranchBySession,
    row.repositoryFullName
  );
  return {
    loc: sessionLoc(row.linesAdded, row.linesRemoved),
    locSource: row.locSource,
    repositoryFullName: branchIdentity.repositoryFullName,
    branch: branchIdentity.branch,
  };
}

/**
 * Aggregate LOC + token + cost scalars over a set of cohort rows. LOC is deduped
 * PER BRANCH (FEA-3633): a branch whose LOC came from the branch/PR-total fallback
 * counts once across its authoring sessions, not once per session. Tokens + cost
 * still sum per-session (they are genuinely per-session).
 *
 * ISS-9751: `coverageComplete` reports whether BOTH terms span the same rows.
 *
 * DENOMINATOR. `SessionDetail.estimatedCost` is nullable (ISS-8515 dropped its
 * `DEFAULT 0`; the ingest writes null rather than pricing a session it cannot
 * price), and the previous `?? 0` made an unpriced session indistinguishable
 * from a free one — its lines entered the numerator while its cost never
 * entered the denominator, so the ratio rose with every session the pricing
 * pipeline could not reach. What counts as measured is the owner's decision,
 * not this surface's.
 *
 * NUMERATOR — narrowly, and only where the divider swap would otherwise
 * FABRICATE. The owner publishes a cohort `0` as a real answer, but its own
 * word is a "verified"/"known-zero" numerator. `linesAdded`/`linesRemoved` are
 * `Int?` too and {@link sessionLoc} folds a missing count to 0, so a cohort
 * nobody measured arrives at that divider looking exactly like one that
 * verifiably shipped nothing; the session-scoped divider this replaced happened
 * to reject both under `lines > 0`. A POSITIVE fold cannot be that
 * fabrication, so it publishes as before — only a ZERO one has to prove every
 * row was measured.
 *
 * The two terms are ASYMMETRIC about measuredness, deliberately and by decision
 * (Marisol, 2026-09-10). An unpriced row disqualifies the ratio; an unmeasured-LOC
 * row does not, though both shorten one term. What separates them is whether
 * zero is a defensible reading of the absence: "this session shipped no lines"
 * is one — null LOC is the normal state of a session the desktop never enriched
 * — while "this session was free" is not, so an absent cost can only be a hole.
 * Cost measuredness therefore does suppress, through
 * `denominator.coverageComplete`. The only LOC-measuredness term is the
 * `unmeasuredLocRows` conjunct below, and `loc > 0` excuses it: it bites only
 * on a ZERO fold, guarding the fabrication above rather than coverage.
 *
 * What that costs is real and is accepted, not overlooked: a cohort where only
 * some rows carry LOC still publishes a ratio, over a numerator diluted by the
 * rows that carry none. Do not resolve the asymmetry into symmetry — it would
 * take a ratio away from cohorts that show one today, and it is settled rather
 * than pending. It also agrees with the org-level fold's call on the same
 * column ("cost measured, NO lines — INCLUDED. Real, common", Cosimo 2026-09-02,
 * `./loc-per-dollar.ts`). Measuredness is `isLocEnriched`, the AND-of-present
 * the branches kernel already owns — the predicate only, not that module's
 * even-split estimand.
 *
 * That predicate rules out NULLS and nothing else, so a corrupt NEGATIVE count
 * passes it. `sumSessionLocDedupedByBranch` clamps such a row to zero, which
 * lands it at the divider looking exactly like the verified zero above — so
 * `hasNegativeLoc` fails the verdict separately, and unconditionally.
 */
function sumScalars(
  rows: readonly CohortSessionScalars[],
  fallbackBranchBySession: ReadonlyMap<string, SessionLocBranchIdentity>
): {
  loc: number;
  tokens: number;
  cost: number;
  coverageComplete: boolean;
  corrupt: CorruptCohortMetricCounts;
} {
  let tokens = 0;
  let unmeasuredLocRows = 0;
  const costMembers: LocPerDollarCostMember[] = [];
  for (const row of rows) {
    tokens += Number(row.inputTokens) + Number(row.outputTokens);
    if (
      !isLocEnriched({ additions: row.linesAdded, deletions: row.linesRemoved })
    ) {
      unmeasuredLocRows += 1;
    }
    costMembers.push({ costUsd: rowCostUsd(row) });
  }
  const denominator = locPerDollarDenominatorCost(costMembers);
  const loc = sumSessionLocDedupedByBranch(
    rows.map((row) => cohortLocEntry(row, fallbackBranchBySession))
  );
  const corrupt = corruptCohortCounts(rows);
  return {
    loc,
    tokens,
    cost: denominator.cost,
    // A NEGATIVE line count fails the verdict outright, and is deliberately NOT
    // excused by the `loc > 0` arm the way an unmeasured row is: a null LOC is
    // the normal state of a session the desktop never enriched, so a positive
    // fold proves it was not the fabricated zero — but a negative row is a
    // broken row whatever the rest of the cohort sums to, and
    // `sumSessionLocDedupedByBranch` has already clamped it out of `loc`.
    coverageComplete:
      denominator.coverageComplete &&
      (corrupt.negativeLocRows ?? 0) === 0 &&
      (loc > 0 || unmeasuredLocRows === 0),
    corrupt,
  };
}

/** One row's persisted cost as a number, or `null` when it was never priced. */
function rowCostUsd(row: CohortSessionScalars): number | null {
  return row.estimatedCost === null ? null : Number(row.estimatedCost);
}

/**
 * The corrupt values {@link sumScalars}'s rows carry, for the monitored event.
 * A second pass over an already-capped row set rather than more branches inside
 * the fold, so the accounting stays legible next to the arithmetic it guards.
 */
function corruptCohortCounts(
  rows: readonly CohortSessionScalars[]
): CorruptCohortMetricCounts {
  let negativeCostRows = 0;
  let negativeLocRows = 0;
  let minimumCostUsd: number | null = null;
  for (const row of rows) {
    if (hasNegativeLoc(row)) {
      negativeLocRows += 1;
    }
    const costUsd = rowCostUsd(row);
    if (costUsd !== null && costUsd < 0) {
      negativeCostRows += 1;
      minimumCostUsd =
        minimumCostUsd === null ? costUsd : Math.min(minimumCostUsd, costUsd);
    }
  }
  return {
    negativeCostRows,
    minimumCostUsd,
    negativeLocRows,
    rowCount: rows.length,
  };
}

/**
 * Compute the comparison-based delivery metrics for a cohort of sessions against
 * a bounded baseline of org sessions that are NOT in the cohort, within the
 * cohort's active time window. Returns `EMPTY_COHORT_METRICS` when the cohort is
 * empty (nothing to compare).
 */
export async function computeCohortPerformance(
  db: DbClient,
  organizationId: string,
  cohortSessionIds: readonly string[],
  options: CohortPerformanceOptions
): Promise<CohortDeliveryMetrics> {
  if (cohortSessionIds.length === 0) {
    return EMPTY_COHORT_METRICS;
  }
  const { cohortSampled } = options;

  // 1. Every cohort row, in bounded chunks, folded as it streams past.
  const walk = await walkCohort(db, organizationId, cohortSessionIds);

  if (walk.scalars.length === 0) {
    // Nothing of this org's behind the ids — but the ids were still the
    // caller's sample or its cohort, and the empty count owes the reader the
    // same disclosure a populated one would.
    return { ...EMPTY_COHORT_METRICS, mergedPrsTruncated: cohortSampled };
  }

  // 2. Baseline: org sessions in the cohort's window, excluding the ENTIRE
  //    cohort — or no baseline at all when that exclusion cannot be built.
  const baselineWindow = baselineWindowFor(cohortSessionIds, walk.scalars, {
    organizationId,
    cohortSampled,
  });

  // ISS-9114: the branch identities and the whole baseline lane depend only on
  // the walk and on nothing produced by each other, so they run as one concurrent batch instead of a serial train.
  const [fallbackBranchBySession, baseline] = await Promise.all([
    loadCohortFallbackBranchIdentities(
      db,
      organizationId,
      walk.fallbackSessionIds
    ),
    baselineWindow
      ? loadBaselineComparators(db, organizationId, baselineWindow)
      : Promise.resolve(null),
  ]);

  const cohortScalars = sumScalars(walk.scalars, fallbackBranchBySession);
  reportCorruptCohortMetric(
    organizationId,
    CohortMetricScope.Cohort,
    cohortScalars.corrupt
  );
  const cohortLocPerDollar = locPerDollarFromPopulation({
    lines: cohortScalars.loc,
    cost: cohortScalars.cost,
    coverageComplete: cohortScalars.coverageComplete,
  });
  const cohortTokensPerLoc = tokensPerLocOf(
    cohortScalars.tokens,
    cohortScalars.loc
  );
  const cohortSuccessRate = successRateOf(walk.prOutcome);

  const efficiencyTrend = efficiencyTrendOf(
    walk.scalars.map((row) => ({
      time: row.sessionStartedAt.getTime(),
      tokens: Number(row.inputTokens) + Number(row.outputTokens),
      ...cohortLocEntry(row, fallbackBranchBySession),
    }))
  );

  return {
    locDelta: pctDelta(cohortLocPerDollar, baseline?.locPerDollar ?? null),
    successRate: cohortSuccessRate,
    successDelta: ppDelta(cohortSuccessRate, baseline?.successRate ?? null),
    tokenEfficiencyDelta: tokenEfficiencyDeltaOf(
      cohortTokensPerLoc,
      baseline?.tokensPerLoc ?? null
    ),
    efficiencyTrend,
    mergedPrs: walk.prOutcome.distinctMergedPrs.size,
    mergedPrsTruncated: cohortSampled,
    baselineSampleSize: baseline ? baselineSampleSizeOf(baseline) : null,
    // ISS-12435: quality was the mean judge score of the loops behind the
    // cohort. Loops are removed, so there is no loop to score; the field keeps
    // its existing null state (it is computed but not rendered).
    qualityScore: null,
    qualityDelta: null,
  };
}

/**
 * The comparator sample's size when the window may hold more than it, else
 * null. The sample rows and the window's `_count._all` come from two statements
 * with no shared snapshot (the ISS-9751 shape), and the race runs both ways: a
 * row inserted after the sample read turns 500-of-500 into "sampled 500 of
 * 501", which only ADDS a disclosure — but a row inserted after the COUNT read
 * leaves 500 rows beside a count of 500 while the window already holds 501, and
 * `sampleSize < count` would then publish a whole-window claim over a sampled
 * comparator. So a sample that FILLED the cap is disclosed on its own evidence,
 * whatever the count said: "vs. last 500" stays true when the window holds
 * exactly 500, and the count decides only below the cap, where the read itself
 * proves it covered the window. An empty sample beside a nonzero count is the
 * first race from the other side and is not a sample size at all.
 */
function baselineSampleSizeOf(baseline: BaselineComparators): number | null {
  if (baseline.sampleSize === 0) {
    return null;
  }
  const sampled =
    baseline.sampleSize >= BASELINE_SAMPLE_CAP ||
    baseline.sampleSize < baseline.windowSessionCount;
  return sampled ? baseline.sampleSize : null;
}

/**
 * The baseline window for a cohort, or `null` when no unbiased baseline can be
 * built — in which case every delta is `null` and no baseline statement runs.
 *
 * Two fail-closed branches, both preferred to a biased comparison:
 *  - the ids are a SAMPLE of the cohort (`cohortSampled`): a `notIn` of the
 *    sample would count the unsampled cohort sessions inside the window as
 *    sessions that did NOT use the component, biasing every delta;
 *  - the whole-cohort `notIn` would put the statement past the driver's
 *    bind-parameter ceiling. The ceiling that binds is Prisma's BUILT-statement
 *    one: the raw-SQL half of the baseline (`cohort-baseline-loc.ts`,
 *    `Prisma.join`) carries the same id list under the higher VERBATIM ceiling,
 *    so a list the built predicate accepts is one the raw statement accepts.
 *    Reported, because it is the one residual where a large cohort loses a
 *    capability rather than a precision.
 */
function baselineWindowFor(
  cohortSessionIds: readonly string[],
  cohortRows: readonly CohortSessionScalars[],
  scope: { organizationId: string; cohortSampled: boolean }
): BaselineSessionWindow | null {
  if (scope.cohortSampled) {
    return null;
  }
  const bounds = timeBounds(
    cohortRows.map((row) => ({ time: row.sessionStartedAt.getTime() }))
  );
  const window: BaselineSessionWindow = {
    organizationId: scope.organizationId,
    excludedSessionIds: cohortSessionIds,
    startDate: new Date(bounds.min),
    endDate: new Date(bounds.max),
  };
  const bindParameters =
    countPredicateBindParameters(baselineSessionWhere(window)) +
    BIND_PARAMETERS_RESERVED_PER_STATEMENT;
  if (bindParameters > POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS) {
    reportBaselineOverBindCeiling(scope.organizationId, {
      cohortSize: cohortSessionIds.length,
      bindParameters,
      ceiling: POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
    });
    return null;
  }
  return window;
}

/** The three baseline figures the cohort's deltas are taken against, and how much of the window the sampled one saw. */
type BaselineComparators = {
  locPerDollar: number | null;
  tokensPerLoc: number | null;
  successRate: number | null;
  /** Rows the success comparator was read from. */
  sampleSize: number;
  /** Rows the window held, from the same aggregate as the `_sum`s. */
  windowSessionCount: number;
};

/**
 * Read the baseline comparators over one window.
 *
 * The reads are mutually independent — a rowless aggregate carrying both the
 * tokens/cost `_sum` and the LOC/$ coverage verdict over it, the
 * per-branch-deduped LOC fold, and the capped most-recent sample the success rate
 * comes from — so ISS-9114 issues them concurrently instead of as
 * serial waits over the same scope.
 *
 * FEA-3633: baseline LOC is deduped PER BRANCH — a branch/PR-total fallback counts
 * once per branch, not once per authoring session. Both halves stay bounded:
 * aggregates return no rows, and the keyed branch rows are capped defensively —
 * the FEA-3132 OOM guard holds.
 */
async function loadBaselineComparators(
  db: DbClient,
  organizationId: string,
  baseline: BaselineSessionWindow
): Promise<BaselineComparators> {
  const baselineWhere = baselineSessionWhere(baseline);
  const [baselineAgg, dedupedLoc, baselineRows] = await Promise.all([
    db.sessionDetail.aggregate({
      where: baselineWhere,
      _sum: {
        estimatedCost: true,
        inputTokens: true,
        outputTokens: true,
      },
      // ISS-9751: `_sum` skips nulls, so this is a denominator over the PRICED
      // baseline rows while `computeDedupedBaselineLoc` folds a numerator over
      // ALL of them, and the coverage verdict is the PROOF the two terms cover
      // the same rows.
      //
      // That proof has to be observed in the SAME statement as the sum it
      // certifies. A separate `count` is a second READ COMMITTED snapshot: a row
      // this `_sum` skipped as unpriced can be priced by the pricing pipeline
      // before the count runs, the count then finds nothing, and the guard
      // certifies complete coverage over a denominator that is short that row's
      // cost — publishing exactly the mismatched ratio it exists to suppress,
      // silently, and most often under the load that keeps the pricing pipeline
      // busy. `_count` skips nulls the way `_sum` does, so `_all - estimatedCost`
      // IS the set this sum left out; `_min` carries the negative arm, which
      // `locPerDollarDenominatorCost` treats as unmeasured rather than a discount.
      _count: { _all: true, estimatedCost: true },
      _min: { estimatedCost: true },
    }),
    computeDedupedBaselineLoc(db, baseline),
    db.sessionDetail.findMany({
      where: baselineWhere,
      select: COHORT_SESSION_SELECT,
      orderBy: { sessionStartedAt: "desc" },
      take: BASELINE_SAMPLE_CAP,
    }),
  ]);

  const baselineTokens =
    Number(baselineAgg._sum.inputTokens ?? 0n) +
    Number(baselineAgg._sum.outputTokens ?? 0n);
  const baselineCost = Number(baselineAgg._sum.estimatedCost ?? 0);
  const costCoverage = baselineCostCoverage({
    rowCount: baselineAgg._count._all,
    pricedRows: baselineAgg._count.estimatedCost,
    minimumCostUsd:
      baselineAgg._min.estimatedCost === null
        ? null
        : Number(baselineAgg._min.estimatedCost),
  });
  reportCorruptCohortMetric(organizationId, CohortMetricScope.Baseline, {
    // The rowless aggregate DETECTS a negative cost through `_min` without being
    // able to count the rows carrying one — `null` says "not read here", which a
    // `0` would misreport as "read, and clean".
    negativeCostRows: null,
    minimumCostUsd: costCoverage.minimumCostUsd,
    negativeLocRows: null,
    rowCount: costCoverage.rowCount,
  });
  return {
    // A truncated (partial) baseline LOC understates the numerator while
    // tokens/cost aggregate over ALL rows, and an unpriced baseline session
    // shortens the denominator the same way from the other end (ISS-9751). Both
    // are one population mismatch, so they feed ONE verdict and the owner
    // publishes no ratio for either.
    //
    // Unmeasured LOC is deliberately NOT a term here: the baseline numerator
    // dilutes when only some rows carry LOC, and that is accepted.
    // {@link sumScalars} carries why the two terms are asymmetric about
    // measuredness — read it there rather than re-deciding it here.
    //
    // It carries only HALF of what this verdict does, though, so do not read
    // the two as equivalent. `sumScalars` ALSO refuses a zero fold that no row
    // measured; this verdict has no such arm, so a fully priced window whose
    // sessions were every one un-enriched folds to a publishable `0` where the
    // cohort would suppress. Nothing renders that today — `locPerDollar` is
    // read at exactly one site, `pctDelta`, which returns null against a zero
    // baseline — so the two verdicts differ without yet disagreeing on screen.
    // A consumer that reads this figure directly would have to restate the
    // zero-fold guard here first.
    locPerDollar: locPerDollarFromPopulation({
      lines: dedupedLoc.loc,
      cost: baselineCost,
      coverageComplete: !dedupedLoc.truncated && costCoverage.complete,
    }),
    tokensPerLoc: dedupedLoc.truncated
      ? null
      : tokensPerLocOf(baselineTokens, dedupedLoc.loc),
    successRate: successRateOf(prOutcomeOf(baselineRows)),
    sampleSize: baselineRows.length,
    windowSessionCount: baselineAgg._count._all,
  };
}

/**
 * The baseline cost-coverage verdict, derived from counters read in the SAME
 * statement as the `_sum` they certify (see the aggregate's note on why that is
 * load-bearing rather than an optimization). Coverage is complete when every row
 * in the window carried a priced, non-negative cost — which is exactly the set
 * `_sum` summed, so the ratio's two terms describe one population.
 */
function baselineCostCoverage(aggregate: {
  rowCount: number;
  pricedRows: number;
  minimumCostUsd: number | null;
}): { complete: boolean; minimumCostUsd: number | null; rowCount: number } {
  const unpricedRows = Math.max(0, aggregate.rowCount - aggregate.pricedRows);
  const hasNegativeCost =
    aggregate.minimumCostUsd !== null && aggregate.minimumCostUsd < 0;
  return {
    complete: unpricedRows === 0 && !hasNegativeCost,
    minimumCostUsd: aggregate.minimumCostUsd,
    rowCount: aggregate.rowCount,
  };
}

/**
 * Earliest and latest `time` across `points`, folded rather than spread.
 *
 * `Math.min(...times)` passes one ARGUMENT per element, which throws
 * `RangeError: Maximum call stack size exceeded` somewhere past ~125,000 of
 * them (measured on this repo's Node). That was unreachable while the cohort
 * was capped at 2,000 rows; ISS-9853 removed the cap, so the array is now the
 * whole cohort and the spread would take the entire request down — before the
 * bind-ceiling guard, which runs after this, could decline to build a baseline.
 */
function timeBounds(points: readonly { time: number }[]): {
  min: number;
  max: number;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.time < min) {
      min = point.time;
    }
    if (point.time > max) {
      max = point.time;
    }
  }
  return { min, max };
}
