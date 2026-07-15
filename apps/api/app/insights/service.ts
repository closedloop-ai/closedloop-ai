import {
  kpi,
  lifespanHistogram,
  pctDelta,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { ssotMergeRateFromCounts } from "@repo/api/src/insights/delivery-kpis/parity";
import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import { GITHUB_PR_STATE_LABELS } from "@repo/api/src/types/github";
import {
  type AgentsInsightsResponse,
  type CategoryBucket,
  type DeliveryInsightsResponse,
  type DonutSlice,
  type InsightsGitHubProvenance,
  InsightsGitHubProvenanceState,
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
  InsightsScope,
  type InsightsTileAvailabilityMap,
  InsightsTileAvailabilityState,
  KpiFormat,
  type KpiStat,
  type ReviewerRow,
  type TimeSeries,
  type TimeSeriesSeries,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { median } from "@repo/api/src/utils/math";
import { labelize } from "@repo/api/src/utils/string";
import {
  ChecksStatus,
  GitHubPRState,
  Prisma,
  ReviewDecision,
  withDb,
} from "@repo/database";
import { resolveGitHubDataConnectionStatus } from "@/app/integrations/github/data-connection-status";
import { canonicalizeTimeZone, toLocalDateOnly } from "@/lib/date-only";
import { toNumber } from "@/lib/prisma-number";

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const TREND_LOOKBACK_DAYS = 90;
const MAX_MODEL_SERIES = 6;

// FEA-2878: the delivery view's merged-PR summary aggregates (median time-to-
// merge, KLOC totals, and the repo/TTM/lifespan histograms) are computed
// app-side over the materialized merged-PR rows. For the "all" period
// (range.start = epoch) an unbounded fetch would pull every merged PR org-wide
// — and then fan out into an `IN (branchArtifactId…)` line-totals group-by over
// the same set. The scan is therefore capped to the most recent
// MERGED_PR_SCAN_CAP rows (newest-first). The headline "Merged PRs" count and
// its delta come from an exact DB count() (see countMergedPrsInRange), and the
// state distribution (prByState) is sized from that same count, so both stay
// precise for any org size. Every other delivery aggregate that reads these
// rows — the median-TTM / KLOC / median-PR-size KPIs and the repo, TTM, and
// lifespan histograms — is computed over the retained window, so it degrades
// gracefully (biased toward the most recent activity) only once a single period
// exceeds the cap. A `take`/cursor drop-in without the separate count() would
// instead corrupt the count itself, which is why the two are split. The cap is
// generous enough that realistic orgs are unaffected; a supporting
// (organizationId, prState, mergedAt) index is tracked separately (Dexter).
export const MERGED_PR_SCAN_CAP = 25_000;

// Aggregation context resolved from the authenticated user + requested scope.
export type InsightsScopeContext = {
  organizationId: string;
  userId: string;
  scope: InsightsScope;
  teamId?: string;
  // FEA-2745: IANA timezone the requester's daily buckets should be labelled
  // in, so the shared Insights charts bucket the same activity on the same
  // calendar day as the desktop shell (which buckets in the user's local
  // timezone via localDay(), FEA-2430). Undefined → UTC bucketing.
  timeZone?: string;
};

type PeriodRange = {
  start: Date;
  end: Date;
  // Prior window of equal length; null for the "all time" period.
  priorStart: Date | null;
  // Bounded window used for time-series so "all time" does not explode into
  // tens of thousands of daily buckets.
  trendStart: Date;
};

type ArtifactScopeWhere = Prisma.ArtifactWhereInput;

type MergedPrRow = {
  mergedAt: Date | null;
  // FEA-2732: nullable for desktop-produced PRs in non-App repos; the producer-
  // independent repo identity is carried on `repositoryFullName` instead.
  repositoryId: string | null;
  repositoryFullName: string | null;
  branchArtifactId: string;
  repository: { name: string } | null;
  branchArtifact: { createdAt: Date };
};

type ReviewRow = {
  authorLogin: string;
  state: ReviewDecision;
  submittedAt: Date;
  pullRequestDetail: { branchArtifact: { createdAt: Date } };
};

// DB-summed token columns for the KPI row + token-distribution donut, over the
// selected period. Replaces materializing every token row to reduce in JS.
type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// One DB-aggregated (day, model) spend bucket for the model-usage series
// (FEA-2331: estimated spend in USD, date-bucketed in the requester's timezone).
type ModelUsageDayRow = {
  day: string;
  model: string;
  cost: number;
};

async function getDelivery(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<DeliveryInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const [
    merged,
    mergedCount,
    priorMergedCount,
    closedCount,
    cost,
    priorCost,
    earliest,
    githubProvenance,
  ] = await Promise.all([
    fetchMergedPrs(ctx, range.start, range.end),
    countMergedPrsInRange(ctx, range.start, range.end),
    countMergedPrs(ctx, range.priorStart, range.start),
    // FEA-3151: closed-without-merge count → SSOT DECIDED merge-rate denominator.
    // FEA-3208: counted by prState (desktop pr_state basis), null-safely windowed
    // on the branch artifact's createdAt — NOT gated on the nullable closedAt.
    countClosedPrs(ctx, range.start, range.end),
    sumSessionCost(ctx, range.start, range.end),
    sumSessionCost(ctx, range.priorStart, range.start),
    earliestRecord(ctx),
    resolveGitHubProvenance(ctx),
  ]);
  const reportDelta = reportDeltaFor(range, earliest);

  const ttms = merged
    .filter((pr) => pr.mergedAt)
    .map(
      (pr) =>
        (pr.mergedAt as Date).getTime() - pr.branchArtifact.createdAt.getTime()
    )
    .filter((ms) => ms >= 0);
  const [
    { lineTotalsByBranch, enrichedBranchIds },
    branchesWithoutPr,
    checkStatus,
  ] = await Promise.all([
    fetchMergedLineTotals(
      ctx.organizationId,
      merged.map((pr) => pr.branchArtifactId)
    ),
    fetchBranchesWithoutPrBuckets(ctx),
    isOrgScope(ctx)
      ? fetchCheckStatusBuckets(ctx.organizationId)
      : Promise.resolve(undefined),
  ]);
  const lines = merged.map(
    (pr) => lineTotalsByBranch.get(pr.branchArtifactId) ?? 0
  );
  // KLOC (totalLines) sums over ALL merged PRs — an un-enriched PR folds in as 0,
  // which is harmless for a sum and matches the desktop dashboard (FEA-2159).
  const totalLines = lines.reduce((sum, n) => sum + n, 0);
  // FEA-2988: the PR-size MEDIAN is taken over ENRICHED PRs only — PRs whose
  // branch file cache is Fresh (GitHub compare succeeded). Folding un-enriched
  // PRs (unknown size) in as 0 was dragging the median toward 0. Enrichment is
  // keyed on the file cache STATUS, not on the presence of branchFileChange
  // rows: a Fresh branch with zero changed files has a KNOWN size of 0 but no
  // groupBy rows, so it must still count toward the median as 0 (defaulting via
  // `?? 0`) rather than being dropped as if unknown.
  // Mirrors the desktop fix (FEA-2868 `computeDelivery`, medians over
  // `enrichedLocValues` only) and the delivery-KPI SSOT default
  // (delivery-kpis/registry.ts PrSize `onlyEnriched: true`).
  const enrichedLines = merged
    .filter((pr) => enrichedBranchIds.has(pr.branchArtifactId))
    .map((pr) => lineTotalsByBranch.get(pr.branchArtifactId) ?? 0);

  const kpis: KpiStat[] = [
    kpi(
      "merged",
      "Merged PRs",
      mergedCount,
      KpiFormat.Number,
      "PRs merged in range",
      reportDelta(mergedCount, priorMergedCount)
    ),
    // FEA-2946: surface-agnostic MERGED-PR count the shared AI-Impact card reads
    // as its "Cost per merged PR" denominator. Here it equals the visible `merged`
    // tile above, but desktop's `merged` KPI carries CAPTURED PRs (its "Captured
    // PRs" tile), so the card cannot rely on `merged` meaning "merged" on both
    // surfaces — both now expose this dedicated key with identical (merged)
    // semantics. Flagged `internal` (mirrors the delivery-kpis registry's
    // MergedCount entry): response-only, backs no tile, so it renders nothing on
    // its own.
    kpi(
      "mergedCount",
      "Merged PRs",
      mergedCount,
      KpiFormat.Number,
      "PRs merged in range",
      reportDelta(mergedCount, priorMergedCount),
      true
    ),
    kpi(
      "ttm",
      "Median time to merge",
      median(ttms) ?? 0,
      KpiFormat.Duration,
      // FEA-2945: the interval computed above is mergedAt − branchArtifact.createdAt
      // (branch-artifact creation → merge), NOT first-commit → merge. No first-commit
      // timestamp is captured on this surface, so label it for what it actually measures.
      "branch created → merged",
      null
    ),
    kpi(
      "kloc",
      "KLOC merged",
      round(totalLines / 1000, 1),
      KpiFormat.Number,
      "thousand lines landed",
      null
    ),
    kpi(
      "cost",
      "Cost",
      round(cost, 2),
      KpiFormat.Currency,
      "spend in range",
      reportDelta(cost, priorCost)
    ),
    kpi(
      "merge-rate",
      "Merge rate",
      // FEA-3151: routed through the shared delivery-KPI SSOT. `ssotMergeRateFromCounts`
      // reconstitutes a minimal fixture from the exact merged/closed DB counts and
      // runs the ONE engine (computeDeliveryKpiResult), so this reads the registry-
      // defined MergeRate — the DECIDED denominator merged / (merged + closed) —
      // identical to Desktop and Web (which render cloud). Was the captured-cohort
      // approximation merged / opened (FEA-3118 pinned the delta); now reconciled.
      // Null (renders "—") when there is no decided cohort, per the SSOT contract.
      ssotMergeRateFromCounts(mergedCount, closedCount),
      KpiFormat.Percent,
      "of decided PRs (merged + closed)",
      null
    ),
    kpi(
      "pr-size",
      "Median PR size",
      // FEA-2923: no enriched merged PR in the window ⇒ no size to median ⇒
      // emit `null` so the KPI renders `—` (formatKpiValue), not a misleading 0.
      // `null` is JSON-serializable (unlike a non-finite number) and matches the
      // `KpiStat.value: number | null` contract. Mirrors desktop `computeDelivery`.
      enrichedLines.length > 0 ? (median(enrichedLines) ?? 0) : null,
      KpiFormat.Number,
      "lines changed",
      null
    ),
  ];

  return {
    kpis,
    tileAvailability: buildDeliveryTileAvailability({
      checkStatusAvailable: Boolean(checkStatus),
      // FEA-3151: merge rate is now the DECIDED-cohort rate merged / (merged +
      // closed), so its tile availability must track the DECIDED cohort — not the
      // opened cohort. Otherwise a window with old PRs merged/closed but nothing
      // newly opened would wrongly mark a valid rate unavailable, and a window
      // with only newly-opened (undecided) PRs would mark the tile available even
      // though the value is null.
      hasDecidedPrCohort: mergedCount + closedCount > 0,
      hasTtmEvidence: ttms.length > 0,
    }),
    ...(githubProvenance ? { githubProvenance } : {}),
    charts: {
      prTrend: bucketCountByDay(
        merged.filter((pr) => pr.mergedAt).map((pr) => pr.mergedAt as Date),
        range.trendStart,
        range.end,
        { key: "merged", label: "Merged PRs" },
        ctx.timeZone
      ),
      klocTrend: bucketKlocByDay(
        merged,
        lineTotalsByBranch,
        range.trendStart,
        range.end,
        ctx.timeZone
      ),
      // FEA-2732 + review: one bucket per physical repo across the App and
      // desktop lanes. App rows carry the canonical-case short `repository.name`;
      // repo-less (non-App) merged PRs only carry `repositoryFullName`
      // (owner/name), which normalizeRepoFullName lowercases. Grouping by a
      // case-insensitive key (see buildPrByRepoBuckets) keeps the two lanes for
      // one repo from fragmenting into "Foo-Bar" + "foo-bar", while preserving
      // the App's canonical casing as the display label.
      prByRepo: bucketByLabelCounts(buildPrByRepoBuckets(merged)),
      meanTimeToMerge: ttmHistogram(ttms),
      prByState: mergedStateBuckets(mergedCount),
      branchLifespan: lifespanHistogram(ttms),
      branchesWithoutPr,
      ...(checkStatus ? { checkStatus } : {}),
    },
  };
}

async function getUtilization(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<UtilizationInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const [
    sessionRollup,
    priorSessionCount,
    eventCount,
    eventVolume,
    eventsByType,
    reviewQueue,
    backlog,
    reviews,
    userBreakdown,
    eventActivity,
    earliest,
    githubProvenance,
  ] = await Promise.all([
    // SessionDetail rows feed only pure aggregates here (count, summed runtime,
    // status breakdown), so they are rolled up in the DB in a single scan rather
    // than materialized and reduced in JS — for the "all" period the range is
    // epoch-start, so the row set is unbounded.
    fetchSessionRollup(ctx, range.start, range.end),
    countSessions(ctx, range.priorStart, range.start),
    // agentSessionEvent is the highest-volume table, so the event count, daily
    // volume and by-type breakdown are aggregated in the DB rather than by
    // materializing every row and reducing in JS (matches the desktop path).
    countEvents(ctx, range.start, range.end),
    fetchEventVolume(ctx, range.trendStart, range.end, ctx.timeZone),
    fetchEventTypeBuckets(ctx, range.start, range.end),
    fetchReviewQueueBuckets(ctx),
    countReviewBacklog(ctx),
    isOrgScope(ctx) ? fetchReviews(ctx, range.start, range.end) : [],
    isOrgScope(ctx) ? fetchUserBreakdown(ctx, range.start, range.end) : [],
    // Daily session-start volume, date-bucketed in Postgres (mirrors
    // fetchEventVolume) so only one already-bucketed row per day crosses the
    // wire instead of every SessionDetail.
    fetchSessionActivity(ctx, range.trendStart, range.end),
    earliestRecord(ctx),
    resolveGitHubProvenance(ctx),
  ]);
  const reportDelta = reportDeltaFor(range, earliest);

  const currentSessionCount = sessionRollup.sessionCount;
  const runtimeMs = sessionRollup.runtimeMs;

  const kpis: KpiStat[] = [
    kpi(
      "sessions",
      "Sessions",
      currentSessionCount,
      KpiFormat.Number,
      "agent sessions run",
      reportDelta(currentSessionCount, priorSessionCount)
    ),
    kpi(
      "runtime",
      "Agent runtime",
      runtimeMs,
      KpiFormat.Duration,
      "hours of agent execution",
      null
    ),
    kpi(
      "backlog",
      "Review backlog",
      backlog,
      KpiFormat.Number,
      "open PRs awaiting review",
      null
    ),
    kpi(
      "events",
      "Events",
      eventCount,
      KpiFormat.Number,
      "captured events",
      null
    ),
  ];

  return {
    kpis,
    tileAvailability: buildUtilizationTileAvailability({
      isOrg: isOrgScope(ctx),
    }),
    ...(githubProvenance ? { githubProvenance } : {}),
    charts: {
      eventActivity,
      eventVolume,
      eventsByType,
      sessionsByStatus: sessionRollup.statusBuckets,
      ...(isOrgScope(ctx) ? { userBreakdown } : {}),
      ...(isOrgScope(ctx) ? { reviewerLoad: reviewerRows(reviews) } : {}),
      reviewQueue,
    },
  };
}

async function getAgents(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<AgentsInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const [
    tokenTotals,
    modelBreakdown,
    modelUsage,
    agentBuckets,
    toolUsage,
    toolRuns,
    priorToolRuns,
    toolRunsOverTime,
    earliest,
  ] = await Promise.all([
    // Token analytics are summed/grouped in the DB (FEA-2876) rather than
    // materializing every agentSessionTokenUsage row and reducing in JS.
    fetchTokenTotals(ctx, range.start, range.end),
    fetchModelBreakdown(ctx, range.start, range.end),
    fetchModelUsageRows(ctx, range.trendStart, range.end, ctx.timeZone),
    // Agent status/type buckets are unnested and grouped in the DB (FEA-2955)
    // rather than materializing every session row and reducing the JSON in JS.
    fetchAgentBuckets(ctx, range.start, range.end),
    // Tool buckets are counted in the DB (grouped by toolName) rather than
    // materializing every agentSessionEvent row and reducing in JS.
    fetchToolUsageBuckets(ctx, range.start, range.end),
    sumToolRuns(ctx, range.start, range.end),
    sumToolRuns(ctx, range.priorStart, range.start),
    // Daily tool-run totals are SUM'd per day in the DB (FEA-2956) rather than
    // materializing every session row and reducing in JS.
    fetchToolRunsByDay(ctx, range.trendStart, range.end),
    earliestRecord(ctx),
  ]);
  const reportDelta = reportDeltaFor(range, earliest);

  const totalTokens = tokenTotals.inputTokens + tokenTotals.outputTokens;
  const totalInputTokens = tokenTotals.inputTokens;
  const totalOutputTokens = tokenTotals.outputTokens;
  const totalCacheTokens =
    tokenTotals.cacheReadTokens + tokenTotals.cacheWriteTokens;
  const modelCount = modelBreakdown.length;

  const kpis: KpiStat[] = [
    kpi(
      "tokens",
      "Tokens",
      totalTokens,
      KpiFormat.Tokens,
      "consumed in range",
      null
    ),
    kpi(
      "input-tokens",
      "Input tokens",
      totalInputTokens,
      KpiFormat.Tokens,
      "prompt tokens",
      null
    ),
    kpi(
      "output-tokens",
      "Output tokens",
      totalOutputTokens,
      KpiFormat.Tokens,
      "completion tokens",
      null
    ),
    kpi(
      "cache-tokens",
      "Cache saved",
      totalCacheTokens,
      KpiFormat.Tokens,
      "cache read/write tokens",
      null
    ),
    kpi(
      "models",
      "Models in use",
      modelCount,
      KpiFormat.Number,
      "distinct models",
      null
    ),
    kpi(
      "tool-runs",
      "Tool runs",
      toolRuns,
      KpiFormat.Number,
      "tool invocations",
      reportDelta(toolRuns, priorToolRuns)
    ),
  ];

  return {
    kpis,
    charts: {
      modelUsageOverTime: modelUsageSeries(
        modelUsage.rows,
        modelBreakdown,
        range.trendStart,
        range.end,
        // Enumerate the chart in the same zone the rows were bucketed in. This
        // is `ctx.timeZone` normally but flips to UTC on the tzdata-skew
        // fallback so point keys still line up with the UTC-bucketed row keys.
        modelUsage.bucketZone
      ),
      modelBreakdown,
      tokenDistribution: tokenDistributionBuckets(tokenTotals),
      toolUsage,
      agentsByStatus: agentBuckets.byStatus,
      agentsByType: agentBuckets.byType,
      toolRunsOverTime,
    },
  };
}

export const insightsService = {
  getDelivery,
  getUtilization,
  getAgents,
} as const;

// ───────────────────────── scope helpers ─────────────────────────

function isOrgScope(ctx: InsightsScopeContext): boolean {
  return ctx.scope === InsightsScope.Org;
}

/** Artifact-relation scope predicate (org-wide, or authored by the user). */
function artifactScope(ctx: InsightsScopeContext): ArtifactScopeWhere {
  if (ctx.scope === InsightsScope.Me) {
    return { organizationId: ctx.organizationId, createdById: ctx.userId };
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return { organizationId: ctx.organizationId, id: { in: [] } };
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return {
      organizationId: ctx.organizationId,
      createdBy: {
        teamMemberships: {
          some: {
            teamId: ctx.teamId,
          },
        },
      },
    };
  }
  return { organizationId: ctx.organizationId };
}

/** Session scope predicate (org-wide, or launched by the user). The org lives
 * on the parent artifact (FEA-1699); the launching user stays on the detail. */
function sessionScope(
  ctx: InsightsScopeContext
): Prisma.SessionDetailWhereInput {
  const artifact: Prisma.ArtifactWhereInput = {
    organizationId: ctx.organizationId,
  };
  if (ctx.scope === InsightsScope.Me) {
    return { artifact: { is: artifact }, userId: ctx.userId };
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return { artifact: { is: artifact }, artifactId: { in: [] } };
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return {
      artifact: { is: artifact },
      user: {
        is: {
          teamMemberships: {
            some: {
              teamId: ctx.teamId,
            },
          },
        },
      },
    };
  }
  return { artifact: { is: artifact } };
}

/**
 * Raw-SQL mirror of {@link sessionScope} for the event-volume aggregation, which
 * date-buckets in Postgres and so cannot use a Prisma relation filter. Emits a
 * WHERE condition over the `s` (session_detail) and `a` (artifacts) aliases the
 * caller joins. Keep the two scope predicates in lockstep.
 */
function sessionScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
  const org = Prisma.sql`a.organization_id = ${ctx.organizationId}::uuid`;
  if (ctx.scope === InsightsScope.Me) {
    return Prisma.sql`${org} AND s.user_id = ${ctx.userId}::uuid`;
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return Prisma.sql`false`;
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return Prisma.sql`${org} AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = s.user_id AND tm.team_id = ${ctx.teamId}::uuid
    )`;
  }
  return org;
}

// ───────────────────────── queries ─────────────────────────

/** Closed-interval [start, end] predicate for merged PRs. Shared by the row
 * scan and its exact count so the two never disagree at the window boundary. */
function mergedPrWhere(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Prisma.PullRequestDetailWhereInput {
  return {
    branchArtifact: artifactScope(ctx),
    prState: GitHubPRState.MERGED,
    mergedAt: { gte: start, lte: end },
  };
}

function fetchMergedPrs(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<MergedPrRow[]> {
  return withDb((db) =>
    db.pullRequestDetail.findMany({
      where: mergedPrWhere(ctx, start, end),
      select: {
        mergedAt: true,
        repositoryId: true,
        // FEA-2732: fallback repo identity for repo-less (non-App) merged PRs.
        repositoryFullName: true,
        branchArtifactId: true,
        repository: { select: { name: true } },
        branchArtifact: { select: { createdAt: true } },
      },
      // FEA-2878: bound the scan so the "all" period cannot materialize every
      // merged PR org-wide. Newest-first so the retained window is the most
      // recent — it covers the 90-day trend charts in full unless a single
      // period's merged count exceeds the cap, and biases the capped
      // distribution toward current activity. The headline "Merged PRs" count
      // comes from countMergedPrsInRange, not this (possibly capped) row set.
      orderBy: { mergedAt: "desc" },
      take: MERGED_PR_SCAN_CAP,
    })
  );
}

/** FEA-2878: exact count of merged PRs in [start, end], matching
 * {@link mergedPrWhere} (and thus {@link fetchMergedPrs}) so the "Merged PRs"
 * KPI, its delta, and prByState stay precise even when the row scan is capped. */
function countMergedPrsInRange(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  return withDb((db) =>
    db.pullRequestDetail.count({ where: mergedPrWhere(ctx, start, end) })
  );
}

function countMergedPrs(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return Promise.resolve(0);
  }
  return withDb((db) =>
    db.pullRequestDetail.count({
      where: {
        branchArtifact: artifactScope(ctx),
        prState: GitHubPRState.MERGED,
        mergedAt: { gte: start, lt: end },
      },
    })
  );
}

// FEA-3151: closed-WITHOUT-merge PRs → the DECIDED denominator's closed side.
// Paired with countMergedPrsInRange, this forms the DECIDED denominator
// merged + closed the shared MergeRate KPI divides by — so the cloud merge rate
// equals the Desktop/Web value for the same corpus. (`prState CLOSED` is
// closed-without-merge: a merged PR normalizes to prState MERGED, matching the
// NormalizedPr `state`-authoritative disjointness the SSOT decidedPrs relies on.)
//
// FEA-3208: count CLOSED by `prState` (the desktop pr_state basis) BUT keep the
// period window — window null-safely on the branch artifact's `createdAt`, NOT on
// the nullable `closedAt`. `closedAt` is nullable (schema.prisma
// PullRequestDetail:~1325) and PullRequestDetail carries no created/updated
// timestamp of its own, so the previous `closedAt BETWEEN start AND end` window
// silently DROPPED any genuinely-CLOSED PR whose closedAt was never populated
// (e.g. `gh`/webhook enrichment that set pr_state CLOSED but not the timestamp).
// That shrank the denominator and inflated the cloud merge rate above the true
// value AND above Desktop/Web (e.g. 8/(8+2)=80% vs desktop 8/(8+4)=67%).
//
// The fix must NOT over-correct by dropping the window entirely — that would mix
// an all-time closed denominator with the windowed `mergedAt` numerator
// (countMergedPrsInRange) and skew the rate the other way. Instead we window on
// `branchArtifact.createdAt`, the null-safe cloud analogue of the desktop SSOT's
// `COALESCE(observed_at, created_at) BETWEEN $1 AND $2` window over the whole
// captured PR population (local-insights.ts merge-rate query): Artifact.createdAt
// is `@default(now())`, never null, so a genuinely-decided PR with a null
// closedAt is RETAINED while an all-time-old closed PR observed outside the
// period is EXCLUDED. `artifactScope(ctx)` keeps the count tenant-correct; the
// merged side stays windowed on `mergedAt` (countMergedPrsInRange) and is
// unchanged.
function countClosedPrs(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  return withDb((db) =>
    db.pullRequestDetail.count({
      where: {
        branchArtifact: {
          ...artifactScope(ctx),
          createdAt: { gte: start, lte: end },
        },
        prState: GitHubPRState.CLOSED,
      },
    })
  );
}

/**
 * Line totals per merged branch, plus the set of branches whose file cache is
 * Fresh (i.e. GitHub compare succeeded — "enriched").
 *
 * FEA-2988: enrichment is determined by `BranchDetail.fileCacheStatus === Fresh`,
 * NOT by the presence of `branchFileChange` rows. A Fresh branch with zero
 * changed files has a KNOWN size of 0 but produces no groupBy rows; it must
 * still be recognized as enriched so the PR-size median counts it as 0 instead
 * of dropping it as if its size were unknown.
 */
async function fetchMergedLineTotals(
  organizationId: string,
  branchArtifactIds: string[]
): Promise<{
  lineTotalsByBranch: Map<string, number>;
  enrichedBranchIds: Set<string>;
}> {
  if (branchArtifactIds.length === 0) {
    return { lineTotalsByBranch: new Map(), enrichedBranchIds: new Set() };
  }
  const [grouped, enriched] = await withDb((db) =>
    Promise.all([
      db.branchFileChange.groupBy({
        by: ["branchArtifactId"],
        where: {
          branchArtifactId: { in: branchArtifactIds },
          branch: { artifact: { organizationId } },
        },
        _sum: { additions: true, deletions: true },
      }),
      db.branchDetail.findMany({
        where: {
          artifactId: { in: branchArtifactIds },
          organizationId,
          fileCacheStatus: BranchFileCacheStatus.Fresh,
        },
        select: { artifactId: true },
      }),
    ])
  );
  const lineTotalsByBranch = new Map(
    grouped.map((row) => [
      row.branchArtifactId,
      (row._sum.additions ?? 0) + (row._sum.deletions ?? 0),
    ])
  );
  const enrichedBranchIds = new Set(enriched.map((row) => row.artifactId));
  return { lineTotalsByBranch, enrichedBranchIds };
}

function fetchCheckStatusBuckets(
  organizationId: string
): Promise<DonutSlice[]> {
  return withDb((db) =>
    db.branchDetail.groupBy({
      by: ["checksStatus"],
      where: { artifact: { organizationId } },
      _count: { _all: true },
    })
  ).then((rows) =>
    rows.map((row) => ({
      key: row.checksStatus,
      label: CHECK_STATUS_LABELS[row.checksStatus],
      value: row._count._all,
    }))
  );
}

function fetchBranchesWithoutPrBuckets(
  ctx: InsightsScopeContext
): Promise<CategoryBucket[]> {
  return withDb(async (db) => {
    const artifact = artifactScope(ctx);
    const [withPr, withoutPr] = await Promise.all([
      db.branchDetail.count({
        where: {
          artifact,
          currentPullRequestDetailId: { not: null },
        },
      }),
      db.branchDetail.count({
        where: {
          artifact,
          currentPullRequestDetailId: null,
        },
      }),
    ]);
    return [
      { key: "has-pr", label: "Has a pull request", value: withPr },
      { key: "no-pr", label: "No pull request", value: withoutPr },
    ];
  });
}

/**
 * The two agent charts (agentsByStatus / agentsByType) rolled up in the DB
 * (FEA-2955). Each session's `agents` JSON array is unnested and grouped by the
 * raw status/type in Postgres — mirroring desktop's two `agent.groupBy()` calls
 * — so only one already-counted row per distinct value crosses the wire, rather
 * than materializing every session row and reducing the JSON arrays in JS.
 */
async function fetchAgentBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<{ byStatus: CategoryBucket[]; byType: CategoryBucket[] }> {
  const [byStatus, byType] = await Promise.all([
    fetchAgentFieldBuckets(ctx, start, end, "status"),
    fetchAgentFieldBuckets(ctx, start, end, "type"),
  ]);
  return { byStatus, byType };
}

/**
 * DB rollup of a single agent field (`status` or `type`). Only object array
 * elements contribute, and a missing/blank/non-string value collapses to
 * "unknown" — mirroring the prior in-JS reducer. Raw values are labelized and
 * merged in JS (labelize can map distinct raw values onto the same label), as in
 * {@link fetchSessionRollup}.
 */
async function fetchAgentFieldBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date,
  field: "status" | "type"
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ bucket: string; n: number }[]>(
      // `bucket` (not `value`) deliberately: jsonb_array_elements' implicit
      // output column is named `value`, and Postgres resolves an ambiguous
      // GROUP BY name to that input column over the SELECT alias — which would
      // group by the whole raw element and defeat the DB-side reduction.
      Prisma.sql`
        SELECT
          CASE
            WHEN jsonb_typeof(elem -> ${field}::text) = 'string'
              AND btrim(elem ->> ${field}::text) <> ''
            THEN elem ->> ${field}::text
            ELSE 'unknown'
          END AS bucket,
          COUNT(*)::int AS n
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents
            ELSE '[]'::jsonb
          END
        ) AS elem
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND jsonb_typeof(elem) = 'object'
          AND (${sessionScopeSql(ctx)})
        GROUP BY bucket
      `
    )
  );
  return bucketByLabelCounts(
    rows.map((row) => ({ label: labelize(row.bucket), value: row.n }))
  );
}

