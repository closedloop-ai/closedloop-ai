/**
 * Unit tests for insightsService and its pure aggregation helpers.
 *
 * The DB is mocked: withDb runs the callback against a fake Prisma client whose
 * methods return fixtures and record every `where` clause, so we can assert
 * both the computed KPI/chart math and that every query is organization-scoped
 * (cross-org isolation).
 */

import { COST_KPI_SUB } from "@closedloop-ai/loops-api/insights";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
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

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { ChecksStatus, withDb } from "@repo/database";
import {
  type BranchPopulationRow,
  branchPrCountFrom,
  checkStatusGroupsFrom,
  collectKey,
  expectAllOrgScoped,
  findRawSql,
  flattenRawSql,
  hasEmptyInPredicate,
  hasOwnedPrArm,
  identityRow,
  makeFakeDb,
  makeInsightsUserGrant,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { MERGED_PR_SCAN_CAP } from "./merged-pr-queries";
import { insightsService } from "./service";
import { bucketCountByDay } from "./service/buckets";
import { minDate, reportDeltaFor, resolvePeriodRange } from "./service/period";

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

beforeEach(() => {
  vi.mocked(withDb).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("insightsService.getDelivery", () => {
  it("computes delivery KPIs and charts from org-scoped data", async () => {
    const mergedAt = new Date("2026-06-09T02:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db, wheres } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          // PLN-1535 M4: each PR carries its OWN projected diff size; the KLOC
          // and median KPIs no longer read a branch-keyed file-cache rollup.
          id: "pr-1",
          number: 1,
          githubId: "gh-1",
          additions: 100,
          deletions: 50,
          repositoryId: "r1",
          repositoryFullName: "acme/closedloop-ai",
          branchArtifactId: "b1",
          repository: { name: "closedloop-ai" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-2",
          number: 2,
          githubId: "gh-2",
          additions: 200,
          deletions: 50,
          repositoryId: "r2",
          repositoryFullName: "acme/web",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - 5 * DAY) },
        },
      ],
      checkStatusGroups: [
        { checksStatus: "PASSING", _count: { _all: 9 } },
        { checksStatus: "FAILING", _count: { _all: 1 } },
      ],
      branchListPopulationIds: ["branch-1"],
      costSum: 412.5,
      // ISS-5624: the closed-without-merge denominator and the prior merged
      // window are distinct-identity aggregates, so each is one pull request
      // here rather than a routed `count()`.
      closedPrs: [identityRow("closed-1", 11)],
      priorMergedPrs: [identityRow("prior-1", 12)],
      counts: (where) => {
        const branchArtifact = where.branchArtifact as
          | Record<string, unknown>
          | undefined;
        if (branchArtifact && "createdAt" in branchArtifact) {
          // The merge-rate numerator further scopes the opened cohort to MERGED
          // PRs, so both surfaces divide over ONE set (2 merged of 4 opened).
          return where.prState === ApiGitHubPRState.Merged ? 2 : 4; // opened / opened+merged
        }
        if (hasOwnedPrArm(where, "none")) {
          return 3; // branches without PR
        }
        if (hasOwnedPrArm(where, "some")) {
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
    installDb(db);

    const result = await insightsService.getDelivery(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Quarter,
      NOW
    );

    expectAllOrgScoped(wheres);

    // FEA-3638 Slice 0 — DB round-trip baseline. Each `withDb(...)` call is one
    // DB round-trip; the fake harness routes every call through the mocked
    // `withDb`, so `mock.calls.length` is the exact per-endpoint round-trip count
    // for this org-scope fan-out. This PINS today's baseline so later perf slices
    // (Tier-2 round-trip collapses) prove a measured delta and no change silently
    // RE-ADDS a query. getDelivery fires Wave 1 (8 helpers, of which
    // `earliestRecord` fans out to 2 aggregates → 9 calls) then Wave 2
    // (`fetchBranchesWithoutPrBuckets` = 1 call — 2 counts via Promise.all
    // inside one withDb, `fetchCheckStatusBuckets` under Org scope = 1) —
    // 9 + 1 + 1 + the ISS-8424 census (Wave 1) = 12 round-trips. `mock.calls
    // .length` counts withDb invocations, not queries Promise.all'd inside one.
    // Index-only Slice 1 does NOT change this count (indexes alter plan choice,
    // not query count).
    //
    // PLN-1535 M4 dropped this from 12 to 11: LOC now comes off the merged-PR
    // rows Wave 1 already fetched, so the `fetchMergedLineTotals` round-trip
    // (a branch-file-cache group-by plus a fileCacheStatus lookup) is gone —
    // one fewer concurrent connection against the max:20 pool, and Wave 2 no
    // longer has to be gated on Wave 1's merged set at all.
    //
    // ISS-11915 raised it from 12 to 13: both donuts now count the Branches
    // list population, read ONCE through the list's candidate SQL before them (14 with ISS-11589's Median PR size read).
    //
    // ISS-12408 lowered it from 14 to 11: Merged PRs, its prior window and the
    // closed-unmerged count are no longer three reads of their own. They come
    // from the one shared pull-request read that already carried the median.
    expect(vi.mocked(withDb).mock.calls.length).toBe(11);

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

    // FEA-2947: the dedicated "mergedKloc" KPI (AI-Impact card's tokens-per-KLOC
    // denominator) carries the same merged-lines KLOC as the visible "kloc" tile
    // here. The card reads THIS key so the desktop surface — whose "kloc" KPI is
    // captured-lines KLOC — divides by the same merged-lines population.
    const mergedKloc = result.kpis.find((k) => k.key === "mergedKloc");
    expect(mergedKloc?.value).toBe(0.4);

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
    const day = "2026-06-08";
    const prPoints = result.charts.prTrend.points;
    const klocPoints = result.charts.klocTrend?.points;
    expect(prPoints.find((p) => p.date === day)?.values.merged).toBe(2);
    expect(klocPoints?.find((p) => p.date === day)?.values.kloc).toBe(0.4);
  });

  it("sends the raw cost aggregate, so a sub-cent total is not rounded to zero (ISS-4919)", async () => {
    // whitlockk review. The producer used to `round(cost, 2)` before emitting the
    // KPI, which destroyed the very band ISS-4919 fixes one layer down: a real
    // $0.004 org total arrived at the client as numeric 0, so the shared
    // sub-floor bound could never fire and the tile rendered "$0" — a measured
    // zero for money that was actually spent. Desktop sends `totalCost` raw, so
    // the same org read "$0" on web and a real figure on desktop.
    //
    // Asserted on the WIRE value, not the rendered string: display precision is
    // the formatter's job (`formatCurrencyTileValue`), and the defect was that
    // the producer pre-empted it.
    const { db } = makeFakeDb({ costSum: 0.004, counts: () => 0 });
    installDb(db);

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const cost = result.kpis.find((k) => k.key === "cost");
    expect(cost?.value).toBe(0.004);
    expect(cost?.value).not.toBe(0);
    expect(cost?.format).toBe(KpiFormat.Currency);
  });

  it("keeps sub-cent cost detail all the way below the 4dp render floor (ISS-4919)", async () => {
    // The band under `formatCostPrecise`'s floor is exactly where rounding at the
    // producer is unrecoverable: once it is 0 on the wire, no formatter can tell
    // "too small to show" from "free", and the tile asserts the wrong one.
    const { db } = makeFakeDb({ costSum: 0.000_01, counts: () => 0 });
    installDb(db);

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const cost = result.kpis.find((k) => k.key === "cost");
    expect(cost?.value).toBe(0.000_01);
  });

  it("captions the cost KPI with the shared basis constant, never a billed-money claim", async () => {
    // ISS-4994. The caption is the SHARED `COST_KPI_SUB` (now in
    // `@closedloop-ai/loops-api/insights`), which is what makes desktop's producer render
    // the identical sentence over the identical subscription-inclusive aggregate.
    const { db } = makeFakeDb({ costSum: 412.5, counts: () => 0 });
    installDb(db);

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const cost = result.kpis.find((k) => k.key === "cost");
    expect(cost?.sub).toBe(COST_KPI_SUB);
    expect(cost?.sub.toLowerCase()).not.toContain("spend");
  });

  it("marks org delivery provenance disconnected without an active GitHub installation", async () => {
    const { db } = makeFakeDb({
      activeInstallation: null,
      counts: () => 0,
    });
    installDb(db);

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
    installDb(db);

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.githubProvenance?.state).toBe(
      InsightsGitHubProvenanceState.Active
    );
  });

  // The `expired` sibling this case used to carry described `token_expires_at`
  // on a stored token, which PLN-1742's M5 tail removed — Clerk mints a fresh
  // token per call, so there is no stored expiry left to report.
  it.each([
    {
      name: "revoked",
      userGrant: makeInsightsUserGrant({ revokedAt: NOW }),
    },
  ])(
    "keeps org delivery provenance disconnected for $name user OAuth grants",
    async ({ userGrant }) => {
      const { db } = makeFakeDb({
        activeInstallation: null,
        counts: () => 0,
        userGrant,
      });
      installDb(db);

      const result = await insightsService.getDelivery(
        ORG_CTX,
        InsightsPeriod.Quarter,
        NOW
      );

      expect(result.githubProvenance?.state).toBe(
        InsightsGitHubProvenanceState.Disconnected
      );
    }
  );

  it("suppresses the delta when there is no full prior period (FEA-2233)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "closedloop-ai" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - HOUR) },
        },
      ],
      // History only reaches 100 days back, but the Quarter prior window starts
      // 180 days before NOW — a partial prior period, so the delta is hidden.
      earliest: new Date(NOW.getTime() - 100 * DAY),
      pullRequestFacts: { merged: 1, priorMerged: 1 },
    });
    installDb(db);

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
    const { db, rawQueries } = makeFakeDb({
      mergedPrs: [],
      counts: () => 0,
    });
    installDb(db);

    await insightsService.getDelivery(ORG_CTX, InsightsPeriod.Quarter, NOW);

    const mergedScan = findRawSql(rawQueries, "SELECT p.id");
    expect(mergedScan.text).toContain("p.pr_state = ");
    expect(mergedScan.text).toContain("p.merged_at >= ");
    expect(mergedScan.text).toContain("p.merged_at <= ");
    expect(mergedScan.text).toContain("a.organization_id = ");
    expect(mergedScan.text).toContain("p.last_verified_at IS NOT NULL");
    expect(mergedScan.text).toContain("FROM artifact_links al");
    expect(mergedScan.values).toContain(ApiGitHubPRState.Merged);
    expect(mergedScan.values).toContain(ORG);

    expect(mergedScan.text).not.toContain("p.merged_at IS NULL");
  });

  it("caps the merged-PR scan newest-first and sources the count from the shared fold (FEA-2878, ISS-12408)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const { db, mergedFindArgs, rawQueries } = makeFakeDb({
      // A single materialized row, but the org has thousands of merged PRs: the
      // headline count must come from the shared fold, not this row array.
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          repositoryId: "r1",
          branchArtifactId: "b1",
          repository: { name: "closedloop-ai" },
          branchArtifact: { createdAt: new Date(mergedAt.getTime() - HOUR) },
        },
      ],
      pullRequestFacts: { merged: 5000 },
    });
    installDb(db);

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.All,
      NOW
    );

    // Headline KPI + state distribution reflect the fold's count, not the 1 row.
    expect(result.kpis.find((k) => k.key === "merged")?.value).toBe(5000);
    expect(result.charts.prByState).toEqual([
      { key: ApiGitHubPRState.Merged, label: "Merged", value: 5000 },
    ]);

    // The admitted-id scan is bounded and ordered before hydration so the "all"
    // period cannot materialize the org-wide population.
    const mergedScan = findRawSql(rawQueries, "SELECT p.id");
    expect(mergedScan.text).toContain("ORDER BY p.merged_at DESC, p.id ASC");
    expect(mergedScan.text).toContain("LIMIT ");
    expect(mergedScan.values).toContain(MERGED_PR_SCAN_CAP);

    // Hydration reads only the selected ids; the cap/order belongs to the raw
    // admitted-id scan above, not this projection fetch.
    expect(mergedFindArgs).toHaveLength(1);
    expect(mergedFindArgs[0]).toMatchObject({
      where: { id: { in: ["merged-pr-1"] } },
    });
    expect(mergedFindArgs[0]).not.toHaveProperty("take");
  });
});

