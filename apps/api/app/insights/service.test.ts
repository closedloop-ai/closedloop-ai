/**
 * Unit tests for insightsService and its pure aggregation helpers.
 *
 * The DB is mocked: withDb runs the callback against a fake Prisma client whose
 * methods return fixtures and record every `where` clause, so we can assert
 * both the computed KPI/chart math and that every query is organization-scoped
 * (cross-org isolation).
 */
import {
  InsightsPeriod,
  InsightsScope,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ChecksStatus: {
    UNKNOWN: "UNKNOWN",
    PENDING: "PENDING",
    PASSING: "PASSING",
    FAILING: "FAILING",
  },
  GitHubPRState: { OPEN: "OPEN", MERGED: "MERGED", CLOSED: "CLOSED" },
  ReviewDecision: {
    APPROVED: "APPROVED",
    CHANGES_REQUESTED: "CHANGES_REQUESTED",
    COMMENTED: "COMMENTED",
    DISMISSED: "DISMISSED",
  },
  Prisma: {},
}));

import { withDb } from "@repo/database";
import {
  bucketByLabel,
  bucketCountByDay,
  insightsService,
  lifespanHistogram,
  median,
  pctDelta,
  resolvePeriodRange,
  ttmHistogram,
} from "./service";

const ORG = "org-1";
const USER = "user-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const ME_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Me };
const NOW = new Date("2026-06-09T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

type WhereRecord = unknown[];

function collectKey(value: unknown, target: string, found: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === target && typeof nested === "string") {
      found.push(nested);
    } else {
      collectKey(nested, target, found);
    }
  }
}

function findOrgIds(value: unknown, found: string[]): void {
  collectKey(value, "organizationId", found);
}

/**
 * Build a fake Prisma client that returns fixtures and records every where
 * clause it is handed. Counts/aggregates branch on the where shape so the many
 * call sites resolve deterministically.
 */
function makeFakeDb(fixtures: {
  mergedPrs?: unknown[];
  lineGroups?: unknown[];
  checkStatusGroups?: unknown[];
  reviewQueueGroups?: unknown[];
  sessions?: unknown[];
  events?: unknown[];
  toolRunRows?: unknown[];
  reviews?: unknown[];
  tokenUsage?: unknown[];
  counts?: (where: Record<string, unknown>) => number;
  costSum?: number;
  toolUseSum?: number;
}) {
  const wheres: WhereRecord = [];
  const record = <T>(args: { where?: unknown } | undefined, value: T): T => {
    if (args?.where) {
      wheres.push(args.where);
    }
    return value;
  };
  const count = (args: { where: Record<string, unknown> }) => {
    wheres.push(args.where);
    return Promise.resolve(fixtures.counts?.(args.where) ?? 0);
  };
  const db = {
    pullRequestDetail: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.mergedPrs ?? [])),
      count,
      groupBy: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.reviewQueueGroups ?? [])),
    },
    sessionDetail: {
      findMany: (a: { select?: Record<string, unknown>; where?: unknown }) =>
        Promise.resolve(
          record(
            a,
            a.select?.toolUseCount
              ? (fixtures.toolRunRows ?? [])
              : (fixtures.sessions ?? [])
          )
        ),
      count,
      aggregate: (a: { where?: unknown; _sum: Record<string, boolean> }) => {
        wheres.push(a.where);
        if (a._sum.estimatedCost) {
          return Promise.resolve({
            _sum: { estimatedCost: fixtures.costSum ?? 0 },
          });
        }
        return Promise.resolve({
          _sum: { toolUseCount: fixtures.toolUseSum ?? 0 },
        });
      },
    },
    branchFileChange: {
      groupBy: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.lineGroups ?? [])),
    },
    branchDetail: {
      groupBy: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.checkStatusGroups ?? [])),
      count,
    },
    gitHubPRReview: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.reviews ?? [])),
    },
    agentSessionTokenUsage: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.tokenUsage ?? [])),
    },
    agentSessionEvent: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.events ?? [])),
    },
  };
  return { db, wheres };
}

// biome-ignore-start lint/suspicious/noMisplacedAssertion: shared org-scoping assertion helper invoked from each section test
function expectAllOrgScoped(wheres: WhereRecord): void {
  expect(wheres.length).toBeGreaterThan(0);
  for (const where of wheres) {
    const found: string[] = [];
    findOrgIds(where, found);
    expect(found).toContain(ORG);
  }
}
// biome-ignore-end lint/suspicious/noMisplacedAssertion: shared org-scoping assertion helper invoked from each section test