/**
 * Single-scan DB rollup of the SessionDetail rows in range: the session count
 * (KPI), summed runtime in ms, and the per-status breakdown — all pure
 * aggregates the DB computes so the (epoch-start, potentially unbounded) row set
 * is never materialized. Runtime mirrors the prior per-row reducer: open
 * sessions (no `session_ended_at`) and any negative span contribute 0 via
 * GREATEST/the NULL-swallowing SUM. Status labels are humanized and merged,
 * matching the prior in-JS bucketing of `labelize(status || "unknown")`.
 */
async function fetchSessionRollup(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<{
  sessionCount: number;
  runtimeMs: number;
  statusBuckets: CategoryBucket[];
}> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      { status: string | null; n: number; runtimeSeconds: number | null }[]
    >(
      Prisma.sql`
        SELECT
          a.status AS status,
          COUNT(*)::int AS n,
          COALESCE(
            SUM(
              GREATEST(
                EXTRACT(EPOCH FROM (s.session_ended_at - s.session_started_at)),
                0
              )
            ),
            0
          ) AS "runtimeSeconds"
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND (${sessionScopeSql(ctx)})
        GROUP BY a.status
      `
    )
  );
  let sessionCount = 0;
  let runtimeSeconds = 0;
  for (const row of rows) {
    sessionCount += row.n;
    runtimeSeconds += Number(row.runtimeSeconds ?? 0);
  }
  const statusBuckets = bucketByLabelCounts(
    rows.map((row) => ({
      label: labelize(row.status || "unknown"),
      value: row.n,
    }))
  );
  return {
    sessionCount,
    runtimeMs: Math.round(runtimeSeconds * MS_PER_SECOND),
    statusBuckets,
  };
}