describe("insightsService.getUtilization", () => {
  it("computes sessions, runtime and reviewer load", async () => {
    const { db, rawQueries, wheres } = makeFakeDb({
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
      // Two reviewers in the DB's GROUP BY author_login / ORDER BY reviewed DESC
      // order: a populated median and — crucially — a null median (percentile_cont
      // is NULL when a reviewer has no non-negative wait), which must map through as
      // `null`, not `0` or `NaN`.
      reviewerLoadRows: [
        {
          reviewer: "claude",
          reviewed: 3,
          approved: 2,
          median_wait_ms: HOUR,
        },
        {
          reviewer: "codex",
          reviewed: 1,
          approved: 0,
          median_wait_ms: null,
        },
      ],
      counts: () => 5,
    });
    installDb(db);

    const result = await insightsService.getUtilization(
      ORG_CTX,
      InsightsPeriod.Month,
      NOW
    );

    expectAllOrgScoped(wheres);
    const reviewerSql = findRawSql(rawQueries, "author_login");
    expect(reviewerSql.text).toContain("a.organization_id");
    expect(reviewerSql.values).toContain(ORG);
    // FEA-3638 Slice 0 — DB round-trip baseline (see getDelivery note). The
    // utilization endpoint fires a single `Promise.all` fan-out; under Org scope
    // it reaches 13 helpers/round-trips (including the Org-only reviewer-load and
    // user-breakdown queries, the FEA-3684 activity-heatmap unnest, and
    // `earliestRecord`'s 2 aggregates). There is no check-status query in this
    // endpoint — that helper is delivery-only. ISS-4629 folded the review-queue
    // chart and the review-backlog KPI into ONE `groupBy` snapshot (14→13), so
    // they can't skew across reads. Pins the baseline so the Tier-2 collapses
    // (e.g. `earliestRecord` 2→1) prove a delta.
    expect(vi.mocked(withDb).mock.calls.length).toBe(13);
    expect(result.kpis.find((k) => k.key === "sessions")?.value).toBe(2);
    expect(result.kpis.find((k) => k.key === "runtime")?.value).toBe(2 * HOUR);
    expect(result.charts.sessionsByStatus).toEqual([
      { key: "Active", label: "Active", value: 1 },
      { key: "Completed", label: "Completed", value: 1 },
    ]);
    expect(result.charts.userBreakdown).toEqual([
      { key: "u1", label: "Ada Lovelace", value: 2 },
    ]);
    expect(result.charts.reviewerLoad).toEqual([
      { reviewer: "claude", reviewed: 3, approved: 2, medianWaitMs: HOUR },
      { reviewer: "codex", reviewed: 1, approved: 0, medianWaitMs: null },
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
    installDb(db);

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
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
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
    installDb(db);

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

  it("falls back to UTC event-volume bucketing when Postgres rejects the requester timezone (FEA-3465)", async () => {
    const { db } = makeFakeDb({
      counts: () => 0,
      failTimeZoneEvents: true,
      // The UTC retry returns already-bucketed day rows.
      eventVolumeRows: [{ day: "2026-06-08", n: 7 }],
    });
    installDb(db);

    // A zone ICU accepts but the DB's tzdata may not know must not 500 the whole
    // utilization dashboard — the Events chart still renders off the UTC retry.
    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/Ciudad_Juarez" },
      InsightsPeriod.Month,
      NOW
    );

    expect(
      result.charts.eventVolume?.points.find((p) => p.date === "2026-06-08")
        ?.values.events
    ).toBe(7);
  });

  it("computes the Event Activity heatmap (day×hour Human/Agent split) in the DB (FEA-3684)", async () => {
    const { db, rawQueries } = makeFakeDb({
      counts: () => 0,
      // Pre-bucketed (day, hour, human, agent) rows in arbitrary order; the
      // service sorts cells by (day, hour) before returning them.
      activityHeatmapRows: [
        { day: "2026-06-09", hour: 14, human: 1, agent: 8 },
        { day: "2026-06-08", hour: 9, human: 3, agent: 5 },
      ],
    });
    installDb(db);

    const result = await insightsService.getUtilization(
      ORG_CTX,
      InsightsPeriod.Month,
      NOW
    );

    const heatmap = result.charts.activityHeatmap;
    // Cells come back sorted by (day, hour) regardless of DB row order.
    expect(heatmap?.cells).toEqual([
      { day: "2026-06-08", hour: 9, human: 3, agent: 5 },
      { day: "2026-06-09", hour: 14, human: 1, agent: 8 },
    ]);
    // The day axis spans the capped trend window as contiguous columns covering
    // both populated days (mirrors the eventActivity series window).
    expect(heatmap?.days).toContain("2026-06-08");
    expect(heatmap?.days).toContain("2026-06-09");

    // Org-scoped, headless-suppressing, and (ISS-5408) joined to the billable
    // round-trip source, so a revert to row-counting cannot pass on the fixture.
    const raw = findRawSql(rawQueries, "metadata -> 'messages'");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.values).toContain(ORG);
    expect(raw.text).toContain("entrypoint");
    expect(raw.text).toContain("permissionMode");
    expect(raw.text).toContain("agent_session_token_events");
  });

  it("falls back to UTC heatmap bucketing when Postgres rejects the requester timezone (FEA-3684)", async () => {
    const { db } = makeFakeDb({
      counts: () => 0,
      failTimeZoneHeatmap: true,
      // The UTC retry returns already-bucketed (day, hour) rows.
      activityHeatmapRows: [{ day: "2026-06-08", hour: 9, human: 2, agent: 4 }],
    });
    installDb(db);

    // A zone ICU accepts but the DB's tzdata may not know must not 500 the whole
    // utilization dashboard — the Event Activity heatmap still renders off the
    // UTC-bucketed retry.
    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/Ciudad_Juarez" },
      InsightsPeriod.Month,
      NOW
    );

    expect(result.charts.activityHeatmap?.cells).toEqual([
      { day: "2026-06-08", hour: 9, human: 2, agent: 4 },
    ]);
  });

  it("buckets the raw event-volume query in the viewer's timezone (FEA-2881)", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
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
    installDb(db);

    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "+01:00" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
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
    installDb(db);

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "+05:30" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
    expect(raw.text).not.toContain("AT TIME ZONE");
    expect(raw.values).not.toContain("+05:30");
  });

  it("leaves the raw event-volume query UTC-bucketed when no timezone is set", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(ORG_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
    expect(raw.text).not.toContain("AT TIME ZONE");
  });

  it("scopes the raw event-volume query to the current user under me scope", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(ME_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.text).toContain("a.created_by_id");
    expect(raw.values).toContain(ORG);
    expect(raw.values).toContain(USER);
  });

  it("scopes the raw event-volume query to team membership under team scope", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(TEAM_CTX, InsightsPeriod.Quarter, NOW);

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
    expect(raw.text).toContain("a.organization_id");
    expect(raw.text).toContain("team_members");
    expect(raw.values).toContain(ORG);
    expect(raw.values).toContain(TEAM);
  });

  it("buckets the raw event-volume query in the caller's timezone (FEA-2880)", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
    // The DB truncation re-anchors the naive UTC timestamp to the requester's
    // zone before date_trunc, matching the sibling JS series / desktop localDay.
    expect(raw.text).toContain("AT TIME ZONE 'UTC' AT TIME ZONE");
    expect(raw.values).toContain("America/New_York");
  });

  it("enumerates event-volume points in the caller's local calendar (FEA-2880)", async () => {
    // A window edge straddling UTC midnight: the Week window opens at UTC
    // midnight on 2026-06-03, which in America/New_York (EDT, UTC-4) is 20:00 on
    // 2026-06-02, so the local calendar day it opens on is one earlier than the
    // UTC one.
    const nearMidnightNow = new Date("2026-06-09T02:00:00.000Z");
    const { db } = makeFakeDb({
      counts: () => 0,
      // A DB bucket keyed to the LOCAL opening day. It is only enumerated — and
      // so only surfaced — if eachDayKey walks the caller's zone, not UTC (whose
      // enumeration would start a day later at 2026-06-03 and drop this count).
      eventVolumeRows: [{ day: "2026-06-02", n: 5 }],
    });
    installDb(db);

    const result = await insightsService.getUtilization(
      { ...ORG_CTX, timeZone: "America/New_York" },
      InsightsPeriod.Week,
      nearMidnightNow
    );

    const points = result.charts.eventVolume?.points ?? [];
    expect(points[0]?.date).toBe("2026-06-02");
    expect(points.find((p) => p.date === "2026-06-02")?.values.events).toBe(5);
    // UTC enumeration would have run 2026-06-03…2026-06-09; the local walk stops
    // at the local end day (2026-06-08), so 2026-06-09 must be absent.
    expect(points.some((p) => p.date === "2026-06-09")).toBe(false);
  });

  it("fails the raw event-volume query closed when team scope lacks a teamId", async () => {
    const { db, rawQueries } = makeFakeDb({ counts: () => 0 });
    installDb(db);

    await insightsService.getUtilization(
      TEAM_CTX_WITHOUT_ID,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(rawQueries.length).toBeGreaterThan(0);
    const raw = findRawSql(rawQueries, "date_trunc('day', e.event_created_at");
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
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expectAllOrgScoped(wheres);
    // FEA-3638 — DB round-trip count for the agents endpoint's single
    // `Promise.all` fan-out. The agent-pipeline graph now reads node + edge rows
    // from one SQL statement, so the non-frustration path is 12 pooled reads.
    expect(vi.mocked(withDb).mock.calls.length).toBe(12);
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
    installDb(db);

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

    // FEA-3638 (Tier-2 collapse): status + type now roll up in a SINGLE unnest
    // round-trip (GROUPING SETS), not two. Assert exactly one such query fired,
    // and that it still carries the org scope predicate and binds the org id.
    const agentRaws = rawQueries
      .map((sql) => flattenRawSql(sql))
      .filter(
        (raw) =>
          raw.text.includes("jsonb_array_elements") &&
          raw.text.includes("GROUPING SETS")
      );
    expect(agentRaws).toHaveLength(1);
    expect(agentRaws[0]?.text).toContain("a.organization_id");
    expect(agentRaws[0]?.values).toContain(ORG);
  });

  it("builds the model-usage series from the DB-bucketed spend rows and scopes the raw query to the org", async () => {
    const { db, wheres, rawQueries } = makeFakeDb({
      // Spend-by-model breakdown ranks opus over sonnet (drives series order).
      tokenUsage: [
        { model: "opus", estimatedCost: 1.5 },
        { model: "sonnet", estimatedCost: 0.5 },
      ],
      // Pre-bucketed (day, model, cost, tokens) rows straight from the DB
      // date_trunc + SUMs. `tokens` = input+output+cache read/write (FEA-3497).
      modelUsageRows: [
        { day: "2026-06-08", model: "opus", cost: 1.5, tokens: 165 },
        { day: "2026-06-08", model: "sonnet", cost: 0.5, tokens: 55 },
      ],
    });
    installDb(db);

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

    // FEA-3497: the token series shares the SAME top-N model keys as spend, so
    // the $/# toggle only swaps y-values. Values are the summed token volume.
    const tokens = result.charts.modelTokensOverTime;
    expect(tokens?.series.map((s) => s.key)).toEqual(["opus", "sonnet"]);
    const tokenDay = tokens?.points.find((p) => p.date === "2026-06-08");
    expect(tokenDay?.values.opus).toBe(165);
    expect(tokenDay?.values.sonnet).toBe(55);

    // The token spend surfaces stay org-scoped; the raw per-day query carries the
    // org predicate, binds the org id (FEA-2876), and sums the token columns
    // (FEA-3497). Pinned by `AS tokens`: ISS-4463 fused a second read of this
    // table, and only this query emits that alias.
    expectAllOrgScoped(wheres);
    const tokenRaw = findRawSql(rawQueries, "AS tokens");
    expect(tokenRaw?.text).toContain("a.organization_id");
    expect(tokenRaw?.values).toContain(ORG);
    expect(tokenRaw?.text).toContain("input_tokens");
    expect(tokenRaw?.text).toContain("cache_write_tokens");
  });

  it("builds the tool-run series from the DB-bucketed sums and scopes the raw query to the org", async () => {
    const { db, wheres, rawQueries } = makeFakeDb({
      // Pre-bucketed (day, n) tool-run totals straight from the DB SUM.
      toolRunsByDayRows: [{ day: "2026-06-08", n: 42 }],
    });
    installDb(db);

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

  // ISS-7511 — scoped to what a fabricating fake can actually prove: the graph
  // is read in ONE round-trip over ONE unnest, the emitted SQL carries the org
  // predicate, and the node/edge rows map onto the response the way the service
  // says. The aggregation itself — the parent join's session equality, the
  // distinct-session count, the window bounds — is asserted against a real
  // Postgres in `agent-pipeline.integration.test.ts`, because this fake returns
  // the same rows whatever the statement says.
  it("reads the agent-pipeline graph in one org-scoped round-trip and maps its rows onto the response (FEA-3537)", async () => {
    const { db, rawQueries } = makeFakeDb({
      agentPipelineNodes: [
        {
          subagent_type: "reviewer",
          total: 10,
          completed: 8,
          errors: 2,
          sessions: 6,
          avg_duration: 120,
        },
        {
          subagent_type: "planner",
          total: 4,
          completed: 4,
          errors: 0,
          sessions: 4,
          avg_duration: null,
        },
      ],
      agentPipelineEdges: [
        { source: "planner", target: "reviewer", weight: 5 },
      ],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const pipeline = result.charts.agentPipeline;
    expect(pipeline?.nodes).toHaveLength(2);
    // successRate = completed / (completed + errors) * 100.
    expect(
      pipeline?.nodes.find((node) => node.subagentType === "reviewer")
    ).toMatchObject({
      total: 10,
      completed: 8,
      errors: 2,
      sessions: 6,
      successRate: 80,
      avgDuration: 120,
    });
    expect(
      pipeline?.nodes.find((node) => node.subagentType === "planner")
        ?.successRate
    ).toBe(100);
    expect(pipeline?.edges).toEqual([
      { source: "planner", target: "reviewer", weight: 5 },
    ]);

    const pipelineRaws = rawQueries
      .map((sql) => flattenRawSql(sql))
      .filter((raw) => raw.text.includes("WITH agent_rows AS MATERIALIZED"));
    expect(pipelineRaws).toHaveLength(1);
    const pipelineRaw = pipelineRaws[0];
    expect(pipelineRaw?.text).toContain("a.organization_id");
    expect(pipelineRaw?.values).toContain(ORG);
    expect(pipelineRaw?.text.match(/jsonb_array_elements/g)).toHaveLength(1);
    expect(pipelineRaw?.text).toContain(
      "p.external_agent_id = c.parent_external_agent_id"
    );
    expect(pipelineRaw?.text).not.toContain("AS c\n        CROSS JOIN");
  });

  it("falls back to UTC tool-run bucketing when Postgres rejects the requester timezone (FEA-2956)", async () => {
    const { db } = makeFakeDb({
      failTimeZoneToolRuns: true,
      // The UTC retry returns already-bucketed day rows.
      toolRunsByDayRows: [{ day: "2026-06-08", n: 7 }],
    });
    installDb(db);

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

  // FEA-4022: the frustration trend is org opt-in and normalized 0–100 against
  // the org population's observed max over the window.
  it("omits the frustration trend when the org has not opted in", async () => {
    const { db } = makeFakeDb({
      // Even with raw rows available, the gate is off → no trend query, no chart.
      frustrationEnabled: false,
      frustrationTrendRows: [
        { day: "2026-06-08", total: 40, sessions: 2, orgDayMax: 20 },
      ],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.charts.frustrationTrend).toBeUndefined();
  });

  it("normalizes the daily frustration mean to 0–100 against the population max when opted in", async () => {
    const { db, wheres } = makeFakeDb({
      frustrationEnabled: true,
      // Population max = MAX(orgDayMax) = 20. Day A mean = 40/2 = 20 → normalized
      // 100; Day B mean = 5/1 = 5 → normalized 25. NULL-raw sessions never reach
      // these rows (the query excludes them), so they neither dilute the mean
      // nor the max.
      frustrationTrendRows: [
        { day: "2026-06-08", total: 40, sessions: 2, orgDayMax: 20 },
        { day: "2026-06-09", total: 5, sessions: 1, orgDayMax: 5 },
      ],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const trend = result.charts.frustrationTrend;
    expect(trend).toBeDefined();
    expect(trend?.series[0]?.key).toBe("frustration");
    expect(
      trend?.points.find((point) => point.date === "2026-06-08")?.values
        .frustration
    ).toBe(100);
    expect(
      trend?.points.find((point) => point.date === "2026-06-09")?.values
        .frustration
    ).toBe(25);
    // Every SCORED value stays within the normalized band; gap days are null.
    for (const point of trend?.points ?? []) {
      const value = point.values.frustration;
      if (value === null) {
        continue;
      }
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    // Cross-org isolation: every read (including the trend + gate) is org-scoped.
    expectAllOrgScoped(wheres);
  });

  it("normalizes against the population MAX single-session raw, not the peak day mean", async () => {
    const { db } = makeFakeDb({
      frustrationEnabled: true,
      // Day A: two sessions raw 100 + 0 → mean 50, orgDayMax 100. Day B: one raw
      // 20 → mean 20, orgDayMax 20. Population max = MAX(orgDayMax) = 100, so Day
      // A normalizes to 50 (50/100) — NOT 100 (which is what normalizing against
      // the peak day-mean of 50 would wrongly produce).
      frustrationTrendRows: [
        { day: "2026-06-08", total: 100, sessions: 2, orgDayMax: 100 },
        { day: "2026-06-09", total: 20, sessions: 1, orgDayMax: 20 },
      ],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const trend = result.charts.frustrationTrend;
    expect(
      trend?.points.find((point) => point.date === "2026-06-08")?.values
        .frustration
    ).toBe(50);
    expect(
      trend?.points.find((point) => point.date === "2026-06-09")?.values
        .frustration
    ).toBe(20);
  });

  it("omits the frustration trend when opted in but no windowed session carries a raw signal", async () => {
    const { db } = makeFakeDb({
      frustrationEnabled: true,
      // No rows (all sessions NULL-raw / outside window) → population max is 0.
      frustrationTrendRows: [],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.charts.frustrationTrend).toBeUndefined();
  });

  it("fails open — omits the frustration chart (not a page-wide error) when its query throws", async () => {
    const { db } = makeFakeDb({
      frustrationEnabled: true,
      failFrustrationTrend: true,
    });
    installDb(db);

    // The whole Agents response still resolves; only the frustration widget is
    // omitted, so a slow/failing frustration aggregate cannot take down the
    // other Agents widgets.
    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(result.charts.frustrationTrend).toBeUndefined();
    // Other widgets still render.
    expect(result.kpis.length).toBeGreaterThan(0);
  });

  it("emits null (a gap) for a day with no scored sessions, not a false calm zero", async () => {
    const { db } = makeFakeDb({
      frustrationEnabled: true,
      // Day A scored (mean 20, orgDayMax 20 → normalized 100). Day B has NO row
      // (no scored session in the window), so the interpolated point must be a
      // null GAP — not a measured calm 0 that would draw a flat floor.
      frustrationTrendRows: [
        { day: "2026-06-08", total: 40, sessions: 2, orgDayMax: 20 },
      ],
    });
    installDb(db);

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const trend = result.charts.frustrationTrend;
    expect(trend).toBeDefined();
    const scored = trend?.points.find((point) => point.date === "2026-06-08");
    expect(scored?.values.frustration).toBe(100);
    // At least one interpolated gap day exists across the quarter window, and
    // every non-scored day is null (a gap), never 0.
    const gapPoints = (trend?.points ?? []).filter(
      (point) => point.date !== "2026-06-08"
    );
    expect(gapPoints.length).toBeGreaterThan(0);
    for (const point of gapPoints) {
      expect(point.values.frustration).toBeNull();
    }
  });
});

describe("me scope", () => {
  it("filters delivery by the current user and omits org-only tiles", async () => {
    const { db, wheres } = makeFakeDb({ counts: () => 0 });
    installDb(db);

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
    installDb(db);

    const result = await insightsService.getUtilization(
      ME_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const userIds: string[] = [];
    for (const where of wheres) {
      collectKey(where, "createdById", userIds);
    }
    expect(userIds.every((id) => id === USER)).toBe(true);
    expect(userIds.length).toBeGreaterThan(0);
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

describe.each(["getDelivery", "getUtilization"] as const)(
  "team scope: %s",
  (method) => {
    const teamKey = method === "getDelivery" ? "branchArtifact" : "artifact";
    const emptyScopeKey =
      method === "getDelivery" ? "branchArtifact" : "artifactId";
    it.each([
      ["filters with teamId", TEAM_CTX, teamKey, true],
      [
        "fails closed without teamId",
        TEAM_CTX_WITHOUT_ID,
        emptyScopeKey,
        false,
      ],
    ] as const)("%s", async (_title, ctx, scopeKey, hasTeam) => {
      const { db, wheres } = makeFakeDb({ counts: () => 0 });
      installDb(db);

      await insightsService[method](ctx, InsightsPeriod.Quarter, NOW);

      const teamIds: string[] = [];
      for (const where of wheres) {
        const scope = hasTeam
          ? (where as Record<string, unknown>)[scopeKey]
          : where;
        collectKey(scope, "teamId", teamIds);
      }
      if (hasTeam) {
        expect(teamIds.length).toBeGreaterThan(0);
        expect(teamIds.every((teamId) => teamId === TEAM)).toBe(true);
        return;
      }
      expect(
        wheres.some((where) =>
          hasEmptyInPredicate((where as Record<string, unknown>)[scopeKey])
        )
      ).toBe(true);
      expect(teamIds).toHaveLength(0);
    });
  }
);

describe("pure helpers", () => {
  it("resolvePeriodRange derives prior + trend windows", () => {
    const range = resolvePeriodRange(InsightsPeriod.Quarter, NOW);
    expect(range.end.toISOString()).toBe("2026-06-09T23:59:59.999Z");
    expect(range.start.toISOString()).toBe("2026-03-12T00:00:00.000Z");
    expect(range.priorStart?.toISOString()).toBe("2025-12-12T00:00:00.000Z");
    expect(range.trendStart).toEqual(range.start);
  });

  it("resolvePeriodRange has no prior window for all-time", () => {
    const range = resolvePeriodRange(InsightsPeriod.All, NOW);
    expect(range.priorStart).toBeNull();
    expect(range.start).toEqual(new Date(0));
    expect(range.trendStart.toISOString()).toBe("2026-03-12T00:00:00.000Z");
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

/**
 * ISS-11915 (operator ruling 2026-10-08): the two branch-population charts
 * count the Branches list's own population for the period. The fake DB has no
 * query engine, so the list's candidate read returns `populationIds` and these
 * cases pin what the service does with that read: the window it asks for, and
 * that every donut counts exactly that population. The window, eligibility and
 * Last-active semantics themselves are pinned against real Postgres by
 * `__tests__/integration/dashboard-branch-population-parity.integration.test.ts`.
 */
describe("ISS-11915 branch-population charts", () => {
  const POPULATION: BranchPopulationRow[] = [
    { id: "listed-pr", hasPr: true, checksStatus: ChecksStatus.PASSING },
    { id: "listed-no-pr", hasPr: false, checksStatus: ChecksStatus.FAILING },
    // A branch the list does not select: no donut may count it.
    { id: "unlisted", hasPr: true, checksStatus: ChecksStatus.UNKNOWN },
  ];

  function deliveryFor(period: InsightsPeriod) {
    const fake = makeFakeDb({
      branchListPopulationIds: ["listed-pr", "listed-no-pr"],
      counts: (where) => branchPrCountFrom(POPULATION, where) ?? 0,
      checkStatusGroupsFor: (where) => checkStatusGroupsFrom(POPULATION, where),
    });
    installDb(fake.db);
    return {
      fake,
      delivery: insightsService.getDelivery(ORG_CTX, period, NOW),
    };
  }

  function candidateReadValues(rawQueries: unknown[]): unknown[] {
    const candidate = rawQueries.find((sql) =>
      flattenRawSql(sql).text.includes("latest_activity_atom")
    );
    return flattenRawSql(candidate).values;
  }

  it("counts only the Branches list population in both donuts", async () => {
    const { delivery } = deliveryFor(InsightsPeriod.Week);
    const week = await delivery;

    expect(week.charts.checkStatus).toEqual([
      { key: ChecksStatus.PASSING, label: "Passing", value: 1 },
      { key: ChecksStatus.FAILING, label: "Failing", value: 1 },
    ]);
    expect(week.charts.branchesWithoutPr).toEqual([
      { key: "has-pr", label: "Has a pull request", value: 1 },
      { key: "no-pr", label: "No pull request", value: 1 },
    ]);
  });

  it("reads the population over the Branches list window for the period", async () => {
    const week = deliveryFor(InsightsPeriod.Week);
    await week.delivery;
    const all = deliveryFor(InsightsPeriod.All);
    await all.delivery;

    const listWindow = stableUtcListWindow(7, NOW);
    const weekValues = candidateReadValues(week.fake.rawQueries);
    expect(weekValues).toContainEqual(new Date(listWindow.startDate ?? ""));
    expect(weekValues).toContainEqual(new Date(listWindow.endDate ?? ""));
    // All time sends no bound at all, exactly as the list does.
    const allDates = candidateReadValues(all.fake.rawQueries).filter(
      (value) => value instanceof Date && value.getTime() !== NOW.getTime()
    );
    expect(allDates).toEqual([]);
  });
});

/** Route every `withDb(...)` the case under test issues through `db`. */
function installDb(db: unknown): void {
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
}
