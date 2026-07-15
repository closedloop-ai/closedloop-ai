/**
 * Unit tests for insightsService and its pure aggregation helpers.
 *
 * The DB is mocked: withDb runs the callback against a fake Prisma client whose
 * methods return fixtures and record every `where` clause, so we can assert
 * both the computed KPI/chart math and that every query is organization-scoped
 * (cross-org isolation).
 */

import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import {
  InsightsGitHubProvenanceState,
  InsightsPeriod,
  InsightsScope,
  InsightsTileAvailabilityState,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { median } from "@repo/api/src/utils/math";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const githubTypes = await import("@repo/api/src/types/github");
  return {
    withDb: vi.fn(),
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
    GitHubPRState: {
      CLOSED: githubTypes.GitHubPRState.Closed,
      MERGED: githubTypes.GitHubPRState.Merged,
      OPEN: githubTypes.GitHubPRState.Open,
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
      PENDING_CLAIM: "PENDING_CLAIM",
      SUSPENDED: "SUSPENDED",
      UNINSTALLED: "UNINSTALLED",
    },
    ReviewDecision: {
      APPROVED: "APPROVED",
      CHANGES_REQUESTED: "CHANGES_REQUESTED",
      COMMENTED: "COMMENTED",
      DISMISSED: "DISMISSED",
    },
    Prisma: {
      // Minimal tagged-template stand-in for Prisma.sql so the raw
      // event-volume query builds without a live client.
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings: Array.from(strings),
        values,
      }),
    },
  };
});

import { withDb } from "@repo/database";
import {
  bucketCountByDay,
  buildPrByRepoBuckets,
  insightsService,
  MERGED_PR_SCAN_CAP,
  minDate,
  reportDeltaFor,
  resolvePeriodRange,
} from "./service";

const ORG = "org-1";
const USER = "user-1";
const TEAM = "team-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const ME_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Me };
const TEAM_CTX = {
  organizationId: ORG,
  userId: USER,
  scope: InsightsScope.Team,
  teamId: TEAM,
};
const TEAM_CTX_WITHOUT_ID = {
  organizationId: ORG,
  userId: USER,
  scope: InsightsScope.Team,
};
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

function hasEmptyInPredicate(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (
    "in" in value &&
    Array.isArray((value as { in?: unknown }).in) &&
    (value as { in: unknown[] }).in.length === 0
  ) {
    return true;
  }
  return Object.values(value).some((nested) => hasEmptyInPredicate(nested));
}

// FEA-2876: a token-usage fixture row. Its token/cost columns feed the fake DB's
// aggregate({_sum}) and groupBy({_sum}) so one fixture drives the KPI totals, the
// token-distribution donut, and the spend-by-model breakdown.
type TokenUsageFixture = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
};

function sumBy<T>(rows: T[], pick: (row: T) => number | undefined): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

/**
 * Build a fake Prisma client that returns fixtures and records every where
 * clause it is handed. Counts/aggregates branch on the where shape so the many
 * call sites resolve deterministically.
 */