/**
 * Per-user session counts for the org "user breakdown" chart, grouped in the DB
 * and joined to the owner for the display label. Owner-less sessions (creator
 * deleted → user_id nulled) are excluded, mirroring the prior JS reducer.
 */
async function fetchUserBreakdown(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        userId: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
        n: number;
      }[]
    >(
      Prisma.sql`
        SELECT
          s.user_id AS "userId",
          u.first_name AS "firstName",
          u.last_name AS "lastName",
          u.email AS email,
          COUNT(*)::int AS n
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        JOIN users u ON u.id = s.user_id
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND s.user_id IS NOT NULL
          AND (${sessionScopeSql(ctx)})
        GROUP BY s.user_id, u.first_name, u.last_name, u.email
        ORDER BY n DESC
        LIMIT 50
      `
    )
  );
  return rows.map((row) => ({
    key: row.userId,
    label: displayName({
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
    }),
    value: row.n,
  }));
}

/**
 * Shared scaffolding for a daily `session_detail` aggregate over the trend
 * window, date-bucketed in Postgres so only one already-bucketed row per day
 * crosses the wire (mirrors {@link fetchEventVolume}). `session_started_at` is a
 * `timestamp` (no tz) that stores the UTC wall-clock; truncating it directly
 * yields UTC day keys. When a requester timezone is set (FEA-2745) the instant
 * is reinterpreted as UTC and converted into that zone before truncation so the
 * bucket matches the local calendar day the JS `makeDayKey` would assign — the
 * explicit `AT TIME ZONE 'UTC'` anchor keeps the round-trip independent of the
 * connection's TimeZone. {@link fetchSessionActivity} and
 * {@link fetchToolRunsByDay} differ only in the aggregate expression and the
 * series key/label, so both delegate here rather than duplicating the
 * retry/bucketing logic.
 */
