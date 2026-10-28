import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditDataInvariants,
  type InvariantCheckResult,
} from "@/app/cron/audit-data-invariants/service";
import { HAS_DATABASE, seedBranch } from "../utils/branch-identity-sql-fixture";
import {
  autoRollbackTransaction,
  linkValidSessionToBranch,
} from "../utils/db-helpers";
import {
  METERED_BILLING_MODE,
  type Owner,
  recordSessionWork,
  type SessionShape,
  STILL_COUNTED_ERROR_FLAG_CASES,
  seedOwner,
} from "./zero-cost-audit.test-helpers";

/**
 * ISS-12142 — the zero-cost BRANCHES audit applies ISS-10833's exclusion: a
 * branch whose only zero-cost metered sessions recorded no token usage and
 * ended on a recorded provider error stops counting; every other zero-cost
 * metered session still makes its branch count.
 *
 * The audit counts the whole table, so each case reads the count before and
 * after seeding inside one rolled-back transaction and asserts the delta.
 */
describe.skipIf(!HAS_DATABASE)("zero-cost branches audit", () => {
  it("leaves out a branch whose only zero-cost session is error-ended with no usage, and counts one with a non-error zero-cost session", async () => {
    await autoRollbackTransaction(async () => {
      const owner = await seedOwner();
      const baseline = await zeroCostBranches();

      const errorEndedBranch = await seedBranchWithMeteredSession(owner, {
        endsWithError: true,
      });
      const afterErrorEnded = await zeroCostBranches();
      expect(afterErrorEnded.count).toBe(baseline.count);
      expect(afterErrorEnded.sampleIds).not.toContain(errorEndedBranch);

      await seedBranchWithMeteredSession(owner, { endsWithError: false });
      expect((await zeroCostBranches()).count).toBe(baseline.count + 1);
    });
  });

  it.each(STILL_COUNTED_ERROR_FLAG_CASES)(
    "a branch whose zero-cost metered session $label changes the count by $delta",
    async ({ shape, delta }) => {
      await autoRollbackTransaction(async () => {
        const owner = await seedOwner();
        const baseline = await zeroCostBranches();

        await seedBranchWithMeteredSession(owner, shape);

        expect((await zeroCostBranches()).count).toBe(baseline.count + delta);
      });
    }
  );
});

async function zeroCostBranches(): Promise<InvariantCheckResult> {
  return (await auditDataInvariants()).zeroCostBranches;
}

async function seedBranchWithMeteredSession(
  owner: Owner,
  shape: SessionShape
): Promise<string> {
  const branchArtifactId = await seedBranch(
    owner.organizationId,
    `zero-cost-audit-${randomUUID().slice(0, 8)}`,
    { firstPushedAt: null }
  );
  const sessionArtifactId = await linkValidSessionToBranch({
    ...owner,
    branchArtifactId,
    label: "zero-cost-branches-audit",
    endsWithError: shape.endsWithError,
    cost: {
      billingMode: METERED_BILLING_MODE,
      estimatedCost: shape.estimatedCost ?? null,
    },
  });
  await recordSessionWork(sessionArtifactId, shape);
  return branchArtifactId;
}