function makeFakeDb(fixtures: {
  mergedPrs?: unknown[];
  lineGroups?: unknown[];
  // FEA-2988: merged branches whose file cache is Fresh (enriched). The PR-size
  // median is taken over these branches only; a Fresh branch absent from
  // `lineGroups` (zero changed files) still counts as a known size of 0.
  enrichedBranches?: { artifactId: string }[];
  checkStatusGroups?: unknown[];
  reviewQueueGroups?: unknown[];
  sessions?: unknown[];
  eventTypeGroups?: unknown[];
  toolUsageGroups?: unknown[];
  eventVolumeRows?: unknown[];
  // FEA-2877: the utilization path rolls sessions up in the DB. Each raw query
  // is routed to its own fixture by inspecting the emitted SQL text.
  sessionRollupRows?: unknown[];
  userBreakdownRows?: unknown[];
  sessionActivityRows?: unknown[];
  // FEA-2955: the agent status/type charts unnest each session's `agents` JSON
  // array and group by the raw value in the DB. Each raw query is routed to its
  // fixture by the field it binds ("status" vs "type").
  agentStatusBuckets?: unknown[];
  agentTypeBuckets?: unknown[];
  // FEA-2877: simulate a Postgres tzdata that rejects the requester timezone —
  // the tz-aware session-activity query (AT TIME ZONE) throws so the service
  // must retry in UTC rather than 500 the endpoint.
  failTimeZoneActivity?: boolean;
  // FEA-2956: same tzdata-skew simulation for the daily tool-run series — the
  // tz-aware SUM(tool_use_count) query throws so the service must retry in UTC.
  failTimeZoneToolRuns?: boolean;
  // FEA-2956: pre-bucketed (day, n) tool-run totals the daily tool-run series
  // reads from $queryRaw, standing in for the DB SUM(tool_use_count) aggregation.
  toolRunsByDayRows?: unknown[];
  reviews?: unknown[];
  tokenUsage?: unknown[];
  // FEA-2876: pre-bucketed (day, model, cost) rows the token model-usage series
  // reads from $queryRaw, standing in for the DB date_trunc aggregation.
  modelUsageRows?: unknown[];
  counts?: (where: Record<string, unknown>) => number;
  costSum?: number;
  toolUseSum?: number;
  activeInstallation?: unknown | null;
  userGrant?: unknown | null;
  // FEA-2233: earliest relevant record returned by the `_min` aggregates that
  // power the "full prior period" rule. Defaults to the epoch so existing
  // delta-bearing tests assume a full prior period; pass a recent Date to
  // exercise the partial-prior case, or `null` for a no-history org.
  earliest?: Date | null;
}) {
  const earliest =
    fixtures.earliest === undefined ? new Date(0) : fixtures.earliest;
  const wheres: WhereRecord = [];
  // Every Prisma.sql fragment handed to $queryRaw, captured so tests can assert
  // the raw event-volume aggregation carries the org/team scope predicate. Each
  // entry is the tagged-template stand-in shape `{ strings, values }` produced
  // by the mocked Prisma.sql (nested fragments appear inside `values`).
  const rawQueries: unknown[] = [];
  // FEA-2878: every pullRequestDetail.findMany call (the merged-PR scan) so tests
  // can assert the scan is capped/ordered independently of the `where` records.
  const mergedFindArgs: Record<string, unknown>[] = [];
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
      findMany: (a: { where?: unknown }) => {
        mergedFindArgs.push(a as Record<string, unknown>);
        return Promise.resolve(record(a, fixtures.mergedPrs ?? []));
      },
      count,
      groupBy: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.reviewQueueGroups ?? [])),
      // FEA-2233: earliest merged PR for the full-prior-period rule.
      aggregate: (a: { where?: unknown }) => {
        wheres.push(a.where);
        return Promise.resolve({ _min: { mergedAt: earliest } });
      },
    },
    sessionDetail: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.sessions ?? [])),
      count,
      aggregate: (a: {
        where?: unknown;
        _sum?: Record<string, boolean>;
        _min?: Record<string, boolean>;
      }) => {
        wheres.push(a.where);
        // FEA-2233: earliest session start for the full-prior-period rule.
        if (a._min) {
          return Promise.resolve({ _min: { sessionStartedAt: earliest } });
        }
        if (a._sum?.estimatedCost) {
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
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.enrichedBranches ?? [])),
      count,
    },
    gitHubPRReview: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.reviews ?? [])),
    },
    agentSessionTokenUsage: {
      // Token analytics are DB-aggregated (FEA-2876): the KPI/token-distribution
      // totals come from aggregate({_sum}), the spend-by-model breakdown from
      // groupBy(['model'], {_sum}), and the per-day series from a $queryRaw. The
      // fake derives all three from the same `tokenUsage` fixture rows so a single
      // fixture drives the whole surface, mirroring the prior findMany reduction.
      aggregate: (a: { where?: unknown }) => {
        wheres.push(a.where);
        const rows = (fixtures.tokenUsage ?? []) as TokenUsageFixture[];
        return Promise.resolve({
          _sum: {
            inputTokens: sumBy(rows, (r) => r.inputTokens),
            outputTokens: sumBy(rows, (r) => r.outputTokens),
            cacheReadTokens: sumBy(rows, (r) => r.cacheReadTokens),
            cacheWriteTokens: sumBy(rows, (r) => r.cacheWriteTokens),
          },
        });
      },
      groupBy: (a: { where?: unknown }) => {
        wheres.push(a.where);
        const rows = (fixtures.tokenUsage ?? []) as TokenUsageFixture[];
        const spend = new Map<string, number>();
        for (const row of rows) {
          spend.set(
            row.model,
            (spend.get(row.model) ?? 0) + (row.estimatedCost ?? 0)
          );
        }
        return Promise.resolve(
          [...spend.entries()].map(([model, cost]) => ({
            model,
            _sum: { estimatedCost: cost },
          }))
        );
      },
    },
    agentSessionEvent: {
      count,
      groupBy: (a: { by?: string[]; where?: unknown }) =>
        Promise.resolve(
          record(
            a,
            a.by?.includes("toolName")
              ? (fixtures.toolUsageGroups ?? [])
              : (fixtures.eventTypeGroups ?? [])
          )
        ),
    },
    $queryRaw: (sql: unknown) => {
      rawQueries.push(sql);
      // Route each raw aggregation to its fixture by the SQL it emits:
      // - the session rollup (count + runtime + status) carries EXTRACT(EPOCH,
      // - the user breakdown joins users (u.email),
      // - the token model-usage series (FEA-2876) reads
      //   agent_session_token_usage,
      // - the event-volume query reads agent_session_events,
      // - the daily tool-run series (FEA-2956) SUMs tool_use_count per day,
      // - the remaining date_trunc query is the daily session-activity series.
      const { text, values } = flattenRawSql(sql);
      // FEA-2955: the two agent-bucket queries share SQL text and differ only in
      // the bound field, so route by which of "status"/"type" they bind.
      if (text.includes("jsonb_array_elements")) {
        return Promise.resolve(
          values.includes("type")
            ? (fixtures.agentTypeBuckets ?? [])
            : (fixtures.agentStatusBuckets ?? [])
        );
      }
      if (text.includes("EXTRACT(EPOCH")) {
        return Promise.resolve(fixtures.sessionRollupRows ?? []);
      }
      if (text.includes("u.email")) {
        return Promise.resolve(fixtures.userBreakdownRows ?? []);
      }
      if (text.includes("agent_session_token_usage")) {
        return Promise.resolve(fixtures.modelUsageRows ?? []);
      }
      if (text.includes("agent_session_events")) {
        return Promise.resolve(fixtures.eventVolumeRows ?? []);
      }
      if (text.includes("tool_use_count")) {
        if (fixtures.failTimeZoneToolRuns && text.includes("AT TIME ZONE")) {
          return Promise.reject(
            new Error('time zone "Mars/Olympus" not recognized')
          );
        }
        return Promise.resolve(fixtures.toolRunsByDayRows ?? []);
      }
      // Daily session-activity series. When the requester zone is unknown to
      // Postgres, the tz-aware variant (AT TIME ZONE) rejects and the service
      // retries the UTC variant.
      if (fixtures.failTimeZoneActivity && text.includes("AT TIME ZONE")) {
        return Promise.reject(
          new Error('time zone "Mars/Olympus" not recognized')
        );
      }
      return Promise.resolve(fixtures.sessionActivityRows ?? []);
    },
    gitHubInstallation: {
      findFirst: (a: { where?: unknown }) =>
        Promise.resolve(record(a, activeInstallationFixture(fixtures))),
    },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(fixtures.userGrant ?? null),
    },
  };
  return { db, wheres, rawQueries, mergedFindArgs };
}

/**
 * Flatten a mocked Prisma.sql fragment (`{ strings, values }`, possibly nested
 * via interpolated fragments) into its concatenated SQL text and the flat list
 * of bound scalar values, so tests can assert the raw event-volume query both
 * emits the org/team scope predicate SQL and binds the expected ids.
 */
function flattenRawSql(sql: unknown): { text: string; values: unknown[] } {
  if (!sql || typeof sql !== "object") {
    return { text: typeof sql === "string" ? sql : "", values: [] };
  }
  const fragment = sql as { strings?: unknown; values?: unknown };
  if (!(Array.isArray(fragment.strings) && Array.isArray(fragment.values))) {
    return { text: "", values: [] };
  }
  let text = "";
  const values: unknown[] = [];
  fragment.strings.forEach((chunk, index) => {
    text += String(chunk);
    if (index < (fragment.values as unknown[]).length) {
      const interpolated = (fragment.values as unknown[])[index];
      // A nested Prisma.sql fragment (e.g. the scope predicate) is spliced into
      // the SQL text; a plain scalar (org/user/team id) is a bound value.
      if (
        interpolated &&
        typeof interpolated === "object" &&
        "strings" in interpolated
      ) {
        const nested = flattenRawSql(interpolated);
        text += nested.text;
        values.push(...nested.values);
      } else {
        values.push(interpolated);
      }
    }
  });
  return { text, values };
}

/**
 * Pick the one captured raw query whose emitted SQL contains `needle`, flattened.
 * The utilization path now fires several sibling `$queryRaw` aggregations in a
 * single `Promise.all` (session rollup, user breakdown, event volume, session
 * activity — FEA-2877), so their order in `rawQueries` is not stable. Tests that
 * assert against a specific aggregation select it by an identifying SQL token
 * (e.g. the event-volume query's `agent_session_events`) rather than by index.
 */