async function fetchDailySessionSeries(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  opts: { aggregateExpr: Prisma.Sql; seriesKey: string; seriesLabel: string }
): Promise<TimeSeries> {
  const runQuery = (timeZone: string | undefined) => {
    const dayExpr = timeZone
      ? Prisma.sql`date_trunc('day', (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`
      : Prisma.sql`date_trunc('day', s.session_started_at)`;
    return withDb((db) =>
      db.$queryRaw<{ day: string; n: number }[]>(
        Prisma.sql`
          SELECT
            to_char(${dayExpr}, 'YYYY-MM-DD') AS day,
            ${opts.aggregateExpr} AS n
          FROM session_detail s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${trendStart}
            AND s.session_started_at <= ${end}
            AND (${sessionScopeSql(ctx)})
          GROUP BY day
        `
      )
    );
  };

  // `ctx.timeZone` is only validated against Node/ICU (isValidTimeZone), so a
  // zone ICU accepts but the Postgres server's tzdata doesn't know (version
  // skew) would make `AT TIME ZONE` raise and 500 the insights endpoint.
  // Degrade to UTC bucketing instead — matching the validator's documented
  // "unknown zone → UTC" contract and the JS `toLocalDateOnly` fallback — so
  // the chart still renders. `bucketedZone` then labels the point enumeration
  // in the SAME zone the DB actually bucketed in.
  let rows: { day: string; n: number }[];
  let bucketedZone = ctx.timeZone;
  try {
    rows = await runQuery(ctx.timeZone);
  } catch (error) {
    // A UTC query (no timezone param) can only fail for a real DB error, so
    // don't swallow it behind a pointless retry.
    if (!ctx.timeZone) {
      throw error;
    }
    // Only degrade to UTC for timezone-specific Postgres errors (tzdata version
    // skew). Genuine DB failures (connection, permissions, syntax) are rethrown
    // so they propagate as real errors rather than being silently swallowed.
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.toLowerCase().includes("time zone")) {
      throw error;
    }
    bucketedZone = undefined;
    rows = await runQuery(undefined);
  }
  const counts = new Map(rows.map((row) => [row.day, row.n]));
  const series: TimeSeriesSeries = {
    key: opts.seriesKey,
    label: opts.seriesLabel,
  };
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

