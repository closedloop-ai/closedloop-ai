import {
  type DeliveryInsightsResponse,
  InsightsTileAvailabilityState,
  insightsPeriodDays,
} from "@closedloop-ai/loops-api/insights";
import { BranchCoverageBucketKey } from "@closedloop-ai/loops-api/insights-branch-coverage";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { InsightsPeriod } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import {
  type BranchSyncSource,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import {
  isDeliveryInsights,
  withLocalBranchCoverage,
} from "../src/main/dashboard/local-insights-branch-coverage.js";
import {
  type BranchListSnapshotRequest,
  readBranchListSnapshot,
} from "../src/main/database/branch-list-snapshot-read.js";
import { SHARED_BRANCHES_TRANSIENT_ERROR_CODE } from "../src/shared/shared-branches-contract.js";
import {
  type AcDb,
  insertPullRequestRow,
  seeder,
  withAcDb,
} from "./branch-reads-ac-test-helpers.js";
import {
  dbHostLifecycleThrowingSource,
  throwingSource,
} from "./shared-branches-test-helpers.js";

/**
 * ISS-12256 — the Local-mode Dashboard's Branch coverage chart counts the local
 * Branches list's own population for each range (operator ruling, ISS-11915:
 * "the Dashboard for 7 days has the same # of branches as the branches listing
 * page for 7 days"). The list side here is the Local Branches page's read:
 * `getSharedBranchesPageData` in server-page mode over the real
 * `branches.listSnapshot` read on SQLite.
 */

const NOW = new Date("2026-06-20T12:00:00.000Z");
const PERIODS = [
  InsightsPeriod.Week,
  InsightsPeriod.Month,
  InsightsPeriod.Quarter,
  InsightsPeriod.All,
] as const;

describe("withLocalBranchCoverage", () => {
  it.each(PERIODS)(
    "counts exactly the Local Branches page population for %s",
    (period) =>
      withAcDb(async (db) => {
        await seedBranches(db);
        const source = sourceOf(db);
        const snapshot = snapshotReader(db);
        const page = await getSharedBranchesPageData(
          source,
          {
            ...stableUtcListWindow(insightsPeriodDays(period), NOW),
            pageMode: BranchListPageMode.Server,
          },
          snapshot
        );

        const result = await withLocalBranchCoverage(
          emptyDelivery(),
          source,
          period,
          snapshot,
          NOW
        );

        const buckets = result.charts.branchesWithoutPr;
        expect(page.list.total).toBeGreaterThan(0);
        expect(buckets.reduce((sum, bucket) => sum + bucket.value, 0)).toBe(
          page.list.total
        );
      })
  );

  it("splits the population by pull request and marks the chart Available", () =>
    withAcDb(async (db) => {
      await seedBranches(db);

      const result = await withLocalBranchCoverage(
        emptyDelivery(),
        sourceOf(db),
        InsightsPeriod.Week,
        snapshotReader(db),
        NOW
      );

      expect(result.charts.branchesWithoutPr).toEqual([
        expect.objectContaining({
          key: BranchCoverageBucketKey.HasPullRequest,
          value: 1,
        }),
        expect.objectContaining({
          key: BranchCoverageBucketKey.NoPullRequest,
          value: 1,
        }),
      ]);
      expect(result.tileAvailability?.["chart:branchesWithoutPr"]).toBe(
        InsightsTileAvailabilityState.Available
      );
      expect(result.tileAvailability?.["chart:checkStatus"]).toBe(
        InsightsTileAvailabilityState.Unavailable
      );
    }));

  it("leaves the chart Unavailable when the list read fails", async () => {
    const delivery = emptyDelivery();

    const result = await withLocalBranchCoverage(
      delivery,
      throwingSource,
      InsightsPeriod.Week,
      unreachableSnapshot,
      NOW
    );

    expect(result).toBe(delivery);
    expect(result.tileAvailability?.["chart:branchesWithoutPr"]).toBe(
      InsightsTileAvailabilityState.Unavailable
    );
  });

  it("rethrows a db-host lifecycle failure so the IPC wrapper can redrive it", async () => {
    await expect(
      withLocalBranchCoverage(
        emptyDelivery(),
        dbHostLifecycleThrowingSource,
        InsightsPeriod.Week,
        unreachableSnapshot,
        NOW
      )
    ).rejects.toThrow(SHARED_BRANCHES_TRANSIENT_ERROR_CODE);
  });

  it("recognises only the Delivery section's shape", () => {
    expect(isDeliveryInsights(emptyDelivery())).toBe(true);
    expect(isDeliveryInsights({ kpis: [], charts: {} })).toBe(false);
    expect(isDeliveryInsights(null)).toBe(false);
  });
});

/** Two published branches on one session; only `with-pr` has a pull request. */
async function seedBranches(db: AcDb): Promise<void> {
  const seed = seeder(db);
  await seed.session("s1");
  for (const branch of ["with-pr", "no-pr"]) {
    const artifactId = await seed.branch({
      branch,
      firstPushedAt: "2026-06-18T10:00:00.000Z",
    });
    await seed.link({ session: "s1", artifactId, method: "git_push" });
  }
  await insertPullRequestRow(db, { id: "pr-1", branch: "with-pr" });
}

function sourceOf(db: AcDb): BranchSyncSource {
  return {
    prisma: db.prisma,
    readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
    readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
    syncSource: db.syncSource,
  };
}

function snapshotReader(db: AcDb) {
  return (request: BranchListSnapshotRequest) =>
    readBranchListSnapshot(db.prisma, request);
}

function unreachableSnapshot(): never {
  throw new Error("the list read fails before the snapshot");
}

function emptyDelivery(): DeliveryInsightsResponse {
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  return {
    kpis: [],
    tileAvailability: {
      "chart:branchesWithoutPr": unavailable,
      "chart:branchesWithoutPr:donut": unavailable,
      "chart:checkStatus": unavailable,
    },
    charts: {
      prTrend: { series: [], points: [] },
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}
