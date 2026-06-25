import {
  type AgentsInsightsResponse,
  type CategoryBucket,
  type DeliveryInsightsResponse,
  type DonutSlice,
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
  InsightsScope,
  KpiFormat,
  type KpiStat,
  type ReviewerRow,
  type TimeSeries,
  type TimeSeriesSeries,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  ChecksStatus,
  GitHubPRState,
  type Prisma,
  ReviewDecision,
  withDb,
} from "@repo/database";
import { isRecord } from "@/lib/type-guards";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const TREND_LOOKBACK_DAYS = 90;
const MAX_MODEL_SERIES = 6;
const HUNDRED = 100;
const LABEL_SEPARATOR_PATTERN = /[-_:]/;

// Aggregation context resolved from the authenticated user + requested scope.
export type InsightsScopeContext = {
  organizationId: string;
  userId: string;
  scope: InsightsScope;
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

type ArtifactScopeWhere = { organizationId: string; createdById?: string };

type MergedPrRow = {
  mergedAt: Date | null;
  prState: GitHubPRState;
  repositoryId: string;
  branchArtifactId: string;
  repository: { name: string };
  branchArtifact: { createdAt: Date };
};

type ReviewRow = {
  authorLogin: string;
  state: ReviewDecision;
  submittedAt: Date;
  pullRequestDetail: { branchArtifact: { createdAt: Date } };
};

type SessionRow = {
  sessionStartedAt: Date;
  sessionEndedAt: Date | null;
  // Status is hoisted to the parent artifact (FEA-1699); owner is nullable since
  // a session survives its owner's deletion.
  artifact: { status: string };
  userId: string | null;
  user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
  agents: Prisma.JsonValue;
};

type TokenUsageRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  session: { sessionStartedAt: Date };
};

type ToolRunRow = {
  sessionStartedAt: Date;
  toolUseCount: number;
};

type AgentEventRow = {
  eventType: string;
  toolName: string | null;
  eventCreatedAt: Date;
};