/** Daily session-start volume — one row per session, counted per day. */
function fetchSessionActivity(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries> {
  return fetchDailySessionSeries(ctx, trendStart, end, {
    aggregateExpr: Prisma.sql`COUNT(*)::int`,
    seriesKey: "sessions",
    seriesLabel: "Sessions",
  });
}

function eventScope(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Prisma.AgentSessionEventWhereInput {
  return {
    eventCreatedAt: { gte: start, lte: end },
    session: sessionScope(ctx),
  };
}

function countEvents(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  return withDb((db) =>
    db.agentSessionEvent.count({ where: eventScope(ctx, start, end) })
  );
}

/**
 * Captured-event count grouped by type, aggregated in the DB. Preserves the
 * prior in-JS behavior: labels are humanized and buckets that collapse to the
 * same label are merged, sorted by descending count.
 */
async function fetchEventTypeBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.agentSessionEvent.groupBy({
      by: ["eventType"],
      where: eventScope(ctx, start, end),
      _count: { _all: true },
    })
  );
  return bucketByLabelCounts(
    rows.map((row) => ({
      label: labelize(row.eventType),
      value: row._count._all,
    }))
  );
}

/**
 * Tool invocation count grouped by toolName, aggregated in the DB. Null
 * toolNames (non-tool events) are excluded, matching the prior JS filter.
 */
async function fetchToolUsageBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.agentSessionEvent.groupBy({
      by: ["toolName"],
      where: { ...eventScope(ctx, start, end), toolName: { not: null } },
      _count: { _all: true },
    })
  );
  return bucketByLabelCounts(
    rows
      .filter(
        (row): row is typeof row & { toolName: string } => row.toolName !== null
      )
      .map((row) => ({ label: row.toolName, value: row._count._all }))
  );
}

/**
 * Daily event volume over the trend window. date_trunc + COUNT(*) runs in
 * Postgres so only one already-bucketed row per day crosses the wire, instead
 * of every agentSessionEvent. `event_created_at` is a `timestamp` (no tz) that
 * stores the UTC wall-clock. FEA-2881: to bucket on the viewer's local calendar
 * day (matching the sibling Event activity chart and the desktop path, which
 * uses localDay()), reinterpret that wall-clock as UTC then convert it into
 * `timeZone` before truncating. `timeZone` must be a canonical IANA zone name:
 * the validator canonicalizes offset-style inputs (`+01:00`) to `Etc/GMT±N`
 * because PG's `AT TIME ZONE 'text'` mis-signs bare offsets relative to Intl
 * (FEA-2881 review). We re-canonicalize defensively here so a direct caller
 * can't slip an offset into the SQL; a zone that can't be canonicalized falls
 * back to legacy UTC bucketing. The name is bound as a parameter, so the
 * round-trip is per-request and independent of the connection's TimeZone.
 */
