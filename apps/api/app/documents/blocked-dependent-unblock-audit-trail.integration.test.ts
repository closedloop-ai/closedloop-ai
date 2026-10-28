import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { IssueStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import {
  hasDatabase,
  readStatus,
  seedArtifact,
  seedBlocksEdge,
} from "./__tests__/blocked-dependent-fixtures";
import { blockedDependentUnblockService } from "./blocked-dependent-unblock-service";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the audit rows the sweep emits, not the per-chunk commit boundary; the boundary itself, including the status-write/receipt atomicity this suite's own entry point relies on, is covered by the committed fixture in app/documents/blocked-dependent-unblock-chunk-boundary.integration.test.ts"
);

/**
 * ISS-9632 — the BACKFILL produces the same audit trail as the forward path
 * (whitlockk, ISS-9632 review).
 *
 * `reconcileStaleBlockedArtifacts` moved statuses without recording anything, so
 * a reader of an artifact's history saw it leave `BLOCKED` with no actor and no
 * event — indistinguishable from a bug, and on the one run where "who moved
 * this?" is most likely to be asked. This asserts the persisted rows, not that a
 * capture helper was called: the row IS the contract.
 */

const describeIfDb = hasDatabase ? describe : describe.skip;

type ActivityRow = {
  artifactId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  before: unknown;
  after: unknown;
};

function readUnblockActivity(
  organizationId: string,
  artifactIds: string[]
): Promise<ActivityRow[]> {
  return withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: { organizationId, artifactId: { in: artifactIds } },
      select: {
        artifactId: true,
        actorType: true,
        actorId: true,
        action: true,
        before: true,
        after: true,
      },
    })
  );
}

describeIfDb("stale BLOCKED reconciliation — audit trail", () => {
  it("records a system-attributed status_change for every row it moved", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
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

      const outcome =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        });

      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
      expect(await readUnblockActivity(organizationId, [dependentId])).toEqual([
        {
          artifactId: dependentId,
          actorType: ArtifactActivityActorType.System,
          actorId: null,
          action: ArtifactActivityAction.StatusChange,
          before: IssueStatus.Blocked,
          after: IssueStatus.Todo,
        },
      ]);
    });
  });

  it("records nothing for a row it examined but did not move", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const liveBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const heldDependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: liveBlockerId,
        targetId: heldDependentId,
      });

      const outcome =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        });

      expect(outcome.scanned).toBe(1);
      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(heldDependentId)).toBe(IssueStatus.Blocked);
      // An event here would claim a transition that never happened.
      expect(
        await readUnblockActivity(organizationId, [heldDependentId])
      ).toEqual([]);
    });
  });

  it("writes nothing on the preview pass, including no audit rows", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
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

      const outcome =
        await blockedDependentUnblockService.previewStaleBlockedArtifacts({
          organizationId,
        });

      expect(outcome.resolvedIds).toEqual([dependentId]);
      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
      expect(await readUnblockActivity(organizationId, [dependentId])).toEqual(
        []
      );
    });
  });
});
