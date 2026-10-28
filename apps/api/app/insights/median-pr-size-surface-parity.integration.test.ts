import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { InsightsScope } from "@repo/api/src/types/insights";
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
import { readDeliveryPullRequestFacts } from "./delivery-pull-request-facts";

/**
 * ISS-11589 — COMMON-014 parity for "Median PR size": the Insights dashboard
 * and the Branches card must publish one number for one population.
 *
 * The fixture carries the two twin flavours the schema permits: an App-owned
 * row with its unsized repo-less twin, and an App-owned row whose sized
 * repo-less twin DISAGREES. A fixture without a twin cannot tell the shared
 * resolution from its absence. Both surfaces read the same SQL over the same
 * cohort, so a divergence here is a divergence in what they pass it.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const DAY = 86_400_000;
const REPOSITORY = "acme/web";
const OUTSIDE_COHORT_PR_NUMBER = 90;
const OUTSIDE_COHORT_PR_LINES = 9000;

type FixtureRow = {
  number: number;
  additions: number | null;
  deletions: number | null;
  owned: boolean;
  repositoryFullName: string;
};

const FIXTURE_ROWS: readonly FixtureRow[] = [
  row(1, 500, true),
  row(1, null, false, REPOSITORY.toUpperCase()),
  row(2, 100, true),
  // Both sized, and they disagree. The App-owned row's numbers win.
  row(2, 7, false, REPOSITORY.toUpperCase()),
  row(3, 20, false),
  // Genuinely unsized and untwinned, so the card reports short coverage.
  row(4, null, false),
];

describeIfDb("Median PR size — dashboard and Branches card parity", () => {
  it("publishes one value, resolving twins rather than erasing them", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    await withDb(async (db) => {
      for (const [index, fixture] of FIXTURE_ROWS.entries()) {
        const name = `parity-${index}`;
        const branchId = await createBranchArtifact(db, organizationId, name, {
          firstPushedAt: ACTIVITY_AT,
        });
        await linkValidSession(db, organizationId, branchId, name, user.id);
        await createCountedPullRequest(db, organizationId, branchId, {
          number: fixture.number,
          repositoryFullName: fixture.repositoryFullName,
          additions: fixture.additions,
          deletions: fixture.deletions,
          ...(fixture.owned ? { githubId: `PR_node_${fixture.number}` } : {}),
          mergedAt: ACTIVITY_AT,
        });
      }
      // Merged inside the window but on a branch no session contributed to, so
      // it is in the org's population and outside the cohort (ISS-11589 AC 3).
      const outsideCohort = await createBranchArtifact(
        db,
        organizationId,
        "parity-outside-cohort",
        { firstPushedAt: ACTIVITY_AT }
      );
      await createCountedPullRequest(db, organizationId, outsideCohort, {
        number: OUTSIDE_COHORT_PR_NUMBER,
        repositoryFullName: REPOSITORY,
        additions: OUTSIDE_COHORT_PR_LINES,
        deletions: 0,
        githubId: `PR_node_${OUTSIDE_COHORT_PR_NUMBER}`,
        mergedAt: ACTIVITY_AT,
      });
    });

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );
    const dashboard = await readDeliveryPullRequestFacts(
      { organizationId, userId: user.id, scope: InsightsScope.Org },
      {
        start: new Date(0),
        end: new Date(Date.now() + DAY),
        priorStart: null,
        priorEnd: new Date(0),
      }
    );

    expect(dashboard.medianSize).toBe(100);
    expect(analytics.canonicalMetrics?.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: dashboard.medianSize,
      coverage: { included: 3, total: 4 },
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
    // ISS-11589 / B2: the dashboard's caption operands come from THIS fold, so
    // the two surfaces size the same count out of the same population — the
    // contract `median-pr-size-surface-parity.test.ts` used to pin.
    expect({ sized: dashboard.sized, merged: dashboard.merged }).toEqual({
      sized: 3,
      merged: 4,
    });
  });
});

function row(
  number: number,
  additions: number | null,
  owned: boolean,
  repositoryFullName: string = REPOSITORY
): FixtureRow {
  return {
    number,
    additions,
    deletions: additions === null ? null : 0,
    owned,
    repositoryFullName,
  };
}