async function fetchEventVolume(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  timeZone?: string
): Promise<TimeSeries> {
  const canonicalZone = timeZone ? canonicalizeTimeZone(timeZone) : null;
  const dayBucket = canonicalZone
    ? Prisma.sql`date_trunc('day', e.event_created_at AT TIME ZONE 'UTC' AT TIME ZONE ${canonicalZone}::text)`
    : Prisma.sql`date_trunc('day', e.event_created_at)`;
  const rows = await withDb((db) =>
    db.$queryRaw<{ day: string; n: number }[]>(
      Prisma.sql`
        SELECT
          to_char(${dayBucket}, 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS n
        FROM agent_session_events e
        JOIN session_detail s ON s.artifact_id = e.agent_session_id
        JOIN artifacts a ON a.id = s.artifact_id
        WHERE e.event_created_at >= ${trendStart}
          AND e.event_created_at <= ${end}
          AND (${sessionScopeSql(ctx)})
        GROUP BY day
      `
    )
  );
  const counts = new Map(rows.map((row) => [row.day, row.n]));
  const series: TimeSeriesSeries = { key: "events", label: "Events" };
  // Label the enumerated day keys with the same canonical zone the SQL bucket
  // used, so JS-labeled keys and SQL-bucketed rows land on identical dates.
  const points = eachDayKey(trendStart, end, canonicalZone ?? undefined).map(
    (date) => ({
      date,
      values: { [series.key]: counts.get(date) ?? 0 },
    })
  );
  return { series: [series], points };
}

function countSessions(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return Promise.resolve(0);
  }
  return withDb((db) =>
    db.sessionDetail.count({
      where: {
        ...sessionScope(ctx),
        sessionStartedAt: { gte: start, lt: end },
      },
    })
  );
}

function countReviewBacklog(ctx: InsightsScopeContext): Promise<number> {
  return withDb((db) =>
    db.pullRequestDetail.count({
      where: {
        branchArtifact: artifactScope(ctx),
        reviewDecision: null,
      },
    })
  );
}

function fetchReviews(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<ReviewRow[]> {
  return withDb((db) =>
    db.gitHubPRReview.findMany({
      where: {
        submittedAt: { gte: start, lte: end },
        pullRequestDetail: {
          branchArtifact: artifactScope(ctx),
        },
      },
      select: {
        authorLogin: true,
        state: true,
        submittedAt: true,
        pullRequestDetail: {
          select: { branchArtifact: { select: { createdAt: true } } },
        },
      },
    })
  );
}

async function fetchReviewQueueBuckets(
  ctx: InsightsScopeContext
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.pullRequestDetail.groupBy({
      by: ["reviewDecision"],
      where: {
        branchArtifact: artifactScope(ctx),
        prState: { not: GitHubPRState.MERGED },
      },
      _count: { _all: true },
    })
  );
  return rows.map((row) => ({
    key: row.reviewDecision ?? "PENDING",
    label: REVIEW_QUEUE_LABELS[row.reviewDecision ?? "PENDING"],
    value: row._count._all,
  }));
}

/**
 * Where clause shared by the token-usage aggregations: rows whose owning session
 * is in scope and started within [start, end]. Keep in lockstep with the raw-SQL
 * mirror in {@link fetchModelUsageRows} (see {@link sessionScopeSql}).
 */
