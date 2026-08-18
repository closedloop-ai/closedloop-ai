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
// BOUNDEDNESS (this repo has a documented history of db-host OOMs from
// unbounded scans — see FEA-3132 / the insights bounded-fan-out rule): the
// baseline never materializes an org's full session history. LOC/token deltas
// use exact DB `_sum` aggregates (no rows returned); success-rate and quality
// deltas read a CAPPED, most-recent baseline SAMPLE. The cohort scan itself is
// capped too. Callers already pass a bounded cohort (the usage rollups cap their
// session fan-out), but we defend the boundary here regardless.

import {
  COHORT_SCAN_CAP,
  type CohortDeliveryMetrics,
  EMPTY_COHORT_DELIVERY_METRICS,
} from "@repo/api/src/types/analytics";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { clamp } from "@repo/api/src/utils/math";
import {
  LOC_SOURCE_BRANCH_FALLBACK,
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "@repo/api/src/utils/session-loc";
import type { Prisma, withDb } from "@repo/database";
import {
  isMergedPrDetail,
  mergedPrIdentity,
  SESSION_PR_LINK_WHERE,
} from "@/lib/session-pr-links";

type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];

/** Most-recent baseline sessions sampled for the success/quality deltas. */
const BASELINE_SAMPLE_CAP = 500;
/** Buckets in the token-efficiency sparkline (matches the prototype's 8). */
const EFFICIENCY_TREND_BUCKETS = 8;
/** Judge scores are clamped into this display range for the (hidden) quality card. */
const QUALITY_MAX = 10;

/**
 * Empty result — no cohort sessions, so nothing is computable. Re-exported from
 * the canonical `EMPTY_COHORT_DELIVERY_METRICS` SSOT (in
 * `@repo/api/src/types/analytics`) so the cloud and desktop-local surfaces share
 * one empty-metrics literal instead of each redeclaring it.
 */
export const EMPTY_COHORT_METRICS: CohortDeliveryMetrics =
  EMPTY_COHORT_DELIVERY_METRICS;

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
 * ISS-4667: LOC per dollar — raw lines / cost, no divide-by-1000, higher is
 * better. Delegates to the shared SSOT so this cohort figure can never drift in
 * unit or zero-handling from the per-session and per-component ones it is
 * compared against. Null unless both LOC and cost are positive.
 */
export function locPerDollarOf(
  locTotal: number,
  costTotal: number
): number | null {
  return locPerDollarFromLines(locTotal, costTotal);
}