async function getDelivery(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<DeliveryInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const [merged, priorMergedCount, openedCount, cost, priorCost] =
    await Promise.all([
      fetchMergedPrs(ctx, range.start, range.end),
      countMergedPrs(ctx, range.priorStart, range.start),
      countOpenedPrs(ctx, range.start, range.end),
      sumSessionCost(ctx, range.start, range.end),
      sumSessionCost(ctx, range.priorStart, range.start),
    ]);

  const ttms = merged
    .filter((pr) => pr.mergedAt)
    .map(
      (pr) =>
        (pr.mergedAt as Date).getTime() - pr.branchArtifact.createdAt.getTime()
    )
    .filter((ms) => ms >= 0);
  const [lineTotalsByBranch, branchesWithoutPr, checkStatus] =
    await Promise.all([
      fetchMergedLineTotalsByBranch(
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
  const totalLines = lines.reduce((sum, n) => sum + n, 0);

  const kpis: KpiStat[] = [
    kpi(
      "merged",
      "Merged PRs",
      merged.length,
      KpiFormat.Number,
      "PRs merged in range",
      pctDelta(merged.length, priorMergedCount)
    ),
    kpi(
      "ttm",
      "Median time to merge",
      median(ttms) ?? 0,
      KpiFormat.Duration,
      "first commit → merge",
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
      pctDelta(cost, priorCost)
    ),
    kpi(
      "merge-rate",
      "Merge rate",
      openedCount > 0 ? round((merged.length / openedCount) * HUNDRED, 0) : 0,
      KpiFormat.Percent,
      "of opened PRs",
      null
    ),
    kpi(
      "pr-size",
      "Median PR size",
      median(lines) ?? 0,
      KpiFormat.Number,
      "lines changed",
      null
    ),
  ];

  return {
    kpis,
    charts: {
      prTrend: bucketCountByDay(
        merged.filter((pr) => pr.mergedAt).map((pr) => pr.mergedAt as Date),
        range.trendStart,
        range.end,
        { key: "merged", label: "Merged PRs" }
      ),
      klocTrend: bucketKlocByDay(
        merged,
        lineTotalsByBranch,
        range.trendStart,
        range.end
      ),
      prByRepo: bucketByLabel(merged.map((pr) => pr.repository.name)),
      meanTimeToMerge: ttmHistogram(ttms),
      prByState: prStateBuckets(merged),
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
  const [sessions, priorSessionCount, events, reviewQueue, backlog, reviews] =
    await Promise.all([
      fetchSessions(ctx, range.start, range.end),
      countSessions(ctx, range.priorStart, range.start),
      fetchEvents(ctx, range.start, range.end),
      fetchReviewQueueBuckets(ctx),
      countReviewBacklog(ctx),
      isOrgScope(ctx) ? fetchReviews(ctx, range.start, range.end) : [],
    ]);

  const currentSessionCount = sessions.length;
  const runtimeMs = sessions.reduce(
    (sum, session) => sum + sessionRuntimeMs(session),
    0
  );

  const kpis: KpiStat[] = [
    kpi(
      "sessions",
      "Sessions",
      currentSessionCount,
      KpiFormat.Number,
      "agent sessions run",
      pctDelta(currentSessionCount, priorSessionCount)
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
      events.length,
      KpiFormat.Number,
      "captured events",
      null
    ),
  ];

  return {
    kpis,
    charts: {
      eventActivity: bucketCountByDay(
        sessions.map((s) => s.sessionStartedAt),
        range.trendStart,
        range.end,
        { key: "sessions", label: "Sessions" }
      ),
      eventVolume: bucketCountByDay(
        events.map((event) => event.eventCreatedAt),
        range.trendStart,
        range.end,
        { key: "events", label: "Events" }
      ),
      eventsByType: bucketByLabel(
        events.map((event) => labelize(event.eventType))
      ),
      sessionsByStatus: bucketByLabel(
        sessions.map((session) =>
          labelize(session.artifact.status || "unknown")
        )
      ),
      ...(isOrgScope(ctx)
        ? { userBreakdown: userBreakdownBuckets(sessions) }
        : {}),
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
  const [usage, sessions, events, toolRuns, priorToolRuns, toolRunRows] =
    await Promise.all([
      fetchTokenUsage(ctx, range.start, range.end),
      fetchSessions(ctx, range.start, range.end),
      fetchEvents(ctx, range.start, range.end),
      sumToolRuns(ctx, range.start, range.end),
      sumToolRuns(ctx, range.priorStart, range.start),
      fetchToolRunRows(ctx, range.trendStart, range.end),
    ]);

  const totalTokens = usage.reduce(
    (sum, u) => sum + u.inputTokens + u.outputTokens,
    0
  );
  const totalInputTokens = usage.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalOutputTokens = usage.reduce((sum, u) => sum + u.outputTokens, 0);
  const totalCacheTokens = usage.reduce(
    (sum, u) => sum + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
    0
  );
  const models = new Set(usage.map((u) => u.model));

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
      models.size,
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
      pctDelta(toolRuns, priorToolRuns)
    ),
  ];

  return {
    kpis,
    charts: {
      modelUsageOverTime: modelUsageSeries(usage, range.trendStart, range.end),
      modelBreakdown: modelBreakdownBuckets(usage),
      tokenDistribution: tokenDistributionBuckets(usage),
      toolUsage: bucketByLabel(
        events
          .map((event) => event.toolName)
          .filter((toolName): toolName is string => toolName !== null)
      ),
      agentsByStatus: agentJsonBuckets(sessions, "status"),
      agentsByType: agentJsonBuckets(sessions, "type"),
      toolRunsOverTime: bucketToolRunsByDay(
        toolRunRows,
        range.trendStart,
        range.end
      ),
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
  return ctx.scope === InsightsScope.Me
    ? { organizationId: ctx.organizationId, createdById: ctx.userId }
    : { organizationId: ctx.organizationId };
}

/** Session scope predicate (org-wide, or launched by the user). The org lives
 * on the parent artifact (FEA-1699); the launching user stays on the detail. */
function sessionScope(
  ctx: InsightsScopeContext
): Prisma.SessionDetailWhereInput {
  const artifact: Prisma.ArtifactWhereInput = {
    organizationId: ctx.organizationId,
  };
  return ctx.scope === InsightsScope.Me
    ? { artifact: { is: artifact }, userId: ctx.userId }
    : { artifact: { is: artifact } };
}

// ───────────────────────── queries ─────────────────────────

function fetchMergedPrs(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<MergedPrRow[]> {
  return withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        branchArtifact: artifactScope(ctx),
        mergedAt: { gte: start, lte: end },
      },
      select: {
        mergedAt: true,
        prState: true,
        repositoryId: true,
        branchArtifactId: true,
        repository: { select: { name: true } },
        branchArtifact: { select: { createdAt: true } },
      },
    })
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
        mergedAt: { gte: start, lt: end },
      },
    })
  );
}

function countOpenedPrs(
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
      },
    })
  );
}