function tokenUsageScope(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Prisma.AgentSessionTokenUsageWhereInput {
  return {
    session: {
      ...sessionScope(ctx),
      sessionStartedAt: { gte: start, lte: end },
    },
  };
}

/**
 * Token-column totals for the KPI row and the token-distribution donut, summed
 * in Postgres rather than by materializing every agentSessionTokenUsage row (one
 * per session×model — unbounded for the "all" period, which starts at the epoch)
 * and reducing in JS. Token columns are BigInt (int8); the insights surfaces work
 * in JS numbers (exact up to Number.MAX_SAFE_INTEGER), so narrow the sums at this
 * boundary, matching the prior per-row Number() cast.
 */
async function fetchTokenTotals(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<TokenTotals> {
  const { _sum } = await withDb((db) =>
    db.agentSessionTokenUsage.aggregate({
      where: tokenUsageScope(ctx, start, end),
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    })
  );
  return {
    inputTokens: Number(_sum.inputTokens ?? 0),
    outputTokens: Number(_sum.outputTokens ?? 0),
    cacheReadTokens: Number(_sum.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(_sum.cacheWriteTokens ?? 0),
  };
}

/**
 * Spend (USD) by model, grouped in the DB. FEA-2331 ranks models by estimated
 * spend, not raw tokens. The distinct-model KPI is this array's length (groupBy
 * emits one row per distinct model). estimatedCost is Decimal(14,6) → a JS float
 * at the same boundary as the token totals; rounded to cents for display and
 * sorted descending so the top-N slice drives the model-usage series.
 */
async function fetchModelBreakdown(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.agentSessionTokenUsage.groupBy({
      by: ["model"],
      where: tokenUsageScope(ctx, start, end),
      _sum: { estimatedCost: true },
    })
  );
  return rows
    .map((row) => ({
      key: row.model,
      label: row.model,
      value: round(toNumber(row._sum.estimatedCost), 2),
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Per-day per-model spend over the trend window, date-bucketed in Postgres so
 * only one aggregate row per (day, model) crosses the wire instead of every
 * token row. Mirrors {@link fetchEventVolume}, but buckets `session_started_at`
 * in the requester's timezone (FEA-2745): the column is a tz-naive `timestamp`
 * holding the UTC wall-clock, so `AT TIME ZONE 'UTC'` reinterprets it as an
 * instant and `AT TIME ZONE ${zone}` shifts it to the local calendar day. A UTC
 * zone round-trips to the original wall-clock, matching makeDayKey(undefined)'s
 * legacy UTC bucketing. estimatedCost sums to float8 (USD); the series rounds to
 * cents once at emit time.
 */
async function fetchModelUsageRows(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  timeZone?: string
): Promise<{ rows: ModelUsageDayRow[]; bucketZone: string }> {
  const runQuery = (zone: string) =>
    withDb((db) =>
      db.$queryRaw<{ day: string; model: string; cost: number }[]>(
        Prisma.sql`
          SELECT
            to_char(
              date_trunc(
                'day',
                (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${zone}
              ),
              'YYYY-MM-DD'
            ) AS day,
            tu.model AS model,
            SUM(tu.estimated_cost)::float8 AS cost
          FROM agent_session_token_usage tu
          JOIN session_detail s ON s.artifact_id = tu.agent_session_id
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${trendStart}
            AND s.session_started_at <= ${end}
            AND (${sessionScopeSql(ctx)})
          GROUP BY day, tu.model
        `
      )
    );

  // Mirror the UTC-retry pattern from fetchDailySessionSeries: `ctx.timeZone`
  // is validated against Node/ICU but a zone ICU accepts may be unknown to the
  // Postgres server's tzdata (version skew). Degrade to UTC bucketing rather
  // than propagating the error as a 500 for the entire /insights/agents endpoint.
  const effectiveZone = timeZone ?? "UTC";
  // The zone the rows are actually bucketed in. Stays `effectiveZone` on the
  // happy path but flips to "UTC" when the tzdata-skew retry fires, so the
  // caller can enumerate chart day keys in the same zone the rows were keyed in
  // (otherwise UTC row keys wouldn't match local-zone point keys near day
  // boundaries and spend would be dropped or misattributed).
  let bucketZone = effectiveZone;
  let raw: { day: string; model: string; cost: number }[];
  try {
    raw = await runQuery(effectiveZone);
  } catch (error) {
    // Only retry for timezone-specific Postgres rejections. Genuine DB errors
    // (connection, permissions, syntax) are rethrown immediately.
    if (!timeZone) {
      throw error;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.toLowerCase().includes("time zone")) {
      throw error;
    }
    raw = await runQuery("UTC");
    bucketZone = "UTC";
  }

  return {
    bucketZone,
    rows: raw.map((row) => ({
      day: row.day,
      model: row.model,
      cost: Number(row.cost),
    })),
  };
}

/**
 * Daily tool-run totals over the trend window, summed in Postgres so only one
 * already-bucketed row per day crosses the wire (mirrors
 * {@link fetchSessionActivity}) instead of materializing every session row and
 * reducing in JS. Buckets `session_started_at` — a tz-naive `timestamp` holding
 * the UTC wall-clock — in the requester's timezone (FEA-2745, FEA-2956): the
 * explicit `AT TIME ZONE 'UTC'` anchor reinterprets it as an instant and
 * `AT TIME ZONE ${zone}` shifts it to the local calendar day, matching the JS
 * `makeDayKey` bucketing. `tool_use_count` is an `Int`, so `SUM(...)::int`
 * keeps the driver yielding plain numbers.
 */
function fetchToolRunsByDay(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries> {
  return fetchDailySessionSeries(ctx, trendStart, end, {
    aggregateExpr: Prisma.sql`SUM(s.tool_use_count)::int`,
    seriesKey: "tool-runs",
    seriesLabel: "Tool runs",
  });
}

async function sumSessionCost(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return 0;
  }
  const result = await withDb((db) =>
    db.sessionDetail.aggregate({
      _sum: { estimatedCost: true },
      where: {
        ...sessionScope(ctx),
        sessionStartedAt: { gte: start, lt: end },
      },
    })
  );
  return toNumber(result._sum.estimatedCost);
}

async function sumToolRuns(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return 0;
  }
  const result = await withDb((db) =>
    db.sessionDetail.aggregate({
      _sum: { toolUseCount: true },
      where: {
        ...sessionScope(ctx),
        sessionStartedAt: { gte: start, lt: end },
      },
    })
  );
  return result._sum.toolUseCount ?? 0;
}

/**
 * FEA-2233: earliest relevant record across the tables that feed the delta KPIs
 * (merged PRs + agent sessions), scoped to the same org/me context as the rest
 * of the computation so a personal view is not gated by org-wide history (and
 * vice versa). Powers the "full prior period" rule in {@link reportDeltaFor}.
 * Returns null when there is no history at all.
 */
async function earliestRecord(ctx: InsightsScopeContext): Promise<Date | null> {
  const [session, pr] = await Promise.all([
    withDb((db) =>
      db.sessionDetail.aggregate({
        _min: { sessionStartedAt: true },
        where: { ...sessionScope(ctx) },
      })
    ),
    withDb((db) =>
      db.pullRequestDetail.aggregate({
        _min: { mergedAt: true },
        where: { branchArtifact: artifactScope(ctx) },
      })
    ),
  ]);
  return minDate(session._min.sessionStartedAt, pr._min.mergedAt);
}

// ───────────────────────── pure helpers ─────────────────────────

export function resolvePeriodRange(
  period: InsightsPeriod,
  now: Date
): PeriodRange {
  const end = now;
  if (period === InsightsPeriodValues.All) {
    return {
      start: new Date(0),
      end,
      priorStart: null,
      trendStart: addDays(end, -TREND_LOOKBACK_DAYS),
    };
  }
  const days = Number(period);
  const start = addDays(end, -days);
  return {
    start,
    end,
    priorStart: addDays(start, -days),
    trendStart: start,
  };
}

/** Smallest of the provided dates, ignoring null/undefined; null if none. */
export function minDate(...dates: (Date | null | undefined)[]): Date | null {
  let earliest: Date | null = null;
  for (const date of dates) {
    if (date && (earliest === null || date < earliest)) {
      earliest = date;
    }
  }
  return earliest;
}

/**
 * FEA-2233: uniform calendar rule. Returns a delta reporter that only surfaces a
 * period-over-period percentage when there is a FULL prior period to compare
 * against — the earliest relevant record is on or before the prior window's
 * start. For the "all" period `priorStart` is null, so this is naturally false
 * (no comparison). When not comparable the delta is null, which the dashboard
 * renders as a hidden chip rather than a misleading percentage computed against a
 * partial prior window. The empty-prior case (`prior === 0`) is still handled by
 * `pctDelta`.
 */
export function reportDeltaFor(
  range: PeriodRange,
  earliest: Date | null
): (current: number, prior: number) => number | null {
  const hasFullPriorPeriod =
    range.priorStart !== null &&
    earliest !== null &&
    earliest <= range.priorStart;
  return (current, prior) =>
    hasFullPriorPeriod ? pctDelta(current, prior) : null;
}

/**
 * Buckets pre-aggregated (label, count) pairs coming from a DB `groupBy`. Merges
 * any labels that collide after transformation and sorts by descending count —
 * the key mirrors the label, as before.
 */
export function bucketByLabelCounts(
  entries: { label: string; value: number }[]
): CategoryBucket[] {
  const counts = new Map<string, number>();
  for (const { label, value } of entries) {
    counts.set(label, (counts.get(label) ?? 0) + value);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ key: label, label, value }))
    .sort((a, b) => b.value - a.value);
}

/**
 * FEA-2732 / review: build the (label, count) entries for the "PRs by repo"
 * chart, collapsing the App and desktop lanes for one physical repo into a
 * single bucket. The App lane supplies GitHub's canonical-case short
 * `repository.name`; the repo-less desktop lane only has `repositoryFullName`
 * (owner/name), lowercased by normalizeRepoFullName. Grouping by a
 * case-insensitive key prevents "Foo-Bar" and "foo-bar" from becoming two
 * buckets; the display label prefers the App's canonical casing when any row in
 * the group supplies it, else falls back to the (lowercased) short name. Rows
 * carrying neither identity cannot be bucketed by repo and are dropped.
 */
export function buildPrByRepoBuckets(
  merged: MergedPrRow[]
): { label: string; value: number }[] {
  const byKey = new Map<
    string,
    { label: string; value: number; canonical: boolean }
  >();
  for (const pr of merged) {
    const canonicalName = pr.repository?.name ?? null;
    const label =
      canonicalName ?? pr.repositoryFullName?.split("/").at(-1) ?? null;
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.value += 1;
      // Upgrade to the App's canonical casing once any row in the group has it.
      if (!existing.canonical && canonicalName !== null) {
        existing.label = canonicalName;
        existing.canonical = true;
      }
    } else {
      byKey.set(key, { label, value: 1, canonical: canonicalName !== null });
    }
  }
  return [...byKey.values()].map(({ label, value }) => ({ label, value }));
}

export function bucketCountByDay(
  dates: Date[],
  start: Date,
  end: Date,
  series: TimeSeriesSeries,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const date of dates) {
    if (date >= start && date <= end) {
      const key = toKey(date);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

function bucketKlocByDay(
  merged: MergedPrRow[],
  lineTotalsByBranch: Map<string, number>,
  start: Date,
  end: Date,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const pr of merged) {
    if (!(pr.mergedAt && pr.mergedAt >= start && pr.mergedAt <= end)) {
      continue;
    }
    const key = toKey(pr.mergedAt);
    const kloc = (lineTotalsByBranch.get(pr.branchArtifactId) ?? 0) / 1000;
    counts.set(key, (counts.get(key) ?? 0) + kloc);
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { kloc: round(counts.get(date) ?? 0, 1) },
  }));
  return { series: [{ key: "kloc", label: "KLOC merged" }], points };
}

// FEA-2878: every fetched row is MERGED, so the state distribution is a single
// bucket sized by the exact merged count — not the (possibly capped) row array —
// keeping it consistent with the "Merged PRs" KPI at any org size.
function mergedStateBuckets(mergedCount: number): CategoryBucket[] {
  if (mergedCount === 0) {
    return [];
  }
  return [
    {
      key: GitHubPRState.MERGED,
      label: GITHUB_PR_STATE_LABELS[GitHubPRState.MERGED],
      value: mergedCount,
    },
  ];
}

function reviewerRows(reviews: ReviewRow[]): ReviewerRow[] {
  const byReviewer = new Map<
    string,
    { reviewed: number; approved: number; waits: number[] }
  >();
  for (const review of reviews) {
    const entry = byReviewer.get(review.authorLogin) ?? {
      reviewed: 0,
      approved: 0,
      waits: [],
    };
    entry.reviewed += 1;
    if (review.state === ReviewDecision.APPROVED) {
      entry.approved += 1;
    }
    const wait =
      review.submittedAt.getTime() -
      review.pullRequestDetail.branchArtifact.createdAt.getTime();
    if (wait >= 0) {
      entry.waits.push(wait);
    }
    byReviewer.set(review.authorLogin, entry);
  }
  return [...byReviewer.entries()]
    .map(([reviewer, { reviewed, approved, waits }]) => ({
      reviewer,
      reviewed,
      approved,
      medianWaitMs: median(waits),
    }))
    .sort((a, b) => b.reviewed - a.reviewed);
}

function tokenDistributionBuckets(totals: TokenTotals): CategoryBucket[] {
  return [
    { key: "input", label: "Input", value: totals.inputTokens },
    { key: "output", label: "Output", value: totals.outputTokens },
    { key: "cache-read", label: "Cache read", value: totals.cacheReadTokens },
    {
      key: "cache-write",
      label: "Cache write",
      value: totals.cacheWriteTokens,
    },
  ];
}

function modelUsageSeries(
  rows: ModelUsageDayRow[],
  breakdown: CategoryBucket[],
  start: Date,
  end: Date,
  timeZone?: string
): TimeSeries {
  const topModels = breakdown
    .slice(0, MAX_MODEL_SERIES)
    .map((bucket) => bucket.key);
  const topSet = new Set(topModels);
  const seriesKey = (model: string) => (topSet.has(model) ? model : "other");

  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = byDay.get(row.day) ?? {};
    const sKey = seriesKey(row.model);
    // FEA-2331: stack estimated spend (USD) per day, not tokens. Rows already
    // carry the per-(day, model) DB sum; models outside the top-N collapse into
    // "other" and round to cents once at emit (below) to avoid rounding drift.
    day[sKey] = (day[sKey] ?? 0) + row.cost;
    byDay.set(row.day, day);
  }

  // usesOther ⟺ a model outside the top-N appears in the trend-window rows.
  // Previously derived as `breakdown.length > MAX_MODEL_SERIES` (full-period
  // breakdown), but `rows` only covers the 90-day trend window so the two
  // windows can disagree: a model active long ago but absent from the trend
  // window would incorrectly show an "Other" series with no data. Derive from
  // the rows themselves — the same set that populates the chart — to stay
  // accurate regardless of window differences (#2498).
  const usesOther = rows.some((row) => !topSet.has(row.model));
  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: "other", label: "Other" });
  }

  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: roundSpendValues(byDay.get(date) ?? {}),
  }));
  return { series, points };
}

