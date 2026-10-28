import { insightsPeriodDays } from "@closedloop-ai/loops-api/insights";
import { branchCoverageBuckets } from "@closedloop-ai/loops-api/insights-branch-coverage";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import type {
  CategoryBucket,
  DonutSlice,
  InsightsPeriod,
} from "@repo/api/src/types/insights";
import { ChecksStatus, type Prisma, withDb } from "@repo/database";
import { getBranchCandidateIds } from "@/app/branches/branch-candidate-read";
import {
  branchHasAnyPullRequestWhere,
  branchHasNoPullRequestWhere,
} from "@/app/branches/branch-canonical-pull-request";

/**
 * The two branch-population donut charts ("Check status", "Branch coverage")
 * for the Delivery insights section (ISS-4634). Extracted from `service.ts` so
 * the branch-population concern owns its own module rather than growing the
 * grandfathered composition root.
 *
 * Both charts window the branch POPULATION on the selected range but group by a
 * CURRENT-STATE attribute (checks status now, PR link now) — there is no per-day
 * history of either attribute, so windowing the attribute is not expressible and
 * would not be meaningful. The section reads "of the branches active in the last
 * N days, here is where they stand now".
 *
 * ISS-11915 (operator ruling, Marisol Ashgrove 2026-10-08): "We need the windowing
 * for 7 day, 30 day, 90 day to match what is on the branches listing page - so
 * that the Dashboard for 7 days has the same # of branches as the branches
 * listing page for 7 days." The population is therefore the Branches list's own
 * candidate read (`getBranchCandidateIds`): the same Product eligibility, the
 * same Last-active instant (atom, else linked sessions), and the same window
 * predicate, which keeps a Branch with no trustworthy or a future Last active
 * the way the list does. This supersedes the broader ISS-4634/ISS-8148
 * `branch_detail.last_activity_at` population and its flag-gated push-evidence
 * filter; the list's verified-publication gate now always applies.
 */
export type DashboardBranchPopulationWindow = {
  period: InsightsPeriod;
  now: Date;
};

/**
 * The Branch ids the Branches list selects for this Dashboard period. The
 * bounds are the ones the list sends for the same range (`stableUtcListWindow`).
 */
export function readDashboardBranchPopulationIds(
  organizationId: string,
  window: DashboardBranchPopulationWindow
): Promise<string[]> {
  const bounds = stableUtcListWindow(
    insightsPeriodDays(window.period),
    window.now
  );
  return readBranchListPopulationIds(organizationId, {
    evaluationNow: window.now,
    ...(bounds.startDate ? { startDate: new Date(bounds.startDate) } : {}),
    ...(bounds.endDate ? { endDate: new Date(bounds.endDate) } : {}),
  });
}

/**
 * The Branch ids the Branches list selects for one window, read through the
 * list's own candidate SQL (`getBranchCandidateIds`). The Org scope counts this
 * population exactly; `artifactScope` narrows the Me and Team scopes after it
 * is fixed.
 */
export async function readBranchListPopulationIds(
  organizationId: string,
  window: { startDate?: Date; endDate?: Date; evaluationNow: Date }
): Promise<string[]> {
  return await withDb((db) =>
    getBranchCandidateIds(db, organizationId, {
      limit: 1,
      offset: 0,
      ...window,
    })
  );
}

/** The check-status donut over the population {@link readDashboardBranchPopulationIds} read. */
export async function fetchCheckStatusBuckets(
  organizationId: string,
  populationIds: readonly string[]
): Promise<DonutSlice[]> {
  const counts = new Map<ChecksStatus, number>();
  await withDb(async (db) => {
    for (const ids of chunkIds(populationIds)) {
      const rows = await db.branchDetail.groupBy({
        by: ["checksStatus"],
        where: { organizationId, artifactId: { in: ids } },
        _count: { _all: true },
      });
      for (const row of rows) {
        counts.set(
          row.checksStatus,
          (counts.get(row.checksStatus) ?? 0) + row._count._all
        );
      }
    }
  });
  return [...counts].map(([status, value]) => ({
    key: status,
    label: CHECK_STATUS_LABELS[status],
    value,
  }));
}

/**
 * The branch-coverage donut ("has a PR" vs "no PR") over the population
 * {@link readDashboardBranchPopulationIds} read. `artifactScope` is the caller-resolved artifact-relation scope
 * predicate (org-wide, or authored by the user) — resolved in the composition
 * root and passed in so this module stays free of the scope-context type.
 */
export async function fetchBranchesWithoutPrBuckets(
  populationIds: readonly string[],
  artifactScope: Prisma.ArtifactWhereInput
): Promise<CategoryBucket[]> {
  let withPr = 0;
  let withoutPr = 0;
  await withDb(async (db) => {
    for (const ids of chunkIds(populationIds)) {
      // ISS-8153: "has a PR" keys on OWNED rows via the canonical predicates,
      // never the pointer (see branchHasAnyPullRequestWhere).
      const [chunkWithPr, chunkWithoutPr] = await Promise.all([
        db.branchDetail.count({
          where: {
            artifactId: { in: ids },
            artifact: artifactScope,
            AND: [branchHasAnyPullRequestWhere()],
          },
        }),
        db.branchDetail.count({
          where: {
            artifactId: { in: ids },
            artifact: artifactScope,
            AND: [branchHasNoPullRequestWhere()],
          },
        }),
      ]);
      withPr += chunkWithPr;
      withoutPr += chunkWithoutPr;
    }
  });
  return branchCoverageBuckets(withPr, withoutPr);
}

const CHECK_STATUS_LABELS: Record<ChecksStatus, string> = {
  [ChecksStatus.PASSING]: "Passing",
  [ChecksStatus.FAILING]: "Failing",
  [ChecksStatus.PENDING]: "Running",
  [ChecksStatus.UNKNOWN]: "Unknown",
};

/** Bounded `IN` lists, well under PostgreSQL's bind-parameter limit. */
const DASHBOARD_BRANCH_POPULATION_CHUNK_SIZE = 5000;

function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += DASHBOARD_BRANCH_POPULATION_CHUNK_SIZE
  ) {
    chunks.push(
      ids.slice(offset, offset + DASHBOARD_BRANCH_POPULATION_CHUNK_SIZE)
    );
  }
  return chunks;
}
