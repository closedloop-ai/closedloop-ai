import {
  COST_KPI_SUB,
  comparableKpi,
  kpi,
  lifespanHistogram,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { ssotMergeRateFromCounts } from "@repo/api/src/insights/delivery-kpis/parity";
import {
  type AgentsInsightsResponse,
  type DeliveryInsightsResponse,
  type InsightsPeriod,
  KpiFormat,
  type KpiStat,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { median } from "@repo/api/src/utils/math";
import { fetchAgentPipelineGraph } from "@/app/insights/agent-pipeline";
import { fetchAgentsSpendBreakdowns } from "@/app/insights/agents-spend";
import {
  fetchBranchesWithoutPrBuckets,
  fetchCheckStatusBuckets,
  readDashboardBranchPopulationIds,
} from "@/app/insights/insights-branch-population";
import { fetchActivityHeatmap } from "@/app/insights/lib/activity-heatmap";
import { fetchReviewQueue } from "@/app/insights/review-backlog";
import {
  cacheTokens,
  countedTokens,
  tokenDistributionBuckets,
} from "@/app/insights/token-derivations";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";
import { isUnmeasuredDeliveryPopulationEnabled } from "@/lib/unmeasured-delivery-population-feature";
import {
  isMergedPrPopulationUnmeasured,
  withUnmeasuredMergedPrKpis,
} from "./delivery-measurement";
import { readDeliveryPullRequestFacts } from "./delivery-pull-request-facts";
import {
  dedupeMergedPrsWithEarliestCreation,
  mergedLocKpis,
  mergedPrLocTotals,
} from "./merged-pr-loc";
import {
  censusMergedPrVerification,
  fetchMergedPrs,
} from "./merged-pr-queries";
import {
  bucketByLabelCounts,
  bucketCountByDay,
  bucketKlocByDay,
  bucketLocByDay,
  buildPrByRepoBuckets,
  mergedStateBuckets,
} from "./service/buckets";
import {
  fetchReviewerLoad,
  resolveGitHubProvenance,
} from "./service/delivery-queries";
import {
  countEvents,
  fetchEventTypeBuckets,
  fetchEventVolume,
  fetchToolUsageBuckets,
} from "./service/event-queries";
import { fetchFrustrationTrendSafe } from "./service/frustration-queries";
import { modelUsageSeries } from "./service/model-series";
import {
  earliestRecord,
  reportDeltaFor,
  resolvePeriodRange,
} from "./service/period";
import {
  artifactScope,
  type InsightsScopeContext,
  isOrgScope,
  sessionScopeSql,
} from "./service/scope";
import {
  countSessions,
  fetchAgentBuckets,
  fetchSessionActivity,
  fetchSessionRollup,
  fetchToolRunsByDay,
  fetchUserBreakdown,
  sumSessionCost,
  sumToolRuns,
} from "./service/session-queries";
import {
  buildDeliveryTileAvailability,
  buildUtilizationTileAvailability,
} from "./service/tiles";
import { fetchModelUsageRows, fetchTokenTotals } from "./service/token-queries";
import { scheduleUnmeasuredDeliveryResync } from "./unmeasured-delivery-resync";

async function getDelivery(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<DeliveryInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const priorCostPromise =
    range.priorStart === null
      ? Promise.resolve(0)
      : sumSessionCost(ctx, { start: range.priorStart, end: range.priorEnd });
  const [
    merged,
    pullRequestFacts,
    cost,
    priorCost,
    earliest,
    githubProvenance,
    verificationCensus,
  ] = await Promise.all([
    fetchMergedPrs(ctx, range.start, range.end),
    // ISS-12408: Merged PRs, its prior window, the closed-unmerged count and the
    // median are one fold over the population the Branches card counts.
    readDeliveryPullRequestFacts(ctx, range),
    sumSessionCost(ctx, range.sessionsWindow),
    priorCostPromise,
    earliestRecord(ctx),
    resolveGitHubProvenance(ctx),
    // ISS-8424 population probe. Scoped like the row scan — a session Wrote to
    // the branch, windowed `merged_at <= end` — so since ISS-12408 it is a
    // SUPERSET of the fold the merged tiles render (eligibility adds verified
    // publication and authority on top of Wrote). Fail-safe in that direction
    // only: an unverified wider set blanks the narrower set inside it, never the
    // reverse.
    censusMergedPrVerification(ctx, range.start, range.end),
  ]);
  const {
    merged: mergedCount,
    closedUnmerged: closedCount,
    priorMerged: priorMergedCount,
  } = pullRequestFacts;
  const reportDelta = reportDeltaFor(range, earliest);

  // PLN-1535 M4 / D1 + ISS-5411: one pull request can be projected by two rows
  // (see `merged-pr-loc.ts` for why that pair exists and why no unique
  // constraint forbids it), so the facets taken from this scan — the repo split,
  // the daily trends, the KLOC/LOC sums, the size-coverage pair and the
  // TTM/lifespan intervals — count pull requests rather than rows.
  //
  // ISS-12408 moved the headline count, its delta, the state split, the closed
  // count and the median onto `pullRequestFacts`, so deduping here no longer
  // makes the whole response reconcile with itself. The scan admits
  // Product-ineligible branches and windows on `merged_at <= end` where the fold
  // uses `< end`, so the trend and the repo split can exceed the headline.
  // ISS-12485 owns that gap.
  const dedupedMerged = dedupeMergedPrsWithEarliestCreation(merged);

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
  // ISS-8424 read-side gate. Fail-closed: an unavailable flag keeps the
  // pre-ISS-8424 render rather than blanking a live dashboard.
  const flagIdentity = { userId: ctx.userId, clerkUserId: ctx.clerkUserId };
  const honestUnmeasuredPopulation =
    await isUnmeasuredDeliveryPopulationEnabled(flagIdentity);
  // ISS-8424: the resync is fired on the STATE, not on the flag — an org whose
  // population has never been verified needs the verification written whether
  // or not it is yet being told the truth about it. Bounded to one pass per org
  // per hour by its own run gate.
  const populationUnmeasured =
    isMergedPrPopulationUnmeasured(verificationCensus);
  if (populationUnmeasured) {
    scheduleUnmeasuredDeliveryResync(ctx.organizationId);
  }
  const renderUnmeasured = populationUnmeasured && honestUnmeasuredPopulation;
  // ISS-11915: both branch-population charts count the Branches list's own
  // population for this period, read once (insights-branch-population.ts).
  const branchPopulationIds = await readDashboardBranchPopulationIds(
    ctx.organizationId,
    { period, now }
  );
  const [branchesWithoutPr, checkStatus] = await Promise.all([
    fetchBranchesWithoutPrBuckets(branchPopulationIds, artifactScope(ctx)),
    isOrgScope(ctx)
      ? fetchCheckStatusBuckets(ctx.organizationId, branchPopulationIds)
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
  const {
    kloc,
    loc,
    mergedKloc,
    mergedLoc,
    prsWithoutLoc,
    prsScanned,
    prSize,
  } = mergedLocKpis(mergedPrLocTotals(dedupedMerged), pullRequestFacts);

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
    loc,
    mergedKloc,
    mergedLoc,
    prsWithoutLoc,
    prsScanned,
    // ISS-4994: caption owned by `COST_KPI_SUB`, which documents why this figure
    // is named for its basis rather than called "spend".
    //
    // whitlockk review: the raw aggregate is sent, NOT `round(cost, 2)`. Rounding to
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
    kpis: renderUnmeasured ? withUnmeasuredMergedPrKpis(kpis) : kpis,
    tileAvailability: buildDeliveryTileAvailability({
      mergedPrPopulationMeasured: !renderUnmeasured,
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
        range.elapsedEnd,
        { key: "merged", label: "Merged PRs" },
        ctx.timeZone
      ),
      klocTrend: bucketKlocByDay(
        dedupedMerged,
        range.trendStart,
        range.elapsedEnd,
        ctx.timeZone
      ),
      locTrend: bucketLocByDay(
        dedupedMerged,
        range.trendStart,
        range.elapsedEnd,
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
    // than materialized and reduced in JS — for the "all" period the Sessions
    // window has no bounds (ISS-12263), so the row set is unbounded.
    fetchSessionRollup(ctx, range.sessionsWindow),
    countSessions(ctx, range.priorStart, range.priorEnd),
    // agentSessionEvent is the highest-volume table, so the event count, daily
    // volume and by-type breakdown are aggregated in the DB rather than by
    // materializing every row and reducing in JS (matches the desktop path).
    countEvents(ctx, range.start, range.end),
    fetchEventVolume(ctx, range.trendStart, range.elapsedEnd, ctx.timeZone),
    fetchEventTypeBuckets(ctx, range.start, range.end),
    // The review-queue chart and the review-backlog KPI both read the non-merged
    // PR-by-decision population, so one snapshot feeds both (no read-to-read skew;
    // see fetchReviewQueue).
    fetchReviewQueue(ctx),
    isOrgScope(ctx) ? fetchReviewerLoad(ctx, range.start, range.end) : [],
    isOrgScope(ctx) ? fetchUserBreakdown(ctx, range.start, range.end) : [],
    // Daily session-activity volume, date-bucketed in Postgres (mirrors
    // fetchEventVolume) so only one already-bucketed row per day crosses the
    // wire instead of every SessionDetail.
    fetchSessionActivity(ctx, range.trendStart, range.elapsedEnd),
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
      range.elapsedEnd
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
    // (whitlockk, #4282). Fusing also keeps the outcome split off the critical path
    // as an independent failure mode — it rides a scan this section already ran.
    fetchAgentsSpendBreakdowns(sessionScopeSql(ctx), range.start, range.end),
    fetchModelUsageRows(ctx, range.trendStart, range.elapsedEnd, ctx.timeZone),
    // Agent status/type buckets are unnested and grouped in the DB (FEA-2955)
    // rather than materializing every session row and reducing the JSON in JS.
    fetchAgentBuckets(ctx, range.start, range.end),
    // Tool buckets are counted in the DB (grouped by toolName) rather than
    // materializing every agentSessionEvent row and reducing in JS.
    fetchToolUsageBuckets(ctx, range.start, range.end),
    sumToolRuns(ctx, range.start, range.end),
    sumToolRuns(ctx, range.priorStart, range.priorEnd),
    // Daily tool-run totals are SUM'd per day in the DB (FEA-2956) rather than
    // materializing every session row and reducing in JS.
    fetchToolRunsByDay(ctx, range.trendStart, range.elapsedEnd),
    // Aggregate agent-pipeline graph (FEA-3537): nodes by agent/subagent type,
    // edges by parent→child hand-off, rolled up in the DB like the other charts.
    fetchAgentPipelineGraph(sessionScopeSql(ctx), range.start, range.end),
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
    ? await fetchFrustrationTrendSafe(ctx, range.trendStart, range.elapsedEnd)
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
    range.elapsedEnd,
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