// Round each model's accumulated daily spend to whole cents (FEA-2331).
function roundSpendValues(
  values: Record<string, number>
): Record<string, number> {
  const rounded: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    rounded[key] = round(value, 2);
  }
  return rounded;
}

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

// FEA-2745: build a yyyy-MM-dd bucket key that labels each instant by the
// calendar day it falls on in `timeZone`. Undefined timeZone keeps the legacy
// UTC bucketing (fast path, no formatter). Mirrors the desktop localDayKey()
// contract so the two surfaces attribute the same activity to the same day.
function makeDayKey(timeZone?: string): (date: Date) => string {
  // Reuses the shared per-timezone formatter cache (getDateOnlyFormatter) and
  // its UTC fallback so each chart bucket doesn't construct a fresh
  // Intl.DateTimeFormat. `en-CA` emits YYYY-MM-DD, matching toIsoDateOnly's
  // slice(0, 10) fallback for missing/invalid zones.
  return (date) => toLocalDateOnly(date, timeZone);
}

function eachDayKey(start: Date, end: Date, timeZone?: string): string[] {
  const toKey = makeDayKey(timeZone);
  const keys: string[] = [];
  // Anchor enumeration on the local calendar dates of the window edges, then
  // advance in UTC-midnight steps: date-only arithmetic is DST-free, so each
  // 24h step yields exactly one consecutive calendar day whose slice(0,10)
  // matches the toKey() labels above.
  const cursor = new Date(`${toKey(start)}T00:00:00.000Z`);
  const endDay = new Date(`${toKey(end)}T00:00:00.000Z`).getTime();
  while (cursor.getTime() <= endDay) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setTime(cursor.getTime() + MS_PER_DAY);
  }
  return keys;
}

function buildDeliveryTileAvailability({
  checkStatusAvailable,
  hasDecidedPrCohort,
  hasTtmEvidence,
}: {
  checkStatusAvailable: boolean;
  hasDecidedPrCohort: boolean;
  hasTtmEvidence: boolean;
}): InsightsTileAvailabilityMap {
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  const available = InsightsTileAvailabilityState.Available;
  return {
    "kpi:merged": available,
    "kpi:ttm": hasTtmEvidence ? available : unavailable,
    // FEA-3151: gate on the DECIDED cohort (merged + closed > 0), matching the
    // decided-denominator merge rate; opened-but-undecided PRs yield a null rate.
    "kpi:merge-rate": hasDecidedPrCohort ? available : unavailable,
    "chart:branchesWithoutPr": available,
    "chart:branchesWithoutPr:donut": available,
    "chart:checkStatus": checkStatusAvailable ? available : unavailable,
    "chart:checkStatus:bar": checkStatusAvailable ? available : unavailable,
  };
}

function buildUtilizationTileAvailability({
  isOrg,
}: {
  isOrg: boolean;
}): InsightsTileAvailabilityMap {
  const state = isOrg
    ? InsightsTileAvailabilityState.Available
    : InsightsTileAvailabilityState.Unavailable;
  return {
    "kpi:backlog": state,
    "chart:reviewQueue": state,
    "chart:reviewQueue:donut": state,
    "chart:reviewerLoad": state,
  };
}

const CHECK_STATUS_LABELS: Record<ChecksStatus, string> = {
  [ChecksStatus.PASSING]: "Passing",
  [ChecksStatus.FAILING]: "Failing",
  [ChecksStatus.PENDING]: "Running",
  [ChecksStatus.UNKNOWN]: "Unknown",
};

const REVIEW_QUEUE_LABELS: Record<ReviewDecision | "PENDING", string> = {
  PENDING: "Awaiting review",
  [ReviewDecision.APPROVED]: "Approved, not merged",
  [ReviewDecision.CHANGES_REQUESTED]: "Changes requested",
  [ReviewDecision.COMMENTED]: "Commented",
  [ReviewDecision.DISMISSED]: "Dismissed",
};

async function resolveGitHubProvenance(
  ctx: InsightsScopeContext
): Promise<InsightsGitHubProvenance | null> {
  if (ctx.scope === InsightsScope.Me) {
    return null;
  }
  const githubDataConnection = await withDb((db) =>
    resolveGitHubDataConnectionStatus(db, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    })
  );
  return {
    state: githubDataConnection.connected
      ? InsightsGitHubProvenanceState.Active
      : InsightsGitHubProvenanceState.Disconnected,
    checkedAt: new Date().toISOString(),
  };
}