async function fetchMergedLineTotalsByBranch(
  organizationId: string,
  branchArtifactIds: string[]
): Promise<Map<string, number>> {
  if (branchArtifactIds.length === 0) {
    return new Map();
  }
  const grouped = await withDb((db) =>
    db.branchFileChange.groupBy({
      by: ["branchArtifactId"],
      where: {
        branchArtifactId: { in: branchArtifactIds },
        branch: { artifact: { organizationId } },
      },
      _sum: { additions: true, deletions: true },
    })
  );
  return new Map(
    grouped.map((row) => [
      row.branchArtifactId,
      (row._sum.additions ?? 0) + (row._sum.deletions ?? 0),
    ])
  );
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

function fetchSessions(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<SessionRow[]> {
  return withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        ...sessionScope(ctx),
        sessionStartedAt: { gte: start, lte: end },
      },
      select: {
        sessionStartedAt: true,
        sessionEndedAt: true,
        artifact: { select: { status: true } },
        userId: true,
        user: { select: { firstName: true, lastName: true, email: true } },
        agents: true,
      },
    })
  );
}

function fetchEvents(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<AgentEventRow[]> {
  return withDb((db) =>
    db.agentSessionEvent.findMany({
      where: {
        eventCreatedAt: { gte: start, lte: end },
        session: sessionScope(ctx),
      },
      select: {
        eventType: true,
        toolName: true,
        eventCreatedAt: true,
      },
    })
  );
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

function fetchTokenUsage(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<TokenUsageRow[]> {
  return withDb((db) =>
    db.agentSessionTokenUsage.findMany({
      where: {
        session: {
          ...sessionScope(ctx),
          sessionStartedAt: { gte: start, lte: end },
        },
      },
      select: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        session: { select: { sessionStartedAt: true } },
      },
    })
  );
}

function fetchToolRunRows(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<ToolRunRow[]> {
  return withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        ...sessionScope(ctx),
        sessionStartedAt: { gte: start, lte: end },
      },
      select: {
        sessionStartedAt: true,
        toolUseCount: true,
      },
    })
  );
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

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) {
    return null;
  }
  return round(((current - prior) / prior) * HUNDRED, 0);
}

export function ttmHistogram(ttms: number[]): CategoryBucket[] {
  const buckets = [
    { key: "lt4h", label: "< 4h", max: 4 * MS_PER_HOUR, value: 0 },
    { key: "4to12h", label: "4–12h", max: 12 * MS_PER_HOUR, value: 0 },
    { key: "12to24h", label: "12–24h", max: MS_PER_DAY, value: 0 },
    { key: "1to3d", label: "1–3d", max: 3 * MS_PER_DAY, value: 0 },
    { key: "gt3d", label: "> 3d", max: Number.POSITIVE_INFINITY, value: 0 },
  ];
  for (const ms of ttms) {
    const bucket = buckets.find((b) => ms < b.max);
    if (bucket) {
      bucket.value += 1;
    }
  }
  return buckets.map(({ key, label, value }) => ({ key, label, value }));
}

