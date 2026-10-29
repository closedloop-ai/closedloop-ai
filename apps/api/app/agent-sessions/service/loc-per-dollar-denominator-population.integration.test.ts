import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
  linkValidSessionToBranch,
  type TestSessionCostColumns,
} from "@/__tests__/utils/db-helpers";
import { buildUsageSummary } from "./usage-summary";

/**
 * ISS-7705 AC3 — the LOC/$ DENOMINATOR's population, against real Postgres.
 *
 * The invariant, inherited from ISS-6543: every qualifying deduplicated session
 * cost enters the divisor, INCLUDING no-push/no-merge work. The ratio's two
 * sides are read from different populations on purpose — the numerator only
 * ever sees sessions that reached a merged PR — so the moment the divisor's own
 * predicate starts asking for that same evidence, sessions that cost real money
 * and shipped nothing fall out of the bottom of the fraction and LOC/$ inflates
 * without bound. That is the defect ISS-7705 exists to stop, and it lives in the
 * summary `where` (`buildUsageSummaryWhere` → `buildWhere`), not in the
 * coverage fold: the fold can only compare populations it is handed.
 *
 * The sibling suites prove the FOLD tolerates a divisor wider than the
 * numerator. Only this one proves the divisor the production query actually
 * builds IS that wider set, so it drives `buildUsageSummary` end to end and
 * reads the published summary — the same object the route serializes. A mocked
 * `withDb` cannot do that: the predicate under test is the thing being mocked
 * away, so any fake would return the same rows whether or not the `where`
 * narrowed.
 *
 * Runs inside `autoRollbackTransaction`, so nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Every seeded session is active inside this window; the summary selects on it. */
const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-31T23:59:59.999Z";
const IN_WINDOW = new Date("2026-07-10T09:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-05-02T09:00:00.000Z");
const MERGED_AT = new Date("2026-07-15T12:00:00.000Z");
const LAST_VERIFIED_AT = new Date("2026-07-15T13:00:00.000Z");

/** The merged PR's gross lines — the numerator the divisor is divided into. */
const PR_ADDITIONS = 600;
const PR_DELETIONS = 400;
const MERGED_LOC = PR_ADDITIONS + PR_DELETIONS;

/**
 * Metered spend with a revision stamp and no staged replacement: the shape that
 * reaches `apiEstimatedCost` (the divisor's ledger) and folds to `complete`, so
 * a failing assertion below is about POPULATION and never about ledger
 * classification or a coverage precedence rule.
 */
const SHIPPED_COST = 2;
const UNSHIPPED_COST = 6;
const OUT_OF_WINDOW_COST = 500;

function meteredCost(estimatedCost: number): TestSessionCostColumns {
  return { estimatedCost, billingMode: "api", dataRevision: 1 };
}

