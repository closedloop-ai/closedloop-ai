import { IssueStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import {
  hasDatabase,
  seedArtifact,
  seedBlocksEdge,
} from "@/app/documents/__tests__/blocked-dependent-fixtures";
import { blockedDependentUnblockService } from "@/app/documents/blocked-dependent-unblock-service";

/**
 * ISS-11104 — the harness must refuse a case it cannot honestly cover.
 *
 * `autoRollbackTransaction` opens ONE interactive transaction around the whole
 * case, so every nested `withDb.tx` joins it and its `maxWait`/`timeout` are
 * discarded (`packages/database/index.ts`). A service that deliberately opens
 * one short transaction per chunk therefore runs as one `BEGIN … ROLLBACK`, and
 * the case cannot fail if those boundaries are deleted — a false green over the
 * single property they exist for. Found on PR #7716 / ISS-7797, where the
 * collapse surfaced as a `P2028` that read like a service defect.
 *
 * These cases drive the REAL wrapper against a real database, because the claim
 * is about the wrapper and not about the observer seam underneath it (that one
 * is `packages/database/__tests__/withdb-transaction-semantics.test.ts`).
 */

const describeIfDb = hasDatabase ? describe : describe.skip;

const COLLAPSE_REFUSAL = /nested withDb\.tx call\(s\) asked for their own/;

/**
 * A nested budget for these cases to ask for. Deliberately FAR below the
 * integration tier's own `testTimeout`: `integration-suite-timeout-budget`
 * reads every declared bound in the tier and treats one equal to the tier's
 * number as over budget, so a 30s literal here fails that guard rather than
 * this one. What is under test is that the budget was asked for and discarded,
 * never its size.
 */
const NESTED_BUDGET_MS = { timeout: 1000 } as const;

describeIfDb("autoRollbackTransaction — collapsed transaction boundary", () => {
  it("refuses a case whose production path opened its own chunk transaction, naming it", async () => {
    const tracker = createCommittedTestOrganizationTracker();
    try {
      const organizationId = await tracker.create();
      const blockerId = await seedBlockedPair(organizationId);

      // The shape the ticket is about: a real service that budgets each chunk,
      // driven inside the ambient wrapper. Green before this guard existed.
      let message = "";
      await autoRollbackTransaction(() =>
        blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        })
      ).catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
      });

      expect(message).toMatch(COLLAPSE_REFUSAL);
      // The site named must be the PRODUCTION caller, not the two frames that
      // are the same on every discard — otherwise a reader is pointed at the
      // helper rather than at the code that asked for the budget.
      expect(message).toContain("blocked-dependent-unblock-service");
      expect(message).not.toContain("db-helpers");
      expect(message).not.toContain("packages/database/");
    } finally {
      await tracker.cleanup();
    }
  });

  it("names the discarded budget", async () => {
    let message = "";
    await autoRollbackTransaction(() =>
      withDb.tx(() => Promise.resolve(null), NESTED_BUDGET_MS)
    ).catch((error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    });

    expect(message).toContain(`timeout=${NESTED_BUDGET_MS.timeout}`);
  });

  it("accepts the case when the call site states why joining is correct", async () => {
    // The sanctioned escape: joining IS the behaviour under test, said out loud.
    const joined = await autoRollbackTransaction(
      () => withDb.tx(() => Promise.resolve("joined"), NESTED_BUDGET_MS),
      {
        ambientBoundaryCollapseAcceptedBecause:
          "this case asserts the join itself, not a per-chunk boundary",
      }
    );

    expect(joined).toBe("joined");
  });

  it("refuses a blank reason, which states nothing at all", async () => {
    let message = "";
    await autoRollbackTransaction(
      () => withDb.tx(() => Promise.resolve("joined"), NESTED_BUDGET_MS),
      { ambientBoundaryCollapseAcceptedBecause: "   \n\t " }
    ).catch((error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    });

    expect(message).toMatch(COLLAPSE_REFUSAL);
  });

  it("leaves a case that asks for no nested budget alone", async () => {
    const organizationId = await autoRollbackTransaction(() =>
      createTestOrganization()
    );

    expect(organizationId).toBeTruthy();
  });

  it("does not mask the body's own failure with its refusal", async () => {
    // The guard runs only after the body succeeded, so the failure a reader is
    // shown is always the real one.
    await expect(
      autoRollbackTransaction(async () => {
        await withDb.tx(() => Promise.resolve(null), NESTED_BUDGET_MS);
        throw new Error("the assertion the case actually cares about");
      })
    ).rejects.toThrow("the assertion the case actually cares about");
  });
});

/** One BLOCKED dependent behind one terminal blocker; returns the blocker. */
async function seedBlockedPair(organizationId: string): Promise<string> {
  const blockerId = await seedArtifact({
    organizationId,
    status: IssueStatus.Done,
  });
  const dependentId = await seedArtifact({
    organizationId,
    status: IssueStatus.Blocked,
  });
  await seedBlocksEdge({
    organizationId,
    sourceId: blockerId,
    targetId: dependentId,
  });
  return blockerId;
}