beforeEach(() => {
  vi.mocked(withDb).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("insightsService.getDelivery", () => {
  it("computes delivery KPIs and charts from org-scoped data", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db, wheres } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: "MERGED",
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: "MERGED",
          repositoryId: "r2",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - 5 * DAY) },
        },
      ],
      lineGroups: [
        { branchArtifactId: "b1", _sum: { additions: 100, deletions: 50 } },
        { branchArtifactId: "b2", _sum: { additions: 200, deletions: 50 } },
      ],
      checkStatusGroups: [
        { checksStatus: "PASSING", _count: { _all: 9 } },
        { checksStatus: "FAILING", _count: { _all: 1 } },
      ],
      costSum: 412.5,
      counts: (where) => {
        const branchArtifact = where.branchArtifact as
          | Record<string, unknown>
          | undefined;
        if (branchArtifact && "createdAt" in branchArtifact) {
          return 4; // opened in range
        }
        if (where.currentPullRequestDetailId === null) {
          return 3; // branches without PR
        }
        if (
          (where.currentPullRequestDetailId as { not?: unknown })?.not !==
          undefined
        ) {
          return 7; // branches with PR
        }
        return 1; // prior merged
      },
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expectAllOrgScoped(wheres);

    const merged = result.kpis.find((k) => k.key === "merged");
    expect(merged?.value).toBe(2);
    expect(merged?.deltaPct).toBe(100); // 2 vs prior 1

    const cost = result.kpis.find((k) => k.key === "cost");
    expect(cost?.value).toBe(412.5);
    expect(cost?.format).toBe(KpiFormat.Currency);

    const kloc = result.kpis.find((k) => k.key === "kloc");
    expect(kloc?.value).toBe(0.4); // (150 + 250) / 1000

    const ttm = result.kpis.find((k) => k.key === "ttm");
    expect(ttm?.format).toBe(KpiFormat.Duration);

    const mergeRate = result.kpis.find((k) => k.key === "merge-rate");
    expect(mergeRate?.value).toBe(50); // 2 merged / 4 opened

    expect(result.charts.checkStatus).toEqual([
      { key: "PASSING", label: "Passing", value: 9 },
      { key: "FAILING", label: "Failing", value: 1 },
    ]);
    expect(result.charts.branchesWithoutPr).toEqual([
      { key: "has-pr", label: "Has a pull request", value: 7 },
      { key: "no-pr", label: "No pull request", value: 3 },
    ]);
    expect(result.charts.prByRepo[0].value).toBe(1);
    expect(result.charts.prTrend.points.at(-1)?.values.merged).toBeDefined();
    expect(
      result.charts.klocTrend?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values.kloc
    ).toBe(0.4);
  });
});

