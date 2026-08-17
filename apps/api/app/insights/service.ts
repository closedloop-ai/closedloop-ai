import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import { ssotMergeRateFromCounts } from "@repo/api/src/insights/delivery-kpis/parity";
import { GITHUB_PR_STATE_LABELS } from "@repo/api/src/types/github";
import {
  type AgentPipelineGraphData,
  type AgentsInsightsResponse,
  type CategoryBucket,
  type DeliveryInsightsResponse,
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
import { GitHubPRState, Prisma, ReviewDecision, withDb } from "@repo/database";
import {
  COST_KPI_SUB,
  comparableKpi,
  kpi,
  lifespanHistogram,
  pctDelta,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { log } from "@repo/observability/log";
import { fetchAgentsSpendBreakdowns } from "@/app/insights/agents-spend";
import {
  fetchBranchesWithoutPrBuckets,
  fetchCheckStatusBuckets,
} from "@/app/insights/insights-branch-population";
import { fetchActivityHeatmap } from "@/app/insights/lib/activity-heatmap";
import { fetchReviewQueue } from "@/app/insights/review-backlog";
import {
  cacheTokens,
  countedTokens,
  type TokenTotals,
  tokenDistributionBuckets,
} from "@/app/insights/token-derivations";
import { resolveGitHubDataConnectionStatus } from "@/app/integrations/github/data-connection-status";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";
import { canonicalizeTimeZone } from "@/lib/date-only";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";
import {
  eachDayKey,
  makeDayKey,
  runDailyBucketedQuery,
} from "./lib/daily-buckets";
import {
  dedupeMergedPrsWithEarliestCreation,
  distinctMergedPrCount,
  mergedLocKpis,
  mergedPrLoc,
  mergedPrLocTotals,
} from "./merged-pr-loc";
import {
  countClosedPrs,
  countDistinctPriorMergedPrs,
  countMergedPrsInRange,
  fetchMergedPrs,
  type MergedPrRow,
} from "./merged-pr-queries";

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const TREND_LOOKBACK_DAYS = 90;
const MAX_MODEL_SERIES = 6;

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

export type ArtifactScopeWhere = Prisma.ArtifactWhereInput;

// One DB-aggregated (day, model) bucket for the model-usage series (FEA-2331:
// estimated spend in USD; FEA-3497: total token volume — input + output + cache
// read/write — for the $/# usage toggle), date-bucketed in the requester's tz.
type ModelUsageDayRow = {
  day: string;
  model: string;
  cost: number;
  tokens: number;
};

async function getDelivery(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<DeliveryInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const [
    merged,
    mergedRowCount,
    priorMergedCount,
    closedCount,
    cost,
    priorCost,
    earliest,
    githubProvenance,
  ] = await Promise.all([
    fetchMergedPrs(ctx, range.start, range.end),
    countMergedPrsInRange(ctx, range.start, range.end),
    countDistinctPriorMergedPrs(ctx, range.priorStart, range.start),
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

  // PLN-1535 M4 / D1 + ISS-5411: one pull request can be projected by two rows
  // (see `merged-pr-loc.ts` for why that pair exists and why no unique
  // constraint forbids it), so every merged-PR figure below is taken over the
  // DEDUPED population — not just the LOC-derived ones PLN-1535 originally
  // covered. Deduping once here is what keeps the response reconciling with
  // itself: the headline count, its delta, the state and repo splits, the daily
  // trend, the KLOC sum, the median population, and the TTM/lifespan intervals
  // all describe pull requests rather than rows.
  const dedupedMerged = dedupeMergedPrsWithEarliestCreation(merged);
  // The row count is exact and uncapped where the scan is capped, so the
  // headline count corrects the count rather than replacing it with
  // `dedupedMerged.length`.
  const mergedCount = distinctMergedPrCount(mergedRowCount, merged);

  // A duplicate row on a SECOND branch artifact carries that artifact's own
  // createdAt, so before the dedupe one PR could contribute two DIFFERENT
  // merge intervals to the median and to both histograms. The deduped winner
  // carries its PR's EARLIEST branch creation (see
  // dedupeMergedPrsWithEarliestCreation), so a winner projected after the
  // merge cannot erase the valid interval a losing twin held.
  const ttms = dedupedMerged
    .filter((pr) => pr.mergedAt)
    .map(
      (pr) =>
        (pr.mergedAt as Date).getTime() - pr.branchArtifact.createdAt.getTime()
    )
    .filter((ms) => ms >= 0);
  const [branchesWithoutPr, checkStatus] = await Promise.all([
    // ISS-4634: both branch-population charts sit under the windowed "Last N
    // days" section, so they take the SAME range every sibling delivery fetch
    // takes. See insights-branch-population.ts (branchActivityWindow) for the
    // population-vs-attribute split.
    fetchBranchesWithoutPrBuckets(artifactScope(ctx), range.start, range.end),
    isOrgScope(ctx)
      ? fetchCheckStatusBuckets(ctx.organizationId, range.start, range.end)
      : Promise.resolve(undefined),
  ]);
  // PLN-1535 M4 / D1: LOC comes from each PR's OWN projected diff stats, deduped
  // by PR identity, not from the branch file cache — that keyed on the branch
  // artifact, so every merged PR on a branch got the BRANCH's whole line total
  // (a two-PR branch counted twice) and an un-enriched branch folded in as `0`.
  // The dedupe happens once, above, over the population every merged-PR facet
  // now shares (ISS-5411). Every KPI derived wholly from those totals — including
  // the ISS-5412 unknown-KLOC gate and the ISS-5414 coverage captions — is built
  // by `mergedLocKpis`, in the same module that owns the derivation.
  const { kloc, mergedKloc, prsWithoutLoc, prsScanned, prSize } = mergedLocKpis(
    mergedPrLocTotals(dedupedMerged)
  );

  const kpis: KpiStat[] = [
    comparableKpi(
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
    comparableKpi(
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
      // (the PR's earliest branch-artifact creation → merge), NOT first-commit →
      // merge. No first-commit timestamp is captured on this surface, so label
      // it for what it actually measures.
      "branch created → merged"
    ),
    kloc,
    mergedKloc,
    prsWithoutLoc,
    prsScanned,
    // ISS-4994: caption owned by `COST_KPI_SUB`, which documents why this figure
    // is named for its basis rather than called "spend".
    //
    // wongk review: the raw aggregate is sent, NOT `round(cost, 2)`. Rounding to
    // cents here re-introduced the exact lie ISS-4919 fixes one layer down: a
    // genuine $0.004 org total became numeric `0` before any formatter saw it,
    // so the shared sub-floor bound could never fire and web rendered `$0` while
    // desktop — which sends `totalCost` unrounded (`local-insights.ts`) — rendered
    // the real figure. Display precision belongs to the formatter
    // (`formatCurrencyTileValue`), not the producer; sending the raw total is also
    // what makes the two producers agree on one number.
    comparableKpi(
      "cost",
      "Cost",
      cost,
      KpiFormat.Currency,
      COST_KPI_SUB,
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
      //
      // ISS-5411: BOTH sides count distinct pull requests. Deduping only the
      // merged side would divide pull requests by rows and understate the rate;
      // leaving both on rows would print a percentage the "Merged PRs" tile
      // beside it cannot reproduce.
      ssotMergeRateFromCounts(mergedCount, closedCount),
      KpiFormat.Percent,
      "of decided PRs (merged + closed)"
    ),
    prSize,
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
        dedupedMerged
          .filter((pr) => pr.mergedAt)
          .map((pr) => pr.mergedAt as Date),
        range.trendStart,
        range.end,
        { key: "merged", label: "Merged PRs" },
        ctx.timeZone
      ),
      klocTrend: bucketKlocByDay(
        dedupedMerged,
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
      prByRepo: bucketByLabelCounts(
        buildPrByRepoBuckets(dedupedMerged, merged)
      ),
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
    reviewQueueSnapshot,
    reviewerLoad,
    userBreakdown,
    eventActivity,
    activityHeatmap,
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
    // The review-queue chart and the review-backlog KPI both read the non-merged
    // PR-by-decision population, so one snapshot feeds both (no read-to-read skew;
    // see fetchReviewQueue).
    fetchReviewQueue(ctx),
    isOrgScope(ctx) ? fetchReviewerLoad(ctx, range.start, range.end) : [],
    isOrgScope(ctx) ? fetchUserBreakdown(ctx, range.start, range.end) : [],
    // Daily session-start volume, date-bucketed in Postgres (mirrors
    // fetchEventVolume) so only one already-bucketed row per day crosses the
    // wire instead of every SessionDetail.
    fetchSessionActivity(ctx, range.trendStart, range.end),
    // FEA-3684 / ISS-5408: hour×day Human/Agent turn-density heatmap. Human
    // turns come from the synced `metadata.messages`; Agent turns are the
    // BILLABLE ROUND-TRIPS in `agent_session_token_events` — the same unit the
    // desktop's `session_turn_bucket` uses, which the cloud already receives.
    // Follows the capped trend window, so cloud and desktop-Cloud-mode both
    // render Event Activity from one source.
    fetchActivityHeatmap(
      sessionScopeSql(ctx),
      ctx.timeZone,
      range.trendStart,
      range.end
    ),
    earliestRecord(ctx),
    resolveGitHubProvenance(ctx),
  ]);
  const reportDelta = reportDeltaFor(range, earliest);
  const reviewQueue = reviewQueueSnapshot.buckets;
  const backlog = reviewQueueSnapshot.backlog;

  const currentSessionCount = sessionRollup.sessionCount;
  const runtimeMs = sessionRollup.runtimeMs;

  const kpis: KpiStat[] = [
    comparableKpi(
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
      "hours of agent execution"
    ),
    kpi(
      "backlog",
      "Review backlog",
      backlog,
      KpiFormat.Number,
      "open PRs awaiting review"
    ),
    kpi("events", "Events", eventCount, KpiFormat.Number, "captured events"),
  ];

  return {
    kpis,
    tileAvailability: buildUtilizationTileAvailability({
      isOrg: isOrgScope(ctx),
    }),
    ...(githubProvenance ? { githubProvenance } : {}),
    charts: {
      eventActivity,
      activityHeatmap,
      eventVolume,
      eventsByType,
      sessionsByStatus: sessionRollup.statusBuckets,
      ...(isOrgScope(ctx) ? { userBreakdown } : {}),
      ...(isOrgScope(ctx) ? { reviewerLoad } : {}),
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
    spendBreakdowns,
    modelUsage,
    agentBuckets,
    toolUsage,
    toolRuns,
    priorToolRuns,
    toolRunsOverTime,
    agentPipeline,
    frustrationEnabled,
    earliest,
  ] = await Promise.all([
    // Token analytics are summed/grouped in the DB (FEA-2876) rather than
    // materializing every agentSessionTokenUsage row and reducing in JS.
    fetchTokenTotals(ctx, range.start, range.end),
    // ISS-4463: "Spend by model" and "Spend by session outcome" are two GROUPING
    // SETS of ONE statement, so the sibling charts read one MVCC snapshot and a
    // concurrent session sync cannot make them disagree inside one response
    // (wongk, #4282). Fusing also keeps the outcome split off the critical path
    // as an independent failure mode — it rides a scan this section already ran.
    fetchAgentsSpendBreakdowns(sessionScopeSql(ctx), range.start, range.end),
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
    // Aggregate agent-pipeline graph (FEA-3537): nodes by agent/subagent type,
    // edges by parent→child hand-off, rolled up in the DB like the other charts.
    fetchAgentPipelineGraph(ctx, range.start, range.end),
    // FEA-4022: the org's frustration opt-in gate. Read once alongside the other
    // facet queries; when off, the frustration trend is omitted below (empty
    // state) regardless of any raw signal already persisted.
    frustrationSettingService.isFrustrationEnabled(ctx.organizationId),
    earliestRecord(ctx),
  ]);
  // FEA-4022: only aggregate the normalized frustration trend when the org opted
  // in. Sequenced after the gate resolves so we never run the extra query for an
  // opted-out org. Fail-open (T15): frustration is one widget among many on the
  // all-or-nothing Agents response — if its extra aggregate query throws or
  // times out it must NOT take down every other Agents widget with it. On
  // failure the chart is omitted (empty state), never surfaced as a 500 for the
  // whole page.
  const frustrationTrend = frustrationEnabled
    ? await fetchFrustrationTrendSafe(ctx, range.trendStart, range.end)
    : undefined;
  const reportDelta = reportDeltaFor(range, earliest);

  const totalTokens = countedTokens(tokenTotals);
  const totalInputTokens = tokenTotals.inputTokens;
  const totalOutputTokens = tokenTotals.outputTokens;
  const totalCacheTokens = cacheTokens(tokenTotals);
  // ISS-4463: both spend charts come out of the one fused statement above.
  const { modelBreakdown, spendByOutcome } = spendBreakdowns;
  const modelCount = modelBreakdown.length;

  const kpis: KpiStat[] = [
    kpi("tokens", "Tokens", totalTokens, KpiFormat.Tokens, "consumed in range"),
    kpi(
      "input-tokens",
      "Input tokens",
      totalInputTokens,
      KpiFormat.Tokens,
      "prompt tokens"
    ),
    kpi(
      "output-tokens",
      "Output tokens",
      totalOutputTokens,
      KpiFormat.Tokens,
      "completion tokens"
    ),
    kpi(
      "cache-tokens",
      "Cache saved",
      totalCacheTokens,
      KpiFormat.Tokens,
      "cache read/write tokens"
    ),
    kpi(
      "models",
      "Models in use",
      modelCount,
      KpiFormat.Number,
      "distinct models"
    ),
    comparableKpi(
      "tool-runs",
      "Tool runs",
      toolRuns,
      KpiFormat.Number,
      "tool invocations",
      reportDelta(toolRuns, priorToolRuns)
    ),
  ];

  // Spend + token series share the same top-N models so the dashboard's $/#
  // toggle only swaps y-values (FEA-3497). Enumerate the chart in the same zone
  // the rows were bucketed in — normally `ctx.timeZone`, but UTC on the
  // tzdata-skew fallback so point keys still line up with the row keys.
  const modelSeries = modelUsageSeries(
    modelUsage.rows,
    modelBreakdown,
    range.trendStart,
    range.end,
    modelUsage.bucketZone
  );

  return {
    kpis,
    charts: {
      modelUsageOverTime: modelSeries.spend,
      modelTokensOverTime: modelSeries.tokens,
      modelBreakdown,
      tokenDistribution: tokenDistributionBuckets(tokenTotals),
      toolUsage,
      agentsByStatus: agentBuckets.byStatus,
      agentsByType: agentBuckets.byType,
      toolRunsOverTime,
      agentPipeline,
      spendByOutcome,
      // FEA-4022: omitted when the org has not opted in OR no windowed session
      // carries a raw signal — clients render a disabled/empty state.
      ...(frustrationTrend ? { frustrationTrend } : {}),
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
export function artifactScope(ctx: InsightsScopeContext): ArtifactScopeWhere {
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
export function sessionScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
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

/**
 * The two agent charts (agentsByStatus / agentsByType) rolled up in the DB
 * (FEA-2955). Each session's `agents` JSON array is unnested and grouped by the
 * raw status/type in Postgres — mirroring desktop's two `agent.groupBy()` calls
 * — so only one already-counted row per distinct value crosses the wire, rather
 * than materializing every session row and reducing the JSON arrays in JS.
 *
 * FEA-3638 (Tier-2 round-trip collapse): both charts read the SAME unnest of the
 * SAME session window, so they are rolled up in ONE DB round-trip — a single
 * scan whose derived `status`/`type` bucket columns are aggregated with `GROUP BY
 * GROUPING SETS` — instead of two separate `withDb` calls. That drops one
 * concurrent connection off the agents endpoint's fan-out against the max:20
 * Vercel pool (relieving the acquire-timeout queue-wait that surfaced as the
 * dashboard hang). The per-element bucketing (the "unknown" fallback for a
 * missing/blank/non-string value), the labelize + collision-merge, and the
 * org/period scope predicate are all identical to the prior per-field query, so
 * both charts are byte-for-byte unchanged.
 */
async function fetchAgentBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<{ byStatus: CategoryBucket[]; byType: CategoryBucket[] }> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ field: "status" | "type"; bucket: string; n: number }[]>(
      // One scan of the unnested agents; each element contributes a `status_bucket`
      // and a `type_bucket` (the same "unknown" fallback as before). GROUPING SETS
      // ((status_bucket), (type_bucket)) then rolls up each field independently in a
      // single pass: a status-grouping row has type_bucket NULL and vice-versa, so
      // GROUPING() tags which field the row belongs to and COALESCE picks the
      // non-null bucket value. The derived bucket columns are never NULL (the CASE
      // always yields a string), so the disambiguation is unambiguous.
      Prisma.sql`
        SELECT
          CASE WHEN GROUPING(status_bucket) = 0 THEN 'status' ELSE 'type' END AS field,
          COALESCE(status_bucket, type_bucket) AS bucket,
          COUNT(*)::int AS n
        FROM (
          SELECT
            CASE
              WHEN jsonb_typeof(elem -> 'status') = 'string'
                AND btrim(elem ->> 'status') <> ''
              THEN elem ->> 'status'
              ELSE 'unknown'
            END AS status_bucket,
            CASE
              WHEN jsonb_typeof(elem -> 'type') = 'string'
                AND btrim(elem ->> 'type') <> ''
              THEN elem ->> 'type'
              ELSE 'unknown'
            END AS type_bucket
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
        ) unnested
        GROUP BY GROUPING SETS ((status_bucket), (type_bucket))
      `
    )
  );
  const bucketsFor = (field: "status" | "type"): CategoryBucket[] =>
    bucketByLabelCounts(
      rows
        .filter((row) => row.field === field)
        .map((row) => ({ label: labelize(row.bucket), value: row.n }))
    );
  return { byStatus: bucketsFor("status"), byType: bucketsFor("type") };
}

/**
 * The aggregate agent-pipeline graph (FEA-3537): nodes are agent/subagent types
 * (run counts + success rate), edges are weighted parent→child hand-offs. Both
 * are rolled up in the DB from the unnested `agents` JSON — mirroring
 * {@link fetchAgentFieldBuckets} — and share the same scope/period predicate as
 * every other agent chart. A blank/missing type collapses to "unknown" for both
 * node and edge endpoints — so every edge source/target has a matching node —
 * matching the desktop SQLite rollup.
 */
async function fetchAgentPipelineGraph(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<AgentPipelineGraphData> {
  // Status is matched with the shared success/failure term set as a single
  // regex (alternation), so it survives harness-specific variants — consistent
  // with the desktop rollup's LIKE-term approach.
  const successPattern = AGENT_SUCCESS_STATUS_TERMS.join("|");
  const failedPattern = AGENT_FAILED_STATUS_TERMS.join("|");
  const [nodeRows, edgeRows] = await Promise.all([
    withDb((db) =>
      db.$queryRaw<
        {
          subagent_type: string;
          total: number;
          completed: number;
          errors: number;
          sessions: number;
          avg_duration: number | null;
        }[]
      >(Prisma.sql`
        SELECT
          COALESCE(
            NULLIF(btrim(elem ->> 'subagentType'), ''),
            NULLIF(btrim(elem ->> 'type'), ''),
            'unknown'
          ) AS subagent_type,
          COUNT(*)::int AS total,
          SUM(CASE WHEN lower(elem ->> 'status') ~ ${successPattern} THEN 1 ELSE 0 END)::int AS completed,
          SUM(CASE WHEN lower(elem ->> 'status') ~ ${failedPattern} THEN 1 ELSE 0 END)::int AS errors,
          COUNT(DISTINCT s.artifact_id)::int AS sessions,
          AVG(
            CASE
              WHEN jsonb_typeof(elem -> 'startedAt') = 'string'
                AND jsonb_typeof(elem -> 'endedAt') = 'string'
              THEN EXTRACT(EPOCH FROM (
                (elem ->> 'endedAt')::timestamptz - (elem ->> 'startedAt')::timestamptz
              ))
              ELSE NULL
            END
          ) AS avg_duration
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents ELSE '[]'::jsonb END
        ) AS elem
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND jsonb_typeof(elem) = 'object'
          AND (${sessionScopeSql(ctx)})
        GROUP BY subagent_type
        ORDER BY total DESC
        LIMIT 50
      `)
    ),
    withDb((db) =>
      db.$queryRaw<{ source: string; target: string; weight: number }[]>(
        // Self-join the session's agents array: a child (parentExternalAgentId
        // set) maps to the parent whose externalAgentId matches, within the same
        // session. Edge = parentType → childType, weighted by frequency.
        Prisma.sql`
        SELECT
          COALESCE(
            NULLIF(btrim(p ->> 'subagentType'), ''),
            NULLIF(btrim(p ->> 'type'), ''),
            'unknown'
          ) AS source,
          COALESCE(
            NULLIF(btrim(c ->> 'subagentType'), ''),
            NULLIF(btrim(c ->> 'type'), ''),
            'unknown'
          ) AS target,
          COUNT(*)::int AS weight
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents ELSE '[]'::jsonb END
        ) AS c
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents ELSE '[]'::jsonb END
        ) AS p
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND jsonb_typeof(c) = 'object'
          AND jsonb_typeof(p) = 'object'
          AND btrim(COALESCE(c ->> 'parentExternalAgentId', '')) <> ''
          AND (c ->> 'parentExternalAgentId') = (p ->> 'externalAgentId')
          AND (${sessionScopeSql(ctx)})
        GROUP BY source, target
        ORDER BY weight DESC
        LIMIT 50
      `
      )
    ),
  ]);
  const nodes = nodeRows.map((row) => {
    const completed = toNumber(row.completed);
    const errors = toNumber(row.errors);
    const finished = completed + errors;
    return {
      subagentType: row.subagent_type,
      total: toNumber(row.total),
      completed,
      errors,
      sessions: toNumber(row.sessions),
      // Match the desktop rollup: an unfinished type reads as 100% (no failures
      // observed yet) rather than 0.
      successRate: finished > 0 ? (completed / finished) * 100 : 100,
      avgDuration: row.avg_duration == null ? null : toNumber(row.avg_duration),
      trend: [],
    };
  });
  const edges = edgeRows.map((row) => ({
    source: row.source,
    target: row.target,
    weight: toNumber(row.weight),
  }));
  return { nodes, edges };
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
    label: displayUserName({
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

  // Bucket in `ctx.timeZone`, degrading to UTC when the PG server's tzdata
  // rejects it (see runDailyBucketedQuery). `bucketedZone` then labels the point
  // enumeration in the SAME zone the DB actually bucketed in.
  const { rows, bucketedZone } = await runDailyBucketedQuery(
    ctx.timeZone,
    runQuery
  );
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

type FrustrationDayRow = {
  day: string;
  // Sum + count of the SCOPED (Me/Team/Org) scored sessions in this day's
  // bucket, so the per-day mean reflects the requested view. Null/0 when the
  // scope contributed no scored session on a day the org population still did.
  total: number;
  sessions: number;
  // The org population's MAX single-session raw within this day's bucket
  // (UNSCOPED by Me/Team). MAX-of-per-day-orgDayMax over the window is the org
  // population's observed max raw signal (the [0, max] normalization basis) —
  // computed in the same grouped query so it can never disagree with the per-day
  // means.
  orgDayMax: number;
};

/**
 * FEA-4022 (PLN-1481): daily MEAN session frustration, NORMALIZED 0–100 against
 * the org POPULATION's observed MAX single-session raw signal over the same
 * window.
 *
 * The persisted `frustration_raw` is deliberately unbounded and org-scoped, so a
 * fixed 0..100 mapping can't be frozen on the row — the population max drifts as
 * more sessions land (fluctuates on small data, stabilizes after a few hundred).
 * So we aggregate per-day SUM/COUNT/MAX raw in ONE query (each SessionDetail is
 * one row keyed by artifact_id — no linkage fan-out, so a session counts once),
 * take the population max as MAX(dayMax) across the window, then map each day's
 * MEAN raw to round(dayMean / populationMax * 100) in JS. A day mean can never
 * exceed the max single-session raw, so the normalized value stays within
 * [0, 100]. NULL-raw rows (unscored / org opted-out sessions) are excluded from
 * every aggregate so they never dilute the mean or the normalization basis.
 *
 * Returns undefined when no session in the window carries a raw signal (nothing
 * to show / population max is 0) so the caller omits the chart entirely.
 */
async function fetchFrustrationTrend(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries | undefined> {
  const runQuery = (timeZone: string | undefined) => {
    const dayExpr = timeZone
      ? Prisma.sql`date_trunc('day', (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`
      : Prisma.sql`date_trunc('day', s.session_started_at)`;
    // FEA-4022 (T16): the per-day MEAN is scoped to the requested view (Me /
    // Team / Org), but the normalization DENOMINATOR (`orgDayMax`) is the org
    // population's max single-session raw over the same window, independent of
    // the Me/Team scope — the contract normalizes every scope against the org
    // population, so a user's raw of 5 reads the same whether viewed as Me or
    // Org. A per-day scoped mean can never exceed the org population max, so the
    // normalized value stays within [0, 100].
    return withDb((db) =>
      db.$queryRaw<FrustrationDayRow[]>(
        Prisma.sql`
          SELECT
            to_char(${dayExpr}, 'YYYY-MM-DD') AS day,
            SUM(s.frustration_raw) FILTER (WHERE ${sessionScopeSql(ctx)})::float8 AS total,
            COUNT(*) FILTER (WHERE ${sessionScopeSql(ctx)})::int AS sessions,
            MAX(s.frustration_raw)::float8 AS "orgDayMax"
          FROM session_detail s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${trendStart}
            AND s.session_started_at <= ${end}
            AND s.frustration_raw IS NOT NULL
            AND a.organization_id = ${ctx.organizationId}::uuid
          GROUP BY day
        `
      )
    );
  };

  const { rows, bucketedZone } = await runDailyBucketedQuery(
    ctx.timeZone,
    runQuery
  );
  // Population basis: the org's observed MAX single-session raw over the window
  // (MAX of each day's org-wide MAX), independent of the Me/Team scope.
  let populationMax = 0;
  // Only days with at least one SCOPED scored session get a mean; a day with no
  // scored sessions in the selected scope is a genuine gap.
  const meanByDay = new Map<string, number>();
  for (const row of rows) {
    const dayMax = Number(row.orgDayMax);
    if (dayMax > populationMax) {
      populationMax = dayMax;
    }
    const sessions = Number(row.sessions);
    if (sessions <= 0) {
      continue;
    }
    meanByDay.set(row.day, Number(row.total) / sessions);
  }
  // Omit the chart when either (a) the org population has no scored session to
  // normalize against, or (b) the SELECTED scope (Me / Team, incl. Team with no
  // teamId → scope predicate is `false`) contributed no scored session — a chart
  // that is null on every day is "no data for your scope", not a curve, so omit
  // it rather than render an all-gap axis.
  if (populationMax <= 0 || meanByDay.size === 0) {
    return;
  }
  const series: TimeSeriesSeries = {
    key: "frustration",
    label: "Frustration",
  };
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => {
    const mean = meanByDay.get(date);
    // FEA-4022 (T17): a day with no scored sessions is a GAP (null), not a
    // measured calm zero. `TimeSeriesPoint.values` reserves null for "no
    // activity" so the chart renders a break instead of a false calm floor
    // (mirrors the autonomy series' null-gap convention).
    const normalized =
      mean === undefined ? null : Math.round((mean / populationMax) * 100);
    return { date, values: { [series.key]: normalized } };
  });
  return { series: [series], points };
}

/**
 * FEA-4022 (T15): fail-open wrapper around the frustration trend aggregate. The
 * trend is one widget on the all-or-nothing Agents response — its extra grouped
 * query must never cascade a failure to the other widgets. On any error the
 * chart is omitted (the empty state), and the failure is logged server-side for
 * diagnosis rather than turned into a page-wide 500.
 */
async function fetchFrustrationTrendSafe(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries | undefined> {
  try {
    return await fetchFrustrationTrend(ctx, trendStart, end);
  } catch (error) {
    log.error("insights: frustration trend query failed; omitting chart", {
      organizationId: ctx.organizationId,
      scope: ctx.scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
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
 * FEA-3465: a canonical zone the PG server's tzdata rejects (version skew, which
 * canonicalizeTimeZone doesn't catch) likewise degrades to UTC — via the shared
 * {@link runDailyBucketedQuery} its sibling daily series already use — rather
 * than 500ing the whole utilization endpoint.
 */
async function fetchEventVolume(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  timeZone?: string
): Promise<TimeSeries> {
  const canonicalZone = timeZone ? canonicalizeTimeZone(timeZone) : null;
  const runQuery = (zone: string | undefined) => {
    const dayBucket = zone
      ? Prisma.sql`date_trunc('day', e.event_created_at AT TIME ZONE 'UTC' AT TIME ZONE ${zone}::text)`
      : Prisma.sql`date_trunc('day', e.event_created_at)`;
    return withDb((db) =>
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
  };
  // Bucket in the canonical zone, degrading to UTC when the PG server's tzdata
  // rejects it (FEA-3465 — see runDailyBucketedQuery). `bucketedZone` then labels
  // the point enumeration in the SAME zone the DB actually bucketed in.
  const { rows, bucketedZone } = await runDailyBucketedQuery(
    canonicalZone ?? undefined,
    runQuery
  );
  const counts = new Map(rows.map((row) => [row.day, row.n]));
  const series: TimeSeriesSeries = { key: "events", label: "Events" };
  // Label the enumerated day keys with the same zone the SQL bucket used
  // (canonical zone normally, UTC on the tzdata-skew fallback), so JS-labeled
  // keys and SQL-bucketed rows land on identical dates.
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
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

/**
 * Per-reviewer load for the org-scope "reviewer load" table: review count,
 * approval count, and median PR-open→review wait, all rolled up in Postgres via
 * a single GROUP BY author_login scan. Replaces materializing every review row
 * org-wide (unbounded for the "all" period, which starts at the epoch) and
 * reducing to per-author aggregates in JS. Raw SQL because the per-group median
 * (`percentile_cont`) has no Prisma `groupBy` expression.
 *
 * Org-scope only (the sole caller guards on {@link isOrgScope}), so the scope is
 * just the branch artifact's org — no per-user/team predicate like
 * {@link artifactScope}. The wait mirrors the prior JS `wait >= 0` guard with a
 * `FILTER (WHERE r.submitted_at >= a.created_at)`, so reviews submitted before
 * their branch's recorded open time are excluded from the median (and the median
 * is NULL when a reviewer has no non-negative wait), matching `median([]) → null`.
 * `submitted_at - created_at` is an interval; EXTRACT(EPOCH ...)*1000 yields the
 * same millisecond wait the JS path derived from `getTime()` deltas.
 */
async function fetchReviewerLoad(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<ReviewerRow[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        reviewer: string;
        reviewed: number;
        approved: number;
        median_wait_ms: number | null;
      }[]
    >(
      Prisma.sql`
        SELECT
          r.author_login AS reviewer,
          COUNT(*)::int AS reviewed,
          COUNT(*) FILTER (WHERE r.state::text = ${ReviewDecision.APPROVED})::int
            AS approved,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (r.submitted_at - a.created_at)) * 1000
          ) FILTER (WHERE r.submitted_at >= a.created_at) AS median_wait_ms
        FROM github_pr_reviews r
        JOIN pull_request_detail p ON p.id = r.pull_request_id
        JOIN artifacts a ON a.id = p.branch_artifact_id
        WHERE r.submitted_at >= ${start}
          AND r.submitted_at <= ${end}
          AND a.organization_id = ${ctx.organizationId}::uuid
        GROUP BY r.author_login
        ORDER BY reviewed DESC, reviewer ASC
      `
    )
  );
  return rows.map((row) => ({
    reviewer: row.reviewer,
    reviewed: row.reviewed,
    approved: row.approved,
    medianWaitMs:
      row.median_wait_ms === null ? null : Number(row.median_wait_ms),
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
  const runQuery = (zone: string | undefined) =>
    withDb((db) =>
      db.$queryRaw<
        { day: string; model: string; cost: number; tokens: number }[]
      >(
        Prisma.sql`
          SELECT
            to_char(
              date_trunc(
                'day',
                (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${zone ?? "UTC"}
              ),
              'YYYY-MM-DD'
            ) AS day,
            tu.model AS model,
            SUM(tu.estimated_cost)::float8 AS cost,
            -- FEA-3497: total token volume for the dollar/count usage toggle.
            -- Sums input + output + cache read/write so the usage view reflects
            -- real work done (cache-heavy harnesses move huge volume cheaply).
            -- float8 keeps the driver yielding plain numbers, matching cost.
            SUM(
              tu.input_tokens + tu.output_tokens
              + tu.cache_read_tokens + tu.cache_write_tokens
            )::float8 AS tokens
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

  // Bucket in the requester's timezone, degrading to UTC when the PG server's
  // tzdata rejects it (see runDailyBucketedQuery). `bucketZone` is the zone the
  // rows were actually keyed in — `timeZone` on the happy path, "UTC" when it's
  // unset or the tzdata-skew fallback fires — so the caller enumerates chart day
  // keys in the same zone (otherwise UTC row keys wouldn't match local-zone point
  // keys near day boundaries and spend would be dropped or misattributed).
  const { rows: raw, bucketedZone } = await runDailyBucketedQuery(
    timeZone,
    runQuery
  );
  const bucketZone = bucketedZone ?? "UTC";

  return {
    bucketZone,
    rows: raw.map((row) => ({
      day: row.day,
      model: row.model,
      cost: Number(row.cost),
      tokens: Number(row.tokens),
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
function bucketByLabelCounts(
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
 *
 * ISS-5411 split the two inputs. Buckets are COUNTED over `dedupedMerged`,
 * because case-folding the label only stops the two lanes from fragmenting into
 * two BUCKETS — it never stopped one pull request counting twice inside one.
 * Casing is still resolved over ALL `scanned` rows: when a repo-less desktop row
 * wins the dedupe (it is the sized one), dropping its App twin would otherwise
 * take the only canonical-case name for that repo with it and downgrade the
 * label to "foo-bar". A row excluded from the count can still name its repo.
 */
export function buildPrByRepoBuckets(
  dedupedMerged: MergedPrRow[],
  scanned: MergedPrRow[]
): { label: string; value: number }[] {
  const canonicalByKey = new Map<string, string>();
  for (const pr of scanned) {
    const canonicalName = pr.repository?.name;
    if (canonicalName) {
      canonicalByKey.set(canonicalName.toLowerCase(), canonicalName);
    }
  }
  const byKey = new Map<string, { label: string; value: number }>();
  for (const pr of dedupedMerged) {
    const label =
      pr.repository?.name ?? pr.repositoryFullName?.split("/").at(-1) ?? null;
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.value += 1;
    } else {
      byKey.set(key, { label: canonicalByKey.get(key) ?? label, value: 1 });
    }
  }
  return [...byKey.values()];
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

/**
 * PLN-1535 M4: takes ALREADY-DEDUPED merged PRs and reads each PR's own
 * projected size, so the daily series is taken of the same population as the
 * KLOC tile. A PR with unknown LOC contributes nothing to its day rather than a
 * zero — the day's bar is a lower bound over what is known, matching the tile.
 */
function bucketKlocByDay(
  dedupedMerged: MergedPrRow[],
  start: Date,
  end: Date,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const pr of dedupedMerged) {
    if (!(pr.mergedAt && pr.mergedAt >= start && pr.mergedAt <= end)) {
      continue;
    }
    const loc = mergedPrLoc(pr);
    if (loc === null) {
      continue;
    }
    const key = toKey(pr.mergedAt);
    counts.set(key, (counts.get(key) ?? 0) + loc / 1000);
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { kloc: round(counts.get(date) ?? 0, 1) },
  }));
  return { series: [{ key: "kloc", label: "KLOC merged" }], points };
}

// FEA-2878: every fetched row is MERGED, so the state distribution is a single
// bucket sized by the merged count — not the (possibly capped) row array —
// keeping it consistent with the "Merged PRs" KPI at any org size. ISS-5411:
// that count is now the distinct-pull-request one, so the bucket and the KPI
// still agree.
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

// Spend ($) and token (#) time-series for the Model Usage chart's $/# toggle
// (FEA-3497). Both are built over the SAME top-N model keys (top-N by spend, from
// `breakdown`) so toggling the metric only swaps y-values — the legend, colors,
// and stacking order stay stable.
function modelUsageSeries(
  rows: ModelUsageDayRow[],
  breakdown: CategoryBucket[],
  start: Date,
  end: Date,
  timeZone?: string
): { spend: TimeSeries; tokens: TimeSeries } {
  const topModels = breakdown
    .slice(0, MAX_MODEL_SERIES)
    .map((bucket) => bucket.key);
  return {
    // FEA-2331: estimated spend (USD), rounded to whole cents once at emit.
    spend: stackModelSeries(rows, topModels, start, end, timeZone, {
      valueOf: (row) => row.cost,
      round: (value) => round(value, 2),
    }),
    // FEA-3497: total token volume (input + output + cache), whole integers.
    tokens: stackModelSeries(rows, topModels, start, end, timeZone, {
      valueOf: (row) => row.tokens,
      round: Math.round,
    }),
  };
}

// Stack per-(day, model) rows into a `TimeSeries` over a fixed top-N model set,
// collapsing models outside the top-N into "other". Shared by the spend and
// token series so both agree on which models appear (FEA-3497).
function stackModelSeries(
  rows: ModelUsageDayRow[],
  topModels: string[],
  start: Date,
  end: Date,
  timeZone: string | undefined,
  metric: {
    valueOf: (row: ModelUsageDayRow) => number;
    round: (value: number) => number;
  }
): TimeSeries {
  const topSet = new Set(topModels);
  const seriesKey = (model: string) => (topSet.has(model) ? model : "other");

  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = byDay.get(row.day) ?? {};
    const sKey = seriesKey(row.model);
    // Rows already carry the per-(day, model) DB sum; models outside the top-N
    // collapse into "other" and round once at emit (below) to avoid drift.
    day[sKey] = (day[sKey] ?? 0) + metric.valueOf(row);
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

  const points = eachDayKey(start, end, timeZone).map((date) => {
    const raw = byDay.get(date) ?? {};
    const rounded: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      rounded[key] = metric.round(value);
    }
    return { date, values: rounded };
  });
  return { series, points };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
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