/** Tokens spent per KLOC of work: tokens / (LOC / 1000). Null unless both positive. */
export function tokensPerKlocOf(
  tokenTotal: number,
  locTotal: number
): number | null {
  if (tokenTotal <= 0 || locTotal <= 0) {
    return null;
  }
  return tokenTotal / (locTotal / 1000);
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
  cohortTokensPerKloc: number | null,
  baselineTokensPerKloc: number | null
): number | null {
  if (
    cohortTokensPerKloc === null ||
    baselineTokensPerKloc === null ||
    baselineTokensPerKloc === 0
  ) {
    return null;
  }
  return Math.round(
    ((baselineTokensPerKloc - cohortTokensPerKloc) / baselineTokensPerKloc) *
      100
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

/** Arithmetic mean, or null when there are no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, n) => sum + n, 0) / values.length;
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
  const times = points.map((p) => p.time);
  const min = Math.min(...times);
  const max = Math.max(...times);
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

const COHORT_SESSION_SELECT = {
  artifactId: true,
  linesAdded: true,
  linesRemoved: true,
  // FEA-3633: provenance + branch identity for the per-branch fallback dedup.
  locSource: true,
  repositoryFullName: true,
  branch: true,
  estimatedCost: true,
  inputTokens: true,
  outputTokens: true,
  sessionStartedAt: true,
  sourceLoopId: true,
  artifact: {
    select: {
      sourceLinks: {
        where: SESSION_PR_LINK_WHERE,
        select: {
          targetId: true,
          target: {
            select: {
              branch: {
                select: {
                  currentPullRequestDetail: {
                    select: {
                      number: true,
                      prState: true,
                      mergedAt: true,
                      isCurrent: true,
                      repositoryFullName: true,
                      repository: { select: { fullName: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.SessionDetailSelect;

/**
 * Cohort session row: LOC/cost/token scalars + timing + loop + PR-link presence.
 * Derived from {@link COHORT_SESSION_SELECT} via `GetPayload` (the convention
 * shared with `apps/api/lib/agent-session-delivery-metrics.ts`) so the row type
 * can never drift from the actual `select`, which lets the `findMany` results be
 * consumed without an `as` cast.
 */
type CohortSessionRow = Prisma.SessionDetailGetPayload<{
  select: typeof COHORT_SESSION_SELECT;
}>;

/** Per-session PR outcome across a cohort of rows. */
type PrOutcome = {
  sessionsWithMergedPr: number;
  total: number;
  distinctMergedPrs: Set<string>;
};

function collectPrOutcome(rows: readonly CohortSessionRow[]): PrOutcome {
  let sessionsWithMergedPr = 0;
  const distinctMergedPrs = new Set<string>();
  for (const row of rows) {
    let sessionHasMerged = false;
    for (const link of row.artifact.sourceLinks) {
      const detail = link.target?.branch?.currentPullRequestDetail ?? null;
      if (!isMergedPrDetail(detail)) {
        continue;
      }
      sessionHasMerged = true;
      distinctMergedPrs.add(mergedPrIdentity(detail, link.targetId));
    }
    if (sessionHasMerged) {
      sessionsWithMergedPr += 1;
    }
  }
  return { sessionsWithMergedPr, total: rows.length, distinctMergedPrs };
}

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
function cohortLocEntry(row: CohortSessionRow): SessionLocEntry {
  return {
    loc: sessionLoc(row.linesAdded, row.linesRemoved),
    locSource: row.locSource,
    repositoryFullName: row.repositoryFullName,
    branch: row.branch,
  };
}

/**
 * Aggregate LOC + token + cost scalars over a set of cohort rows. LOC is deduped
 * PER BRANCH (FEA-3633): a branch whose LOC came from the branch/PR-total fallback
 * counts once across its authoring sessions, not once per session. Tokens + cost
 * still sum per-session (they are genuinely per-session).
 */
function sumScalars(rows: readonly CohortSessionRow[]): {
  loc: number;
  tokens: number;
  cost: number;
} {
  let tokens = 0;
  let cost = 0;
  for (const row of rows) {
    tokens += Number(row.inputTokens) + Number(row.outputTokens);
    cost += Number(row.estimatedCost ?? 0);
  }
  const loc = sumSessionLocDedupedByBranch(rows.map(cohortLocEntry));
  return { loc, tokens, cost };
}

/** Upper bound on distinct fallback branches summed for the baseline LOC. */
const BASELINE_FALLBACK_BRANCH_CAP = 5000;

/**
 * FEA-3633: baseline LOC with the branch/PR-total fallback deduped per branch,
 * kept bounded (no full row materialization — mirrors the FEA-3132 OOM guard).
 *
 * - Non-fallback LOC (`loc_source` != "branch_fallback", incl. null) sums
 *   per-session via a rowless `_sum` aggregate.
 * - Fallback LOC (`loc_source` == "branch_fallback") is grouped by
 *   `(repositoryFullName, branch)`; each branch contributes MAX(added)+MAX(removed)
 *   ONCE. Every fallback session on a branch carries the SAME whole-branch total,
 *   so the max is that total. Rows with a null repo or branch cannot be keyed, so
 *   they are summed per-session (over-count at worst, never a silent drop) via a
 *   separate `_sum`.
 *
 * `truncated` is set when the keyable-fallback groupBy hit
 * `BASELINE_FALLBACK_BRANCH_CAP`, i.e. the org had more distinct fallback branches
 * in the window than the OOM-guard cap: the returned `loc` is then an UNDERSTATED
 * partial sum. The caller MUST NOT derive a LOC-based delta from a truncated
 * baseline (tokens/cost aggregate over ALL rows, so a partial LOC baseline would
 * make `locDelta`/`tokenEfficiencyDelta` compare against a biased baseline) —
 * it reports those deltas as unavailable (null) instead.
 */
async function computeDedupedBaselineLoc(
  db: DbClient,
  baselineWhere: Prisma.SessionDetailWhereInput
): Promise<{ loc: number; truncated: boolean }> {
  const nonFallbackAgg = await db.sessionDetail.aggregate({
    where: {
      ...baselineWhere,
      OR: [
        { locSource: null },
        { locSource: { not: LOC_SOURCE_BRANCH_FALLBACK } },
      ],
    },
    _sum: { linesAdded: true, linesRemoved: true },
  });
  const nonFallbackLoc =
    (nonFallbackAgg._sum.linesAdded ?? 0) +
    (nonFallbackAgg._sum.linesRemoved ?? 0);

  // Fallback rows whose (repo, branch) can't be keyed: sum per-session (can't
  // prove same branch → never collapse; over-count at worst, never drop).
  const unkeyableFallbackAgg = await db.sessionDetail.aggregate({
    where: {
      ...baselineWhere,
      locSource: LOC_SOURCE_BRANCH_FALLBACK,
      OR: [{ repositoryFullName: null }, { branch: null }],
    },
    _sum: { linesAdded: true, linesRemoved: true },
  });
  const unkeyableFallbackLoc =
    (unkeyableFallbackAgg._sum.linesAdded ?? 0) +
    (unkeyableFallbackAgg._sum.linesRemoved ?? 0);

  // Keyable fallback rows: one group per distinct (repo, branch); MAX per branch.
  const fallbackGroups = await db.sessionDetail.groupBy({
    by: ["repositoryFullName", "branch"],
    where: {
      ...baselineWhere,
      locSource: LOC_SOURCE_BRANCH_FALLBACK,
      repositoryFullName: { not: null },
      branch: { not: null },
    },
    _max: { linesAdded: true, linesRemoved: true },
    // Prisma requires an orderBy on grouped fields; the order is irrelevant (we
    // sum every group) but the `take` cap needs a deterministic scan.
    orderBy: { repositoryFullName: "asc" },
    take: BASELINE_FALLBACK_BRANCH_CAP,
  });
  let keyedFallbackLoc = 0;
  for (const group of fallbackGroups) {
    keyedFallbackLoc +=
      (group._max.linesAdded ?? 0) + (group._max.linesRemoved ?? 0);
  }
  // The groupBy is capped for OOM safety; hitting the cap means there are more
  // distinct fallback branches than we summed, so this LOC is a partial (under-)
  // count. Signal it so the caller drops the LOC-based deltas rather than compare
  // against a biased baseline.
  const truncated = fallbackGroups.length >= BASELINE_FALLBACK_BRANCH_CAP;

  return {
    loc: nonFallbackLoc + unkeyableFallbackLoc + keyedFallbackLoc,
    truncated,
  };
}

/** Mean judge score (clamped 0–10) over the loops behind a set of sessions. */
async function loadCohortQuality(
  db: DbClient,
  organizationId: string,
  loopIds: readonly string[]
): Promise<number | null> {
  if (loopIds.length === 0) {
    return null;
  }
  const evaluations = await db.artifactEvaluation.findMany({
    where: { organizationId, loopId: { in: [...loopIds] } },
    select: { judgeScores: { select: { score: true } } },
    // Bounded: a busy org can accumulate many evaluations per loop, and this
    // runs on the db-host worker (OOM-sensitive — see FEA-3132). A capped
    // sample of evaluations is enough for a mean-score estimate.
    take: COHORT_SCAN_CAP,
  });
  const scores: number[] = [];
  for (const evaluation of evaluations) {
    for (const judge of evaluation.judgeScores) {
      scores.push(judge.score);
    }
  }
  const avg = mean(scores);
  return avg === null ? null : clamp(avg, 0, QUALITY_MAX);
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
  cohortSessionIds: readonly string[]
): Promise<CohortDeliveryMetrics> {
  if (cohortSessionIds.length === 0) {
    return EMPTY_COHORT_METRICS;
  }
  const scanIds = cohortSessionIds.slice(0, COHORT_SCAN_CAP);
  // ISS-5521: the cap is fine; a capped figure PRESENTED as the whole population
  // is not. `cohortSessionIds` arrives in `Set` insertion order, so the retained
  // slice is neither the most recent nor otherwise ordered — the resulting
  // `mergedPrs` is a floor over an arbitrary sample, and the card must be told so
  // it can say "at least" instead of claiming it counted every session.
  const mergedPrsTruncated = cohortSessionIds.length > COHORT_SCAN_CAP;

  // 1. Cohort rows (scalars + PR links + loop) in one bounded query. `take`
  //    mirrors the id-list cap for defense-in-depth (every findMany in this
  //    area caps at the DB level, not just via the IN list).
  const cohortRows = await db.sessionDetail.findMany({
    where: { artifactId: { in: scanIds }, artifact: { organizationId } },
    select: COHORT_SESSION_SELECT,
    take: COHORT_SCAN_CAP,
  });

  if (cohortRows.length === 0) {
    return EMPTY_COHORT_METRICS;
  }

  const cohortScalars = sumScalars(cohortRows);
  const cohortPr = collectPrOutcome(cohortRows);
  const cohortLoopIds = cohortRows
    .map((row) => row.sourceLoopId)
    .filter((id): id is string => id !== null);

  const cohortLocPerDollar = locPerDollarOf(
    cohortScalars.loc,
    cohortScalars.cost
  );
  const cohortTokensPerKloc = tokensPerKlocOf(
    cohortScalars.tokens,
    cohortScalars.loc
  );
  const cohortSuccessRate = successRateOf(cohortPr);

  const efficiencyTrend = efficiencyTrendOf(
    cohortRows.map((row) => ({
      time: row.sessionStartedAt.getTime(),
      tokens: Number(row.inputTokens) + Number(row.outputTokens),
      ...cohortLocEntry(row),
    }))
  );

  const cohortQuality = await loadCohortQuality(
    db,
    organizationId,
    cohortLoopIds
  );

  // 2. Baseline: org sessions in the cohort's window, excluding the ENTIRE
  //    cohort. Only computed when the whole cohort fit in one bounded scan
  //    (`scanIds === cohortSessionIds`). A larger cohort would force the
  //    baseline `notIn` to exclude only the scanned subset — leaking the
  //    unscanned cohort sessions into the baseline and biasing every delta — or
  //    to `notIn` an unbounded id list. In that rare case we report the absolute
  //    cohort metrics WITHOUT deltas rather than a biased/unbounded baseline.
  //    (A single-session cohort collapses the window to one instant, so its
  //    baseline is usually empty and its deltas null — acceptable: one session
  //    is not a meaningful comparison.)
  let locDelta: number | null = null;
  let successDelta: number | null = null;
  let tokenEfficiencyDelta: number | null = null;
  let qualityDelta: number | null = null;

  if (cohortSessionIds.length <= COHORT_SCAN_CAP) {
    const startTimes = cohortRows.map((row) => row.sessionStartedAt.getTime());
    const baselineWhere: Prisma.SessionDetailWhereInput = {
      artifact: { organizationId },
      artifactId: { notIn: scanIds },
      sessionStartedAt: {
        gte: new Date(Math.min(...startTimes)),
        lte: new Date(Math.max(...startTimes)),
      },
    };

    // 2a. Exact LOC/token baseline via a bounded `_sum` aggregate (no rows).
    const baselineAgg = await db.sessionDetail.aggregate({
      where: baselineWhere,
      _sum: {
        estimatedCost: true,
        inputTokens: true,
        outputTokens: true,
      },
    });
    // FEA-3633: baseline LOC is deduped PER BRANCH — a branch/PR-total fallback
    // counts once per branch, not once per authoring session. Split the LOC sum:
    //   - non-fallback (commit-sourced + null) LOC sums per-session via `_sum`;
    //   - fallback LOC is grouped by (repositoryFullName, branch) and each branch
    //     contributes MAX(added)+MAX(removed) once (every fallback session on a
    //     branch carries the SAME whole-branch total, so max == that total).
    // Both stay bounded (an aggregate returns no rows; the groupBy is one row per
    // distinct fallback branch, capped defensively) — the FEA-3132 OOM guard holds.
    const { loc: baselineLoc, truncated: baselineLocTruncated } =
      await computeDedupedBaselineLoc(db, baselineWhere);
    const baselineTokens =
      Number(baselineAgg._sum.inputTokens ?? 0n) +
      Number(baselineAgg._sum.outputTokens ?? 0n);
    const baselineCost = Number(baselineAgg._sum.estimatedCost ?? 0);
    // A truncated (partial) baseline LOC understates the denominator/numerator of
    // both LOC-based ratios while tokens/cost aggregate over ALL rows — so a delta
    // off it would be biased. Report it as unavailable (null) rather than wrong.
    const baselineLocPerDollar = baselineLocTruncated
      ? null
      : locPerDollarOf(baselineLoc, baselineCost);
    const baselineTokensPerKloc = baselineLocTruncated
      ? null
      : tokensPerKlocOf(baselineTokens, baselineLoc);

    // 2b. Success + quality baseline over a capped, most-recent SAMPLE.
    const baselineRows = await db.sessionDetail.findMany({
      where: baselineWhere,
      select: COHORT_SESSION_SELECT,
      orderBy: { sessionStartedAt: "desc" },
      take: BASELINE_SAMPLE_CAP,
    });
    const baselineSuccessRate = successRateOf(collectPrOutcome(baselineRows));
    const baselineLoopIds = baselineRows
      .map((row) => row.sourceLoopId)
      .filter((id): id is string => id !== null);
    const baselineQuality = await loadCohortQuality(
      db,
      organizationId,
      baselineLoopIds
    );

    locDelta = pctDelta(cohortLocPerDollar, baselineLocPerDollar);
    successDelta = ppDelta(cohortSuccessRate, baselineSuccessRate);
    tokenEfficiencyDelta = tokenEfficiencyDeltaOf(
      cohortTokensPerKloc,
      baselineTokensPerKloc
    );
    qualityDelta = pctDelta(cohortQuality, baselineQuality);
  }

  return {
    locDelta,
    successRate: cohortSuccessRate,
    successDelta,
    tokenEfficiencyDelta,
    efficiencyTrend,
    mergedPrs: cohortPr.distinctMergedPrs.size,
    mergedPrsTruncated,
    qualityScore: cohortQuality,
    qualityDelta,
  };
}
