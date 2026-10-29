import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_AT,
  createBranchArtifact,
  createCountedPullRequest,
  linkValidSession,
} from "@/__tests__/support/branches/visible-branch.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";
import { insightsService } from "./service";
import { resolvePeriodRange } from "./service/period";

/**
 * ISS-12408 — COMMON-014 parity for "Merged PRs" and "Merge rate": the Insights
 * dashboard and the Branches card publish one number for one population.
 *
 * The fixture is built from the cases the dashboard used to get differently:
 * a closed-unmerged PR windowed on its own `closed_at` (the dashboard used the
 * branch's creation time, so a branch created long ago hid it and a branch
 * created in the window admitted a PR closed months earlier), a PR on a branch
 * the Product gate excludes (the dashboard only required that a session wrote
 * to it), and a merge in the prior window. Both surfaces read the same SQL over
 * the same cohort, so a divergence here is a divergence in what they pass it.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const NOW = new Date("2026-07-20T12:00:00.000Z");
const DAY = 86_400_000;
const LONG_AGO = new Date("2025-01-01T00:00:00.000Z");
const REPOSITORY = "acme/web";

type Fixture = {
  branch: string;
  /** The Branch carries publication evidence, so the Product gate admits it. */
  eligible: boolean;
  createdAt?: Date;
  number: number;
  mergedAt?: Date;
  closedAt?: Date;
};

const FIXTURES: readonly Fixture[] = [
  // Merged in the window.
  fixture("merged-a", 1, { mergedAt: at("2026-07-05") }),
  fixture("merged-b", 2, { mergedAt: at("2026-07-10") }),
  // Closed unmerged in the window, on a branch created in the window.
  fixture("closed-new", 3, { closedAt: at("2026-07-12") }),
  // Closed unmerged in the window, on a branch created long ago: the dashboard's
  // creation-time window dropped it.
  fixture("closed-old-branch", 4, {
    closedAt: at("2026-07-08"),
    createdAt: LONG_AGO,
  }),
  // Closed unmerged months before the window, on a branch created in it: the
  // creation-time window counted it.
  fixture("closed-stale", 5, { closedAt: at("2026-04-01") }),
  // Merged in the prior window.
  fixture("merged-prior", 6, { mergedAt: at("2026-06-01") }),
  // Merged before both windows: it counts nowhere, and makes the prior period a
  // full one so the dashboard shows the delta at all (FEA-2233).
  fixture("merged-old", 8, { mergedAt: at("2026-03-01") }),
  // Merged in the window on a Branch the Product gate excludes.
  fixture("merged-ungated", 7, { mergedAt: at("2026-07-06"), eligible: false }),
];

describeIfDb(
  "Merged PRs and Merge rate — dashboard and Branches card parity",
  () => {
    it("publishes one count and one rate, windowing a closed PR on its own closed_at", async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      await withDb(async (db) => {
        for (const entry of FIXTURES) {
          const branchId = await createBranchArtifact(
            db,
            organizationId,
            entry.branch,
            { firstPushedAt: entry.eligible ? ACTIVITY_AT : null }
          );
          if (entry.createdAt) {
            await db.artifact.update({
              where: { id: branchId },
              data: { createdAt: entry.createdAt },
              select: { id: true },
            });
          }
          await linkValidSession(
            db,
            organizationId,
            branchId,
            entry.branch,
            user.id
          );
          await createCountedPullRequest(db, organizationId, branchId, {
            number: entry.number,
            repositoryFullName: REPOSITORY,
            additions: 10,
            deletions: 0,
            ...(entry.mergedAt ? { mergedAt: entry.mergedAt } : {}),
            ...(entry.closedAt ? { closedAt: entry.closedAt } : {}),
          });
        }
      });

      const range = resolvePeriodRange(InsightsPeriod.Month, NOW);
      const dashboard = await insightsService.getDelivery(
        { organizationId, userId: user.id, scope: InsightsScope.Org },
        InsightsPeriod.Month,
        NOW
      );
      const card = await branchReadService.getBranchAnalytics(organizationId, {
        limit: 50,
        offset: 0,
        startDate: range.start,
        endDate: range.end,
      });

      // Two merged in the window (the ungated one is out), two closed unmerged in
      // it (the stale one is out), so the decided rate is 2 / 4.
      expect(kpiValue(dashboard.kpis, "merged")).toBe(2);
      expect(kpiValue(dashboard.kpis, "mergedCount")).toBe(2);
      expect(kpiValue(dashboard.kpis, "merge-rate")).toBe(50);
      expect(complete(card.canonicalMetrics?.mergeRatePct.current)).toBe(50);
      expect(kpiValue(dashboard.kpis, "merge-rate")).toBe(
        card.canonicalMetrics?.mergeRatePct.current.value
      );

      // One merge in the prior window, so the tile's delta is +100%.
      expect(dashboard.kpis.find((kpi) => kpi.key === "merged")?.deltaPct).toBe(
        100
      );
      expect(dashboard.charts.prByState).toEqual([
        expect.objectContaining({ value: 2 }),
      ]);
    });
  }
);

function fixture(
  branch: string,
  number: number,
  overrides: Partial<Fixture>
): Fixture {
  return { branch, eligible: true, number, ...overrides };
}

function at(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + DAY / 2);
}

function kpiValue(
  kpis: readonly { key: string; value: number | null }[],
  key: string
): number | null | undefined {
  return kpis.find((kpi) => kpi.key === key)?.value;
}

function complete(result: BranchMetricResult<number> | undefined) {
  return result?.state === BranchMetricAvailability.Complete
    ? result.value
    : null;
}