export function lifespanHistogram(lifespans: number[]): CategoryBucket[] {
  const buckets = [
    { key: "short", label: "Short-lived (< 1d)", max: MS_PER_DAY, value: 0 },
    { key: "med", label: "Medium (1–7d)", max: 7 * MS_PER_DAY, value: 0 },
    {
      key: "long",
      label: "Long-lived (> 7d)",
      max: Number.POSITIVE_INFINITY,
      value: 0,
    },
  ];
  for (const ms of lifespans) {
    const bucket = buckets.find((b) => ms < b.max);
    if (bucket) {
      bucket.value += 1;
    }
  }
  return buckets.map(({ key, label, value }) => ({ key, label, value }));
}

export function bucketByLabel(labels: string[]): CategoryBucket[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ key: label, label, value }))
    .sort((a, b) => b.value - a.value);
}

export function bucketCountByDay(
  dates: Date[],
  start: Date,
  end: Date,
  series: TimeSeriesSeries
): TimeSeries {
  const counts = new Map<string, number>();
  for (const date of dates) {
    if (date >= start && date <= end) {
      const key = dayKey(date);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const points = eachDayKey(start, end).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

function bucketKlocByDay(
  merged: MergedPrRow[],
  lineTotalsByBranch: Map<string, number>,
  start: Date,
  end: Date
): TimeSeries {
  const counts = new Map<string, number>();
  for (const pr of merged) {
    if (!(pr.mergedAt && pr.mergedAt >= start && pr.mergedAt <= end)) {
      continue;
    }
    const key = dayKey(pr.mergedAt);
    const kloc = (lineTotalsByBranch.get(pr.branchArtifactId) ?? 0) / 1000;
    counts.set(key, (counts.get(key) ?? 0) + kloc);
  }
  const points = eachDayKey(start, end).map((date) => ({
    date,
    values: { kloc: round(counts.get(date) ?? 0, 1) },
  }));
  return { series: [{ key: "kloc", label: "KLOC merged" }], points };
}

function bucketToolRunsByDay(
  rows: ToolRunRow[],
  start: Date,
  end: Date
): TimeSeries {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.sessionStartedAt < start || row.sessionStartedAt > end) {
      continue;
    }
    const key = dayKey(row.sessionStartedAt);
    counts.set(key, (counts.get(key) ?? 0) + row.toolUseCount);
  }
  const points = eachDayKey(start, end).map((date) => ({
    date,
    values: { "tool-runs": counts.get(date) ?? 0 },
  }));
  return { series: [{ key: "tool-runs", label: "Tool runs" }], points };
}

function prStateBuckets(rows: MergedPrRow[]): CategoryBucket[] {
  const counts = new Map<GitHubPRState, number>();
  for (const row of rows) {
    counts.set(row.prState, (counts.get(row.prState) ?? 0) + 1);
  }
  return [...counts.entries()].map(([state, value]) => ({
    key: state,
    label: PR_STATE_LABELS[state],
    value,
  }));
}

function userBreakdownBuckets(sessions: SessionRow[]): CategoryBucket[] {
  const counts = new Map<string, { label: string; value: number }>();
  for (const session of sessions) {
    // Owner-less sessions (creator deleted) are excluded from the breakdown.
    if (!(session.userId && session.user)) {
      continue;
    }
    const existing = counts.get(session.userId);
    if (existing) {
      existing.value += 1;
    } else {
      counts.set(session.userId, {
        label: displayName(session.user),
        value: 1,
      });
    }
  }
  return [...counts.entries()]
    .map(([key, { label, value }]) => ({ key, label, value }))
    .sort((a, b) => b.value - a.value);
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

function modelBreakdownBuckets(usage: TokenUsageRow[]): CategoryBucket[] {
  const counts = new Map<string, number>();
  for (const row of usage) {
    counts.set(
      row.model,
      (counts.get(row.model) ?? 0) + row.inputTokens + row.outputTokens
    );
  }
  return [...counts.entries()]
    .map(([model, value]) => ({ key: model, label: model, value }))
    .sort((a, b) => b.value - a.value);
}

function tokenDistributionBuckets(usage: TokenUsageRow[]): CategoryBucket[] {
  const totals = usage.reduce(
    (acc, row) => ({
      input: acc.input + row.inputTokens,
      output: acc.output + row.outputTokens,
      cacheRead: acc.cacheRead + (row.cacheReadTokens ?? 0),
      cacheWrite: acc.cacheWrite + (row.cacheWriteTokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
  return [
    { key: "input", label: "Input", value: totals.input },
    { key: "output", label: "Output", value: totals.output },
    { key: "cache-read", label: "Cache read", value: totals.cacheRead },
    { key: "cache-write", label: "Cache write", value: totals.cacheWrite },
  ];
}

function agentJsonBuckets(
  sessions: SessionRow[],
  field: "status" | "type"
): CategoryBucket[] {
  const labels: string[] = [];
  for (const session of sessions) {
    if (!Array.isArray(session.agents)) {
      continue;
    }
    for (const agent of session.agents) {
      if (!isRecord(agent)) {
        continue;
      }
      const rawValue = agent[field];
      labels.push(
        labelize(
          typeof rawValue === "string" && rawValue.trim().length > 0
            ? rawValue
            : "unknown"
        )
      );
    }
  }
  return bucketByLabel(labels);
}

function modelUsageSeries(
  usage: TokenUsageRow[],
  start: Date,
  end: Date
): TimeSeries {
  const topModels = modelBreakdownBuckets(usage)
    .slice(0, MAX_MODEL_SERIES)
    .map((bucket) => bucket.key);
  const topSet = new Set(topModels);
  const seriesKey = (model: string) => (topSet.has(model) ? model : "other");

  const byDay = new Map<string, Record<string, number>>();
  for (const row of usage) {
    const date = row.session.sessionStartedAt;
    if (date < start || date > end) {
      continue;
    }
    const key = dayKey(date);
    const day = byDay.get(key) ?? {};
    const sKey = seriesKey(row.model);
    day[sKey] = (day[sKey] ?? 0) + row.inputTokens + row.outputTokens;
    byDay.set(key, day);
  }

  const usesOther = usage.some((row) => !topSet.has(row.model));
  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: "other", label: "Other" });
  }

  const points = eachDayKey(start, end).map((date) => ({
    date,
    values: byDay.get(date) ?? {},
  }));
  return { series, points };
}

function sessionRuntimeMs(session: SessionRow): number {
  if (!session.sessionEndedAt) {
    return 0;
  }
  const ms =
    session.sessionEndedAt.getTime() - session.sessionStartedAt.getTime();
  return ms > 0 ? ms : 0;
}

function labelize(value: string): string {
  return value
    .split(LABEL_SEPARATOR_PATTERN)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function kpi(
  key: string,
  label: string,
  value: number,
  format: KpiFormat,
  sub: string,
  deltaPct: number | null
): KpiStat {
  return { key, label, value, format, sub, deltaPct };
}

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}

function toNumber(value: Prisma.Decimal | null): number {
  return value ? Number(value) : 0;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eachDayKey(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  );
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  while (cursor.getTime() <= endDay) {
    keys.push(dayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

const CHECK_STATUS_LABELS: Record<ChecksStatus, string> = {
  [ChecksStatus.PASSING]: "Passing",
  [ChecksStatus.FAILING]: "Failing",
  [ChecksStatus.PENDING]: "Running",
  [ChecksStatus.UNKNOWN]: "Unknown",
};

const PR_STATE_LABELS: Record<GitHubPRState, string> = {
  [GitHubPRState.OPEN]: "Open",
  [GitHubPRState.MERGED]: "Merged",
  [GitHubPRState.CLOSED]: "Closed",
};

const REVIEW_QUEUE_LABELS: Record<ReviewDecision | "PENDING", string> = {
  PENDING: "Awaiting review",
  [ReviewDecision.APPROVED]: "Approved, not merged",
  [ReviewDecision.CHANGES_REQUESTED]: "Changes requested",
  [ReviewDecision.COMMENTED]: "Commented",
  [ReviewDecision.DISMISSED]: "Dismissed",
};