function findRawSql(
  rawQueries: unknown[],
  needle: string
): { text: string; values: unknown[] } {
  const match = rawQueries
    .map((sql) => flattenRawSql(sql))
    .find((raw) => raw.text.includes(needle));
  if (!match) {
    throw new Error(`no raw query matched ${JSON.stringify(needle)}`);
  }
  return match;
}

function activeInstallationFixture(fixtures: {
  activeInstallation?: unknown | null;
}) {
  if (fixtures.activeInstallation !== undefined) {
    return fixtures.activeInstallation;
  }
  return { id: "gh-install-1" };
}

function makeInsightsUserGrant(
  overrides: Partial<{
    revokedAt: Date | null;
    tokenExpiresAt: Date | null;
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
  };
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
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
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
        // FEA-3208: countClosedPrs windows the closed-without-merge count on the
        // branch artifact's createdAt (null-safe, NOT closedAt). Route it FIRST —
        // its `where` also carries a `branchArtifact.createdAt`, so it must be
        // matched before the generic branchArtifact.createdAt cohort branch below.
        if (where.prState === ApiGitHubPRState.Closed) {
          return 1; // closed-without-merge count
        }
        if (branchArtifact && "createdAt" in branchArtifact) {
          // The merge-rate numerator further scopes the opened cohort to MERGED
          // PRs, so both surfaces divide over ONE set (2 merged of 4 opened).
          return where.prState === ApiGitHubPRState.Merged ? 2 : 4; // opened / opened+merged
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
        // FEA-2878: the in-range merged count (closed interval, mergedAt.lte)
        // powers the "Merged PRs" KPI + prByState; the prior window is half-open
        // (mergedAt.lt).
        const mergedAt = where.mergedAt as
          | { lte?: unknown; lt?: unknown }
          | undefined;
        if (
          where.prState === ApiGitHubPRState.Merged &&
          mergedAt?.lte !== undefined
        ) {
          return 2; // in-range merged
        }
        return 1; // prior merged count
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

    // FEA-2946: the dedicated "mergedCount" KPI (AI-Impact card's cost-per-merged-PR
    // denominator) carries the same merged count as the visible "merged" tile here.
    // The card reads THIS key so the desktop surface — whose "merged" KPI is
    // captured-count — divides by the same merged population.
    const mergedCount = result.kpis.find((k) => k.key === "mergedCount");
    expect(mergedCount?.value).toBe(2);

    const cost = result.kpis.find((k) => k.key === "cost");
    expect(cost?.value).toBe(412.5);
    expect(cost?.format).toBe(KpiFormat.Currency);

    const kloc = result.kpis.find((k) => k.key === "kloc");
    expect(kloc?.value).toBe(0.4); // (150 + 250) / 1000

    const ttm = result.kpis.find((k) => k.key === "ttm");
    expect(ttm?.format).toBe(KpiFormat.Duration);

    const mergeRate = result.kpis.find((k) => k.key === "merge-rate");
    // FEA-3151: merge rate now uses the SSOT DECIDED denominator
    // (merged / (merged + closed)), not the captured/opened cohort:
    // 2 merged / (2 merged + 1 closed) = 67%. Open PRs no longer drag it down.
    expect(mergeRate?.value).toBe(67);
    expect(result.tileAvailability).toMatchObject({
      "kpi:merge-rate": InsightsTileAvailabilityState.Available,
      "kpi:merged": InsightsTileAvailabilityState.Available,
      "kpi:ttm": InsightsTileAvailabilityState.Available,
      "chart:checkStatus": InsightsTileAvailabilityState.Available,
    });
    expect(result.tileAvailability?.["chart:prTrend"]).toBeUndefined();
    expect(result.githubProvenance?.state).toBe(
      InsightsGitHubProvenanceState.Active
    );

    expect(result.charts.checkStatus).toEqual([
      { key: "PASSING", label: "Passing", value: 9 },
      { key: "FAILING", label: "Failing", value: 1 },
    ]);
    expect(result.charts.branchesWithoutPr).toEqual([
      { key: "has-pr", label: "Has a pull request", value: 7 },
      { key: "no-pr", label: "No pull request", value: 3 },
    ]);
    expect(result.charts.prByRepo[0].value).toBe(1);
    // FEA-2878: prByState is sized by the exact in-range merged count (2), not
    // the materialized row array, so it stays consistent with the merged KPI.
    expect(result.charts.prByState).toEqual([
      { key: ApiGitHubPRState.Merged, label: "Merged", value: 2 },
    ]);
    expect(result.charts.prTrend.points.at(-1)?.values.merged).toBeDefined();
    expect(
      result.charts.klocTrend?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values.kloc
    ).toBe(0.4);
  });

  it("medians PR size over enriched PRs only while KLOC still sums un-enriched as 0 (FEA-2988)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r2",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          // Un-enriched: file cache not Fresh → absent from enrichedBranches.
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r3",
          branchArtifactId: "b3",
          repository: { name: "docs" },
          branchArtifact: { createdAt: openedAt },
        },
      ],
      lineGroups: [
        { branchArtifactId: "b1", _sum: { additions: 100, deletions: 0 } },
        { branchArtifactId: "b2", _sum: { additions: 300, deletions: 0 } },
      ],
      // b1/b2 enriched (Fresh); b3 not enriched.
      enrichedBranches: [{ artifactId: "b1" }, { artifactId: "b2" }],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Median over enriched PRs only: [100, 300] → 200. The old code folded the
    // un-enriched PR in as 0, medianing [0, 100, 300] → 100.
    const prSize = result.kpis.find((k) => k.key === "pr-size");
    expect(prSize?.value).toBe(200);

    // KLOC still sums over ALL merged PRs (un-enriched contributes 0): 400 / 1000.
    const kloc = result.kpis.find((k) => k.key === "kloc");
    expect(kloc?.value).toBe(0.4);
  });

  it("counts a Fresh zero-file PR as a known 0 in the PR-size median (FEA-2988)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          // Fresh but zero changed files → absent from lineGroups, present in
          // enrichedBranches. Its known size is 0 and must count toward median.
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r0",
          branchArtifactId: "b0",
          repository: { name: "docs" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r2",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: openedAt },
        },
      ],
      lineGroups: [
        { branchArtifactId: "b1", _sum: { additions: 100, deletions: 0 } },
        { branchArtifactId: "b2", _sum: { additions: 300, deletions: 0 } },
      ],
      // All three are Fresh (enriched), including the zero-file b0.
      enrichedBranches: [
        { artifactId: "b0" },
        { artifactId: "b1" },
        { artifactId: "b2" },
      ],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Median over enriched PRs [0, 100, 300] → 100. Dropping the Fresh zero-file
    // PR (the pre-fix behavior) would median [100, 300] → 200.
    const prSize = result.kpis.find((k) => k.key === "pr-size");
    expect(prSize?.value).toBe(100);
  });

  it("marks org delivery provenance disconnected without an active GitHub installation", async () => {
    const { db } = makeFakeDb({
      activeInstallation: null,
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.githubProvenance?.state).toBe(
      InsightsGitHubProvenanceState.Disconnected
    );
  });

  it("marks org delivery provenance active with a valid user OAuth grant and no App installation", async () => {
    const { db } = makeFakeDb({
      activeInstallation: null,
      counts: () => 0,
      userGrant: makeInsightsUserGrant(),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.githubProvenance?.state).toBe(
      InsightsGitHubProvenanceState.Active
    );
  });

  it.each([
    {
      name: "revoked",
      userGrant: makeInsightsUserGrant({ revokedAt: NOW }),
    },
    {
      name: "expired",
      userGrant: makeInsightsUserGrant({
        tokenExpiresAt: new Date(NOW.getTime() - 1),
      }),
    },
  ])("keeps org delivery provenance disconnected for $name user OAuth grants", async ({
    userGrant,
  }) => {
    const { db } = makeFakeDb({
      activeInstallation: null,
      counts: () => 0,
      userGrant,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.githubProvenance?.state).toBe(
      InsightsGitHubProvenanceState.Disconnected
    );
  });

  it("suppresses the delta when there is no full prior period (FEA-2233)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - HOUR) },
        },
      ],
      // History only reaches 100 days back, but the Quarter prior window starts
      // 180 days before NOW — a partial prior period, so the delta is hidden.
      earliest: new Date(NOW.getTime() - 100 * DAY),
      counts: () => 1, // non-empty prior (1 merged) — would otherwise show a delta
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const merged = result.kpis.find((k) => k.key === "merged");
    expect(merged?.value).toBe(1);
    expect(merged?.deltaPct).toBeNull(); // partial prior → hidden chip, not +0%
  });

  it("requires merged rows to have bounded merge timestamps for date windows", async () => {
    const { db, wheres } = makeFakeDb({
      mergedPrs: [],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getDelivery(ORG_CTX, InsightsPeriod.Quarter, NOW);

    const mergedFindWhere = wheres.find(
      (where) =>
        Boolean(where) &&
        typeof where === "object" &&
        (where as Record<string, unknown>).prState ===
          ApiGitHubPRState.Merged &&
        (where as Record<string, unknown>).mergedAt !== undefined
    ) as Record<string, unknown> | undefined;
    expect(mergedFindWhere).toEqual(
      expect.objectContaining({
        prState: ApiGitHubPRState.Merged,
        mergedAt: expect.objectContaining({
          gte: expect.any(Date),
          lte: expect.any(Date),
        }),
      })
    );
    expect(mergedFindWhere).not.toHaveProperty("OR");

    const mergedDateWheres = wheres.filter(
      (where) =>
        Boolean(where) &&
        typeof where === "object" &&
        (where as Record<string, unknown>).prState === ApiGitHubPRState.Merged
    ) as Record<string, unknown>[];
    expect(mergedDateWheres).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ mergedAt: null }),
          ]),
        }),
      ])
    );
  });

  it("caps the merged-PR scan newest-first and sources the count from the DB (FEA-2878)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const { db, mergedFindArgs } = makeFakeDb({
      // A single materialized row, but the org has thousands of merged PRs: the
      // headline count must come from the exact DB count(), not this row array.
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - HOUR) },
        },
      ],
      counts: (where) => {
        const mergedRange = where.mergedAt as { lte?: unknown } | undefined;
        return where.prState === ApiGitHubPRState.Merged &&
          mergedRange?.lte !== undefined
          ? 5000
          : 0;
      },
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.All,
      NOW
    );

    // Headline KPI + state distribution reflect the exact count, not the 1 row.
    expect(result.kpis.find((k) => k.key === "merged")?.value).toBe(5000);
    expect(result.charts.prByState).toEqual([
      { key: ApiGitHubPRState.Merged, label: "Merged", value: 5000 },
    ]);

    // The one merged-PR scan is bounded and ordered newest-first so the "all"
    // period cannot materialize every merged PR org-wide.
    expect(mergedFindArgs).toHaveLength(1);
    expect(mergedFindArgs[0].take).toBe(MERGED_PR_SCAN_CAP);
    expect(mergedFindArgs[0].orderBy).toEqual({ mergedAt: "desc" });
  });

  // FEA-3208: the closed-without-merge denominator must count CLOSED PRs on the
  // SAME population basis Desktop's SSOT uses — a period window over the whole
  // captured PR population, WITHOUT gating on the nullable closedAt.
  //
  // Desktop (local-insights.ts merge-rate query) windows `decided` (merged +
  // closed) on `COALESCE(observed_at, created_at) BETWEEN $1 AND $2` — a null-safe
  // basis: closed is period-scoped but a CLOSED PR with a null closed-timestamp is
  // still counted. Cloud's null-safe analogue is the branch artifact's
  // `createdAt` (Artifact.createdAt is `@default(now())`, never null). The fix
  // therefore windows countClosedPrs on `branchArtifact.createdAt in [start,end]`,
  // NOT on `closedAt`.
  //
  // Two failure modes this asserts against, on ONE corpus:
  //  (a) The original FEA-3151 `closedAt BETWEEN start AND end` gate DROPPED any
  //      genuinely-CLOSED PR with a null closedAt (gh/webhook set pr_state but not
  //      the timestamp) — shrinking the denominator, inflating the rate.
  //  (b) The FEA-3208 over-correction dropped the window ENTIRELY — counting
  //      all-time-old closed PRs outside the period, mixing an all-time closed
  //      denominator with the windowed `mergedAt` numerator, skewing the rate the
  //      other way.
  // The restored windowing must (a) RETAIN a null-closedAt CLOSED PR *within* the
  // period AND (b) EXCLUDE a CLOSED PR *outside* the period, matching desktop.
  it("windows countClosedPrs on branchArtifact.createdAt (not closedAt): keeps in-window null-closedAt CLOSED, drops out-of-window CLOSED", async () => {
    const range = resolvePeriodRange(InsightsPeriod.Quarter, NOW);
    const inWindow = new Date(range.start.getTime() + 10 * DAY);
    const outOfWindow = new Date(range.start.getTime() - 30 * DAY); // before period

    // Corpus of CLOSED-without-merge PRs. `createdAt` is the branch artifact's
    // creation time (the null-safe window basis); `closedAt` is the nullable
    // per-PR timestamp the fixed query must NOT gate on.
    const closedCorpus = [
      // In-window, null closedAt → the FEA-3151-dropped row. MUST be counted.
      { prState: ApiGitHubPRState.Closed, createdAt: inWindow, closedAt: null },
      // In-window, populated closedAt → counted.
      {
        prState: ApiGitHubPRState.Closed,
        createdAt: inWindow,
        closedAt: inWindow,
      },
      // In-window, null closedAt → a second dropped-under-FEA-3151 row, counted.
      { prState: ApiGitHubPRState.Closed, createdAt: inWindow, closedAt: null },
      // OUT-of-window (created before the period) → MUST be excluded. Under the
      // FEA-3208 over-correction (no window) this would wrongly inflate the count.
      {
        prState: ApiGitHubPRState.Closed,
        createdAt: outOfWindow,
        closedAt: null,
      },
    ];
    // Desktop's SSOT windows the closed population on COALESCE(observed_at,
    // created_at) BETWEEN start AND end — so it counts the THREE in-window rows and
    // excludes the out-of-window one, regardless of closedAt.
    const DESKTOP_CLOSED_COUNT = 3;

    // Evaluate the service-produced closed-count `where` against a corpus row
    // exactly as the fixed query does: match on prState AND the branchArtifact
    // createdAt window, with NO closedAt gate (so a null closedAt cannot drop a
    // genuinely-CLOSED in-window PR, and an out-of-window PR is excluded).
    const matchesClosedWhere = (
      where: Record<string, unknown>,
      row: { prState: unknown; createdAt: Date; closedAt: Date | null }
    ): boolean => {
      if (where.prState !== row.prState) {
        return false;
      }
      const branchArtifact = where.branchArtifact as
        | { createdAt?: { gte?: Date; lte?: Date } }
        | undefined;
      const window = branchArtifact?.createdAt;
      if (!(window?.gte && window?.lte)) {
        return false; // no window → the fixed query MUST provide one
      }
      return row.createdAt >= window.gte && row.createdAt <= window.lte;
    };

    let closedWhereSeen: Record<string, unknown> | undefined;
    const { db, wheres } = makeFakeDb({
      mergedPrs: [],
      counts: (where) => {
        const mergedRange = where.mergedAt as { lte?: unknown } | undefined;
        // In-range merged count (headline "Merged PRs" + numerator).
        if (
          where.prState === ApiGitHubPRState.Merged &&
          mergedRange?.lte !== undefined
        ) {
          return 8; // 8 merged
        }
        // The closed-without-merge count (countClosedPrs). Evaluate the real
        // `where` against the corpus — this is the assertion's subject.
        if (where.prState === ApiGitHubPRState.Closed) {
          closedWhereSeen = where;
          return closedCorpus.filter((row) => matchesClosedWhere(where, row))
            .length;
        }
        return 0;
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

    // The closed-count query is pr_state-based, windowed on the branch artifact's
    // createdAt, and crucially does NOT gate on closedAt — so a null closedAt can
    // never drop a CLOSED PR, while the period window is preserved.
    expect(closedWhereSeen).toBeDefined();
    const seen = closedWhereSeen as Record<string, unknown>;
    expect(seen.prState).toBe(ApiGitHubPRState.Closed);
    expect(seen).not.toHaveProperty("closedAt");
    expect(seen).not.toHaveProperty("OR");
    const seenBranch = seen.branchArtifact as
      | { createdAt?: { gte?: Date; lte?: Date } }
      | undefined;
    expect(seenBranch?.createdAt?.gte).toEqual(range.start);
    expect(seenBranch?.createdAt?.lte).toEqual(range.end);

    // The cloud closed count equals the desktop windowed pr_state count: the two
    // in-window null-closedAt CLOSED PRs are retained (not dropped), the populated
    // in-window one is counted, and the out-of-window CLOSED PR is excluded.
    const cloudClosedCount = closedCorpus.filter((row) =>
      matchesClosedWhere(seen, row)
    ).length;
    expect(cloudClosedCount).toBe(DESKTOP_CLOSED_COUNT);
    expect(cloudClosedCount).toBe(3);

    // And the KPI reconciles: 8 merged / (8 merged + 3 closed) = 73% — the same
    // value the desktop SSOT produces over its windowed pr_state closed
    // population. Under the FEA-3151 closedAt-only gate the denominator would have
    // been 8 + 1 = 9 (the two null-closedAt rows dropped) → 89%; under the FEA-3208
    // no-window over-correction it would have been 8 + 4 = 12 (the out-of-window
    // row wrongly counted) → 67%. Both drift from desktop; only the windowed,
    // null-safe basis reconciles.
    const mergeRate = result.kpis.find((k) => k.key === "merge-rate");
    expect(mergeRate?.value).toBe(73); // round(8 / 11 * 100)
  });
});

describe("insightsService.getUtilization", () => {
  it("computes sessions, runtime and reviewer load", async () => {
    const start = new Date("2026-06-08T09:00:00.000Z");
    const { db, wheres } = makeFakeDb({
      // FEA-2877: sessions are rolled up in the DB — the count, summed runtime
      // (seconds) and per-status breakdown arrive pre-aggregated. The open
      // session (0 runtime) still counts toward the session total.
      sessionRollupRows: [
        { status: "completed", n: 1, runtimeSeconds: 2 * 3600 },
        { status: "active", n: 1, runtimeSeconds: 0 },
      ],
      userBreakdownRows: [
        {
          userId: "u1",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@x.io",
          n: 2,
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
    expect(result.charts.sessionsByStatus).toEqual([
      { key: "Completed", label: "Completed", value: 1 },
      { key: "Active", label: "Active", value: 1 },
    ]);
    expect(result.charts.userBreakdown).toEqual([
      { key: "u1", label: "Ada Lovelace", value: 2 },
    ]);
    expect(result.charts.reviewerLoad).toEqual([
      { reviewer: "claude", reviewed: 1, approved: 1, medianWaitMs: HOUR },
    ]);
    expect(result.tileAvailability).toMatchObject({
      "kpi:backlog": InsightsTileAvailabilityState.Available,
      "chart:reviewQueue": InsightsTileAvailabilityState.Available,
      "chart:reviewQueue:donut": InsightsTileAvailabilityState.Available,
      "chart:reviewerLoad": InsightsTileAvailabilityState.Available,
    });
  });

  it("aggregates event count, daily volume and by-type buckets in the DB", async () => {
    const { db, rawQueries } = makeFakeDb({
      // The events KPI reads the DB count, not a materialized row array.
      counts: (where) => (where.eventCreatedAt ? 1234 : 0),
      // Two raw event types that humanize to the same label must merge, and the
      // higher-count label sorts first.
      eventTypeGroups: [
        { eventType: "tool_use", _count: { _all: 10 } },
        { eventType: "tool-use", _count: { _all: 5 } },
        { eventType: "message", _count: { _all: 20 } },
      ],
      eventVolumeRows: [
        { day: "2026-06-08", n: 7 },
        { day: "2026-06-09", n: 3 },
      ],
      // FEA-2877: daily session-start volume is also date-bucketed in the DB.
      sessionActivityRows: [
        { day: "2026-06-08", n: 4 },
        { day: "2026-06-09", n: 6 },
      ],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getUtilization(
      ORG_CTX,
      InsightsPeriod.Month,
      NOW
    );

    expect(result.kpis.find((k) => k.key === "events")?.value).toBe(1234);
    expect(result.charts.eventsByType).toEqual([
      { key: "Message", label: "Message", value: 20 },
      { key: "Tool Use", label: "Tool Use", value: 15 },
    ]);
    expect(
      result.charts.eventVolume?.points.find((p) => p.date === "2026-06-08")
        ?.values.events
    ).toBe(7);
    expect(
      result.charts.eventVolume?.points.find((p) => p.date === "2026-06-09")
        ?.values.events
    ).toBe(3);
    expect(
      result.charts.eventActivity?.points.find((p) => p.date === "2026-06-08")
        ?.values.sessions
    ).toBe(4);
    expect(
      result.charts.eventActivity?.points.find((p) => p.date === "2026-06-09")
        ?.values.sessions
    ).toBe(6);

    // The raw event-volume aggregation must be org-scoped: its SQL carries the
    // organization_id predicate and binds the org id (cross-org isolation).
    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.values).toContain(ORG);
  });

  it("falls back to UTC session-activity bucketing when Postgres rejects the requester timezone (FEA-2877)", async () => {
    const { db } = makeFakeDb({
      counts: () => 0,
      failTimeZoneActivity: true,
      // The UTC retry returns already-bucketed day rows.
      sessionActivityRows: [{ day: "2026-06-08", n: 9 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    // A zone ICU accepts but the DB's tzdata may not know must not 500 the
    // whole dashboard — the chart still renders off the UTC-bucketed retry.
    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/Ciudad_Juarez" },
      InsightsPeriod.Month,
      NOW
    );

    expect(
      result.charts.eventActivity?.points.find((p) => p.date === "2026-06-08")
        ?.values.sessions
    ).toBe(9);
  });

  it("buckets the raw event-volume query in the viewer's timezone (FEA-2881)", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    // The day bucket is converted into the viewer's zone before truncation, and
    // the IANA zone is bound as a parameter (matches the sibling Event activity
    // chart, which buckets in local time via bucketCountByDay(..., timeZone)).
    expect(raw.text).toContain("AT TIME ZONE");
    expect(raw.values).toContain("America/New_York");
  });

  it("normalizes an offset-style timezone to Etc/GMT before PG bucketing (FEA-2881)", async () => {
    // `Intl` accepts `+01:00`, but PG's `AT TIME ZONE '+01:00'` mis-signs bare
    // offsets, so the offset must be rewritten to the equivalent whole-hour
    // `Etc/GMT-1` IANA name (sign inverted) before it reaches the SQL. The event
    // at 2026-06-08T23:30Z lands on 2026-06-09 in UTC+1, so the response must
    // credit the count to 2026-06-09, not 2026-06-08.
    const { db, rawQueries } = makeFakeDb({
      counts: () => 0,
      eventVolumeRows: [{ day: "2026-06-09", n: 4 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "+01:00" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).toContain("AT TIME ZONE");
    // The raw offset is never bound; its canonical Etc/GMT name is.
    expect(raw.values).toContain("Etc/GMT-1");
    expect(raw.values).not.toContain("+01:00");
    // Response day-keys are labeled with the same canonical zone, so the
    // Etc/GMT-1-bucketed 2026-06-09 row is rendered on the 2026-06-09 key.
    expect(
      result.charts.eventVolume?.points.find((p) => p.date === "2026-06-09")
        ?.values.events
    ).toBe(4);
  });

  it("falls back to UTC bucketing for a non-canonicalizable offset timezone (FEA-2881)", async () => {
    // `+05:30` (or any fractional / out-of-range offset) can't be expressed as a
    // whole-hour Etc/GMT zone, so the SQL path drops to legacy UTC bucketing
    // rather than emitting a mis-signed offset.
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "+05:30" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).not.toContain("AT TIME ZONE");
    expect(raw.values).not.toContain("+05:30");
  });

  it("leaves the raw event-volume query UTC-bucketed when no timezone is set", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(ORG_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).not.toContain("AT TIME ZONE");
  });

  it("scopes the raw event-volume query to the current user under me scope", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(ME_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.text).toContain("s.user_id");
    expect(raw.values).toContain(ORG);
    expect(raw.values).toContain(USER);
  });

  it("scopes the raw event-volume query to team membership under team scope", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(TEAM_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.text).toContain("team_members");
    expect(raw.values).toContain(ORG);
    expect(raw.values).toContain(TEAM);
  });

  it("buckets the raw event-volume query in the caller's timezone (FEA-2880)", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    // The DB truncation re-anchors the naive UTC timestamp to the requester's
    // zone before date_trunc, matching the sibling JS series / desktop localDay.
    expect(raw.text).toContain("AT TIME ZONE 'UTC' AT TIME ZONE");
    expect(raw.values).toContain("America/New_York");
  });

  it("enumerates event-volume points in the caller's local calendar (FEA-2880)", async () => {
    // A window edge straddling UTC midnight: at 02:00Z the local time in
    // America/New_York (EDT, UTC-4) is 22:00 the previous evening, so the local
    // calendar day the trend window opens on is one day earlier than the UTC one.
    const nearMidnightNow = new Date("2026-06-09T02:00:00.000Z");
    const { db } = makeFakeDb({
      counts: () => 0,
      // A DB bucket keyed to the LOCAL opening day (Week window opens at
      // 2026-06-02T02:00Z → 2026-06-01 local). It is only enumerated — and so
      // only surfaced — if eachDayKey walks the caller's zone, not UTC (whose
      // enumeration would start a day later at 2026-06-02 and drop this count).
      eventVolumeRows: [{ day: "2026-06-01", n: 5 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Week,
      nearMidnightNow
    );

    const points = result.charts.eventVolume?.points ?? [];
    expect(points[0]?.date).toBe("2026-06-01");
    expect(points.find((p) => p.date === "2026-06-01")?.values.events).toBe(5);
    // UTC enumeration would have run 2026-06-02…2026-06-09; the local walk stops
    // at the local end day (2026-06-08), so 2026-06-09 must be absent.
    expect(points.some((p) => p.date === "2026-06-09")).toBe(false);
  });

  it("fails the raw event-volume query closed when team scope lacks a teamId", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getUtilization(
      TEAM_CTX_WITHOUT_ID,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "agent_session_events");
    // The scope predicate collapses to a `false` literal — no team/org rows leak
    // and no team id is bound.
    expect(raw.text).toContain("false");
    expect(raw.text).not.toContain("team_members");
    expect(raw.values).not.toContain(TEAM);
  });
});

describe("insightsService.getAgents", () => {
  it("computes tokens, distinct models and model spend breakdown", async () => {
    const { db, wheres } = makeFakeDb({
      tokenUsage: [
        {
          model: "opus",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          estimatedCost: 1.5,
        },
        {
          model: "sonnet",
          inputTokens: 30,
          outputTokens: 20,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          estimatedCost: 0.5,
        },
      ],
      toolUseSum: 42,
      // Pre-bucketed daily tool-run total straight from the DB SUM (FEA-2956).
      toolRunsByDayRows: [{ day: "2026-06-08", n: 42 }],
      // Tool buckets come from a DB groupBy on toolName, ranked by count.
      toolUsageGroups: [
        { toolName: "Bash", _count: { _all: 12 } },
        { toolName: "Read", _count: { _all: 30 } },
      ],
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
    // KPI totals + token-distribution donut come from a single aggregate({_sum})
    // (FEA-2876), no longer a JS reduction over the full token table.
    expect(result.kpis.find((k) => k.key === "tokens")?.value).toBe(200);
    expect(result.kpis.find((k) => k.key === "input-tokens")?.value).toBe(130);
    expect(result.kpis.find((k) => k.key === "output-tokens")?.value).toBe(70);
    expect(result.kpis.find((k) => k.key === "cache-tokens")?.value).toBe(20);
    expect(result.kpis.find((k) => k.key === "models")?.value).toBe(2);
    expect(result.kpis.find((k) => k.key === "tool-runs")?.value).toBe(42);
    expect(result.charts.tokenDistribution).toEqual([
      { key: "input", label: "Input", value: 130 },
      { key: "output", label: "Output", value: 70 },
      { key: "cache-read", label: "Cache read", value: 13 },
      { key: "cache-write", label: "Cache write", value: 7 },
    ]);
    // FEA-2331: model breakdown ranks by estimated spend (USD), not tokens —
    // now grouped in the DB (FEA-2876).
    expect(result.charts.modelBreakdown).toEqual([
      { key: "opus", label: "opus", value: 1.5 },
      { key: "sonnet", label: "sonnet", value: 0.5 },
    ]);
    expect(
      result.charts.toolRunsOverTime?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values["tool-runs"]
    ).toBe(42);
    expect(result.charts.toolUsage).toEqual([
      { key: "Read", label: "Read", value: 30 },
      { key: "Bash", label: "Bash", value: 12 },
    ]);
  });

  it("labelizes and merges the DB-grouped agent status/type buckets and scopes the raw query to the org", async () => {
    const { db, rawQueries } = makeFakeDb({
      // Pre-grouped raw (value, count) rows straight from the DB unnest+GROUP BY.
      // "in_progress" and "in-progress" collide after labelize → merged to one
      // "In Progress" bucket; the blank/unknown fallback stays "Unknown".
      agentStatusBuckets: [
        { bucket: "in_progress", n: 3 },
        { bucket: "in-progress", n: 2 },
        { bucket: "unknown", n: 1 },
      ],
      agentTypeBuckets: [
        { bucket: "sub-agent", n: 4 },
        { bucket: "root", n: 1 },
      ],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Descending by merged count: In Progress (3+2) over Unknown (1).
    expect(result.charts.agentsByStatus).toEqual([
      { key: "In Progress", label: "In Progress", value: 5 },
      { key: "Unknown", label: "Unknown", value: 1 },
    ]);
    expect(result.charts.agentsByType).toEqual([
      { key: "Sub Agent", label: "Sub Agent", value: 4 },
      { key: "Root", label: "Root", value: 1 },
    ]);

    // The unnest query carries the org scope predicate and binds the org id.
    const agentRaw = rawQueries
      .map((sql) => flattenRawSql(sql))
      .find((raw) => raw.text.includes("jsonb_array_elements"));
    expect(agentRaw?.text).toContain("a.organization_id");
    expect(agentRaw?.values).toContain(ORG);
  });

  it("builds the model-usage series from the DB-bucketed spend rows and scopes the raw query to the org", async () => {
    const { db, wheres, rawQueries } = makeFakeDb({
      // Spend-by-model breakdown ranks opus over sonnet (drives series order).
      tokenUsage: [
        { model: "opus", estimatedCost: 1.5 },
        { model: "sonnet", estimatedCost: 0.5 },
      ],
      // Pre-bucketed (day, model, cost) rows straight from the DB date_trunc.
      modelUsageRows: [
        { day: "2026-06-08", model: "opus", cost: 1.5 },
        { day: "2026-06-08", model: "sonnet", cost: 0.5 },
      ],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const series = result.charts.modelUsageOverTime;
    expect(series?.series.map((s) => s.key)).toEqual(["opus", "sonnet"]);
    const day = series?.points.find((p) => p.date === "2026-06-08");
    expect(day?.values.opus).toBe(1.5);
    expect(day?.values.sonnet).toBe(0.5);

    // The token spend surfaces (aggregate + groupBy) stay org-scoped, and the raw
    // per-day query carries the org predicate + binds the org id (FEA-2876).
    expectAllOrgScoped(wheres);
    const tokenRaw = rawQueries
      .map((sql) => flattenRawSql(sql))
      .find((raw) => raw.text.includes("agent_session_token_usage"));
    expect(tokenRaw?.text).toContain("a.organization_id");
    expect(tokenRaw?.values).toContain(ORG);
  });

  it("builds the tool-run series from the DB-bucketed sums and scopes the raw query to the org", async () => {
    const { db, wheres, rawQueries } = makeFakeDb({
      // Pre-bucketed (day, n) tool-run totals straight from the DB SUM.
      toolRunsByDayRows: [{ day: "2026-06-08", n: 42 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(
      result.charts.toolRunsOverTime?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values["tool-runs"]
    ).toBe(42);

    // The per-day tool-run query carries the org predicate + binds the org id.
    expectAllOrgScoped(wheres);
    const toolRunRaw = rawQueries
      .map((sql) => flattenRawSql(sql))
      .find((raw) => raw.text.includes("tool_use_count"));
    expect(toolRunRaw?.text).toContain("a.organization_id");
    expect(toolRunRaw?.values).toContain(ORG);
  });

  it("falls back to UTC tool-run bucketing when Postgres rejects the requester timezone (FEA-2956)", async () => {
    const { db } = makeFakeDb({
      failTimeZoneToolRuns: true,
      // The UTC retry returns already-bucketed day rows.
      toolRunsByDayRows: [{ day: "2026-06-08", n: 7 }],
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    // A zone ICU accepts but the DB's tzdata may not know must not 500 the
    // Agents dashboard — the chart still renders off the UTC-bucketed retry.
    const result = await insightsService.getAgents(
      { ...ORG_CTX, timeZone: "America/Ciudad_Juarez" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(
      result.charts.toolRunsOverTime?.points.find(
        (point) => point.date === "2026-06-08"
      )?.values["tool-runs"]
    ).toBe(7);
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
    expect(result.tileAvailability?.["chart:checkStatus"]).toBe(
      InsightsTileAvailabilityState.Unavailable
    );
    expect(result.tileAvailability?.["chart:branchesWithoutPr"]).toBe(
      InsightsTileAvailabilityState.Available
    );
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
    expect(result.tileAvailability).toMatchObject({
      "kpi:backlog": InsightsTileAvailabilityState.Unavailable,
      "chart:reviewQueue": InsightsTileAvailabilityState.Unavailable,
      "chart:reviewQueue:donut": InsightsTileAvailabilityState.Unavailable,
      "chart:reviewerLoad": InsightsTileAvailabilityState.Unavailable,
    });
  });
});

describe("team scope", () => {
  it("filters delivery artifacts and utilization sessions by team membership", async () => {
    const { db, wheres } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getDelivery(TEAM_CTX, InsightsPeriod.Quarter, NOW);
    await insightsService.getUtilization(TEAM_CTX, InsightsPeriod.Quarter, NOW);

    const teamIds: string[] = [];
    for (const where of wheres) {
      collectKey(where, "teamId", teamIds);
    }
    expect(teamIds.length).toBeGreaterThan(0);
    expect(teamIds.every((teamId) => teamId === TEAM)).toBe(true);
  });

  it("fails closed if team scope reaches the service without teamId", async () => {
    const { db, wheres } = makeFakeDb({ counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getDelivery(
      TEAM_CTX_WITHOUT_ID,
      InsightsPeriod.Quarter,
      NOW
    );
    await insightsService.getUtilization(
      TEAM_CTX_WITHOUT_ID,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(wheres.some(hasEmptyInPredicate)).toBe(true);
    const teamIds: string[] = [];
    for (const where of wheres) {
      collectKey(where, "teamId", teamIds);
    }
    expect(teamIds).toHaveLength(0);
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

  it("minDate returns the earliest non-null date, or null when none", () => {
    const a = new Date("2025-01-01T00:00:00.000Z");
    const b = new Date("2025-06-01T00:00:00.000Z");
    expect(minDate(b, a, null)).toBe(a);
    expect(minDate(undefined, b)).toBe(b);
    expect(minDate(null, undefined)).toBeNull();
    expect(minDate()).toBeNull();
  });
});

describe("reportDeltaFor — full prior period rule (FEA-2233)", () => {
  const quarter = resolvePeriodRange(InsightsPeriod.Quarter, NOW);
  const all = resolvePeriodRange(InsightsPeriod.All, NOW);
  const priorStart = quarter.priorStart as Date;

  const cases: {
    name: string;
    range: ReturnType<typeof resolvePeriodRange>;
    earliest: Date | null;
    expected: number | null;
  }[] = [
    {
      name: "full prior period (earliest before priorStart) → reports delta",
      range: quarter,
      earliest: new Date(priorStart.getTime() - DAY),
      expected: 20,
    },
    {
      name: "earliest exactly at priorStart → reports delta (inclusive)",
      range: quarter,
      earliest: priorStart,
      expected: 20,
    },
    {
      name: "partial prior period (earliest after priorStart) → suppressed",
      range: quarter,
      earliest: new Date(priorStart.getTime() + DAY),
      expected: null,
    },
    {
      name: "no history (earliest null) → suppressed",
      range: quarter,
      earliest: null,
      expected: null,
    },
    {
      name: "all-time period (priorStart null) → suppressed",
      range: all,
      earliest: new Date(0),
      expected: null,
    },
  ];

  it.each(cases)("$name", ({ range, earliest, expected }) => {
    expect(reportDeltaFor(range, earliest)(12, 10)).toBe(expected);
  });

  it("still suppresses an empty prior window even with full history", () => {
    expect(reportDeltaFor(quarter, new Date(0))(12, 0)).toBeNull();
  });

  it("buildPrByRepoBuckets merges App + desktop lanes for one repo across casing", () => {
    const row = (
      overrides: Partial<{
        repositoryFullName: string | null;
        repository: { name: string } | null;
      }>
    ) =>
      ({
        mergedAt: new Date("2026-06-08T00:00:00.000Z"),
        repositoryId: null,
        repositoryFullName: null,
        branchArtifactId: "b",
        repository: null,
        branchArtifact: { createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ...overrides,
      }) as Parameters<typeof buildPrByRepoBuckets>[0][number];

    const buckets = buildPrByRepoBuckets([
      // App lane: canonical-case short name.
      row({ repository: { name: "Foo-Bar" } }),
      // Desktop repo-less lane: lowercased owner/name for the SAME repo.
      row({ repositoryFullName: "acme/foo-bar" }),
      // A different repo.
      row({ repository: { name: "Widgets" } }),
    ]);

    // One bucket for the shared repo (count 2), canonical casing preserved.
    expect(buckets).toContainEqual({ label: "Foo-Bar", value: 2 });
    expect(buckets).toContainEqual({ label: "Widgets", value: 1 });
    expect(buckets).toHaveLength(2);
  });

  it("buildPrByRepoBuckets drops rows with neither repo identity", () => {
    const buckets = buildPrByRepoBuckets([
      {
        mergedAt: new Date("2026-06-08T00:00:00.000Z"),
        repositoryId: null,
        repositoryFullName: null,
        branchArtifactId: "b",
        repository: null,
        branchArtifact: { createdAt: new Date("2026-06-01T00:00:00.000Z") },
      } as Parameters<typeof buildPrByRepoBuckets>[0][number],
    ]);
    expect(buckets).toEqual([]);
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

  it("bucketCountByDay labels buckets in the caller's timezone (FEA-2745)", () => {
    const start = new Date("2026-06-08T12:00:00.000Z");
    const end = new Date("2026-06-09T12:00:00.000Z");
    // 2026-06-09T02:00Z is 22:00 the previous evening in America/New_York
    // (EDT, UTC-4), so it belongs to the 2026-06-08 LOCAL calendar day.
    const lateNightUtc = [new Date("2026-06-09T02:00:00.000Z")];

    const utc = bucketCountByDay(lateNightUtc, start, end, {
      key: "sessions",
      label: "Sessions",
    });
    expect(utc.points).toEqual([
      { date: "2026-06-08", values: { sessions: 0 } },
      { date: "2026-06-09", values: { sessions: 1 } },
    ]);

    const local = bucketCountByDay(
      lateNightUtc,
      start,
      end,
      { key: "sessions", label: "Sessions" },
      "America/New_York"
    );
    expect(local.points).toEqual([
      { date: "2026-06-08", values: { sessions: 1 } },
      { date: "2026-06-09", values: { sessions: 0 } },
    ]);
  });
});