describeIfDb("LOC/$ denominator population (ISS-7705 AC3)", () => {
  it("divides by no-push session cost alongside the merged-PR session's", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, userId } = await seedOrgWithOwner();
      await seedMergedPrSessionAt(organizationId, userId, "shipped");
      // The whole point: this session pushed nothing, merged nothing, and is
      // reachable from no PR — and its spend is still the reader's spend.
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "no-push",
        sessionTimestamp: IN_WINDOW,
        cost: meteredCost(UNSHIPPED_COST),
      });

      const summary = await buildUsageSummary(usageInput(organizationId));

      expect(summary.totalSessions).toBe(2);
      expect(summary.apiEstimatedCost).toBe(SHIPPED_COST + UNSHIPPED_COST);
      // The published ratio, not a re-derivation of it: the divisor is the wider
      // cohort, so a narrowed `where` would raise this number rather than only
      // move a count nobody renders.
      expect(summary.mergedLocPerDollar).toBeCloseTo(
        MERGED_LOC / (SHIPPED_COST + UNSHIPPED_COST),
        6
      );
      // The two populations really are different sets — the numerator excludes
      // the no-push session that the denominator includes. Without this the
      // assertions above would also pass on a query that had collapsed both
      // sides onto the same cohort.
      expect(summary.mergedLocPerDollarCoverage).toMatchObject({
        state: LocPerDollarCoverageState.Complete,
        numeratorSessionCount: 1,
        denominatorSessionCount: 2,
        excludedSessionCount: 0,
      });
    });
  });

  it("keeps a no-push session outside the window out of the divisor", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, userId } = await seedOrgWithOwner();
      await seedMergedPrSessionAt(organizationId, userId, "shipped");
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "no-push-in",
        sessionTimestamp: IN_WINDOW,
        cost: meteredCost(UNSHIPPED_COST),
      });
      // The positive sibling for the case above: the divisor is "qualifying
      // sessions in the window", not "every session". If it were ignoring the
      // predicate altogether, the first case would be green for the wrong
      // reason and this one would fail.
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "no-push-out",
        sessionTimestamp: BEFORE_WINDOW,
        cost: meteredCost(OUT_OF_WINDOW_COST),
      });

      const summary = await buildUsageSummary(usageInput(organizationId));

      expect(summary.totalSessions).toBe(2);
      expect(summary.apiEstimatedCost).toBe(SHIPPED_COST + UNSHIPPED_COST);
    });
  });

  it("counts a session that reached two merged PRs once in the numerator cohort", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, userId } = await seedOrgWithOwner();
      const first = await seedMergedPrBranch(organizationId, "dedup-a");
      const second = await seedMergedPrBranch(organizationId, "dedup-b");
      const sessionArtifactId = await linkValidSessionToBranch({
        organizationId,
        userId,
        branchArtifactId: first,
        label: "dedup",
        sessionTimestamp: IN_WINDOW,
        linkKind: SessionArtifactLinkKind.SessionPr,
        cost: meteredCost(SHIPPED_COST),
      });
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId: sessionArtifactId,
            targetId: second,
            linkType: LinkType.RelatesTo,
            metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
          },
        })
      );

      const summary = await buildUsageSummary(usageInput(organizationId));

      // BE PRECISE ABOUT WHICH HALF THIS PINS. The DIVISOR cannot double-count a
      // session for reaching two PRs, and no change to the summary `where` can
      // make it: both denominator reads are aggregates over `SessionDetail` rows
      // keyed on the artifact primary key, and the link graph enters only through
      // Prisma relation filters, which compile to semi-joins and cannot fan a row
      // out. So `totalSessions` and `apiEstimatedCost` are positive siblings here
      // — they prove the fixture really is one session at one cost — and NOT the
      // property under test.
      //
      // What CAN drift, and is what this case pins, is the NUMERATOR cohort's
      // session identity: the coverage probe resolves that cohort from
      // `ArtifactLink` rows, where two links to two branches really are two rows.
      // Counting links instead of distinct sessions inflates the numerator past a
      // divisor that is correct, and the gate then reports `missing` on a fully
      // covered org — a fail-closed gate faulting the ratio it was built to
      // protect. The verdict is asserted alongside the count so that flip is what
      // reds, not just an unrendered number.
      expect(summary.totalSessions).toBe(1);
      expect(summary.apiEstimatedCost).toBe(SHIPPED_COST);
      expect(summary.mergedPrCount).toBe(2);
      expect(summary.mergedLocPerDollarCoverage).toMatchObject({
        state: LocPerDollarCoverageState.Complete,
        numeratorSessionCount: 1,
        denominatorSessionCount: 1,
        excludedSessionCount: 0,
      });
    });
  });
});

/** The usage read the Sessions summary bar issues for the seeded window. */
function usageInput(organizationId: string) {
  return {
    organizationId,
    filters: { startDate: WINDOW_START, endDate: WINDOW_END },
  };
}

async function seedOrgWithOwner(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  return { organizationId, userId: owner.id };
}

/** A branch artifact carrying one merged, current, verified PR. */
async function seedMergedPrBranch(
  organizationId: string,
  label: string
): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${label}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: `acme/${label}`,
        branchName: label,
      },
      select: { artifactId: true },
    });
    const pr = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        number: 1,
        repositoryFullName: `acme/${label}`,
        prState: GitHubPRState.Merged,
        mergedAt: MERGED_AT,
        additions: PR_ADDITIONS,
        deletions: PR_DELETIONS,
        isCurrent: true,
        lastVerifiedAt: LAST_VERIFIED_AT,
      },
      select: { id: true },
    });
    await db.branchDetail.update({
      where: { artifactId: branch.id },
      data: { currentPullRequestDetailId: pr.id },
      select: { artifactId: true },
    });
    return branch.id;
  });
}

/** A merged-PR branch plus the in-window session that shipped it. */
async function seedMergedPrSessionAt(
  organizationId: string,
  userId: string,
  label: string
): Promise<string> {
  const branchArtifactId = await seedMergedPrBranch(organizationId, label);
  return await linkValidSessionToBranch({
    organizationId,
    userId,
    branchArtifactId,
    label,
    sessionTimestamp: IN_WINDOW,
    linkKind: SessionArtifactLinkKind.SessionPr,
    cost: meteredCost(SHIPPED_COST),
  });
}