describe("insightsService.getUtilization", () => {
  it("computes sessions, runtime and reviewer load", async () => {
    const start = new Date("2026-06-08T09:00:00.000Z");
    const { db, wheres } = makeFakeDb({
      sessions: [
        {
          sessionStartedAt: start,
          sessionEndedAt: new Date(start.getTime() + 2 * HOUR),
          userId: "u1",
          user: { firstName: "Ada", lastName: "Lovelace", email: "ada@x.io" },
          artifact: { status: "completed" },
        },
        {
          sessionStartedAt: start,
          sessionEndedAt: null,
          userId: "u1",
          user: { firstName: "Ada", lastName: "Lovelace", email: "ada@x.io" },
          artifact: { status: "active" },
        },
      ],
      reviews: [
        {
          authorLogin: "claude",
          state: "APPROVED",
          submittedAt: new Date(start.getTime() + HOUR),
          pullRequestDetail: { branchArtifact: { createdAt: start } },
        },
      ],
      counts: () => 5,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getUtilization(
      ORG_CTX,
      InsightsPeriod.Month,
      NOW
    );

    expectAllOrgScoped(wheres);
    expect(result.kpis.find((k) => k.key === "sessions")?.value).toBe(2);
    expect(result.kpis.find((k) => k.key === "runtime")?.value).toBe(2 * HOUR);
    expect(result.charts.userBreakdown).toEqual([
      { key: "u1", label: "Ada Lovelace", value: 2 },
    ]);
    expect(result.charts.reviewerLoad).toEqual([
      { reviewer: "claude", reviewed: 1, approved: 1, medianWaitMs: HOUR },
    ]);
  });
});

describe("insightsService.getAgents", () => {
  it("computes tokens, distinct models and model breakdown", async () => {
    const sessionStartedAt = new Date("2026-06-08T00:00:00.000Z");
    const { db, wheres } = makeFakeDb({
      tokenUsage: [
        {
          model: "opus",
          inputTokens: 100,
          outputTokens: 50,
          session: { sessionStartedAt },
        },
        {
          model: "sonnet",
          inputTokens: 30,
          outputTokens: 20,
          session: { sessionStartedAt },
        },
      ],
      toolUseSum: 42,
      toolRunRows: [{ sessionStartedAt, toolUseCount: 42 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expectAllOrgScoped(wheres);
    expect(result.kpis.find((k) => k.key === "tokens")?.value).toBe(200);
    expect(result.kpis.find((k) => k.key === "models")?.value).toBe(2);
    expect(result.kpis.find((k) => k.key === "tool-runs")?.value).toBe(42);
    expect(result.charts.modelBreakdown).toEqual([
      { key: "opus", label: "opus", value: 150 },
      { key: "sonnet", label: "sonnet", value: 50 },
    ]);
    expect(
      result.charts.toolRunsOverTime?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values["tool-runs"]
    ).toBe(42);
  });
});

describe("me scope", () => {
  it("filters delivery by the current user and omits org-only tiles", async () => {
    const { db, wheres } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ME_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Every artifact-scoped where pins createdById to the user.
    const createdByIds: string[] = [];
    for (const where of wheres) {
      collectKey(where, "createdById", createdByIds);
    }
    expect(createdByIds.every((id) => id === USER)).toBe(true);
    expect(createdByIds.length).toBeGreaterThan(0);

    // checkStatus is org-only and must be absent under me scope.
    expect(result.charts.checkStatus).toBeUndefined();
  });

  it("filters sessions by user and omits reviewer/user breakdown tiles", async () => {
    const { db, wheres } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getUtilization(
      ME_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const userIds: string[] = [];
    for (const where of wheres) {
      collectKey(where, "userId", userIds);
    }
    expect(userIds.every((id) => id === USER)).toBe(true);
    expect(result.charts.userBreakdown).toBeUndefined();
    expect(result.charts.reviewerLoad).toBeUndefined();
  });
});

describe("pure helpers", () => {
  it("resolvePeriodRange derives prior + trend windows", () => {
    const range = resolvePeriodRange(InsightsPeriod.Quarter, NOW);
    expect(range.end).toBe(NOW);
    expect(range.start).toEqual(new Date(NOW.getTime() - 90 * DAY));
    expect(range.priorStart).toEqual(new Date(NOW.getTime() - 180 * DAY));
    expect(range.trendStart).toEqual(range.start);
  });

  it("resolvePeriodRange has no prior window for all-time", () => {
    const range = resolvePeriodRange(InsightsPeriod.All, NOW);
    expect(range.priorStart).toBeNull();
    expect(range.start).toEqual(new Date(0));
    expect(range.trendStart).toEqual(new Date(NOW.getTime() - 90 * DAY));
  });

  it("median handles even and odd counts and empty input", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
  });

  it("pctDelta returns null when prior is zero", () => {
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(12, 10)).toBe(20);
    expect(pctDelta(8, 10)).toBe(-20);
  });

  it("ttmHistogram buckets durations", () => {
    const result = ttmHistogram([HOUR, 6 * HOUR, 2 * DAY, 10 * DAY]);
    expect(result.find((b) => b.key === "lt4h")?.value).toBe(1);
    expect(result.find((b) => b.key === "4to12h")?.value).toBe(1);
    expect(result.find((b) => b.key === "1to3d")?.value).toBe(1);
    expect(result.find((b) => b.key === "gt3d")?.value).toBe(1);
  });

  it("lifespanHistogram buckets durations", () => {
    const result = lifespanHistogram([HOUR, 3 * DAY, 30 * DAY]);
    expect(result.find((b) => b.key === "short")?.value).toBe(1);
    expect(result.find((b) => b.key === "med")?.value).toBe(1);
    expect(result.find((b) => b.key === "long")?.value).toBe(1);
  });

  it("bucketByLabel counts and sorts descending", () => {
    expect(bucketByLabel(["a", "b", "a"])).toEqual([
      { key: "a", label: "a", value: 2 },
      { key: "b", label: "b", value: 1 },
    ]);
  });

  it("bucketCountByDay fills gaps and counts in-window dates", () => {
    const start = new Date("2026-06-07T00:00:00.000Z");
    const end = new Date("2026-06-09T00:00:00.000Z");
    const series = bucketCountByDay(
      [
        new Date("2026-06-08T05:00:00.000Z"),
        new Date("2026-06-08T20:00:00.000Z"),
      ],
      start,
      end,
      { key: "merged", label: "Merged" }
    );
    expect(series.points).toHaveLength(3);
    expect(series.points[1]).toEqual({
      date: "2026-06-08",
      values: { merged: 2 },
    });
    expect(series.points[0].values.merged).toBe(0);
  });
});
