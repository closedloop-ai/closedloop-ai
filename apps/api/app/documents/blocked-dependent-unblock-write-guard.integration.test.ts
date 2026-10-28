import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { type ArtifactSubtype, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * ISS-9632 — the unblock write re-asserts the BLOCKER RULE, not just the status
 * (whitlockk, ISS-9632 review).
 *
 * Re-asserting `status = BLOCKED` alone left a real window: between the graph
 * read and the update, a blocker can be REOPENED out of a terminal status, or a
 * brand-new live `BLOCKS` edge can be inserted. Either one used to land the
 * dependent in `TODO` with a live blocker still attached — and irrecoverably,
 * because both the forward path and the sweep only ever reconsider rows that are
 * CURRENTLY `BLOCKED`.
 *
 * These cases stage exactly that interleaving. `selectUnblockableIds` is the
 * last thing the READ half does, so wrapping it lets the test commit a change
 * after the resolver has decided and before the update runs — the read's view is
 * genuinely stale by the time the write executes. The wrapper only controls
 * TIMING; the real function still decides, the real Postgres still evaluates the
 * `where`, and the assertions are on persisted status. A query double would
 * report any `where` clause green, so this tier has to be DB-backed.
 */

const describeIfDb = hasDatabase ? describe : describe.skip;

const beforeWrite = vi.hoisted(() => ({
  run: null as null | (() => Promise<unknown>),
}));

vi.mock("./blocked-dependent-resolution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./blocked-dependent-resolution")>();
  return {
    ...actual,
    selectUnblockableIds: async (
      params: Parameters<typeof actual.selectUnblockableIds>[0]
    ) => {
      const resolved = actual.selectUnblockableIds(params);
      await beforeWrite.run?.();
      return resolved;
    },
  };
});

import { blockedDependentUnblockService } from "./blocked-dependent-unblock-service";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the guarded write's predicate at write time, and the ambient transaction is what lets them interleave a competing write; the per-chunk boundary and its receipt atomicity are covered by the committed fixture in app/documents/blocked-dependent-unblock-chunk-boundary.integration.test.ts"
);

async function setStatus(id: string, status: string): Promise<void> {
  await withDb((db) => db.artifact.update({ where: { id }, data: { status } }));
}

describeIfDb("unblock write guard — the blocker rule at write time", () => {
  afterEach(() => {
    beforeWrite.run = null;
  });

  it("declines the dependent when its blocker is REOPENED between the read and the write", async () => {
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

      // The resolver sees a terminal blocker and resolves the dependent. The
      // blocker then goes back to IN_PROGRESS, before the update runs.
      beforeWrite.run = () => setStatus(blockerId, IssueStatus.InProgress);

      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      // Resolved by the stale read, DECLINED by the write.
      expect(outcome.resolvedIds).toEqual([dependentId]);
      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("declines the dependent when a NEW live BLOCKS edge lands between the read and the write", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const lateBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
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

      // Nothing about the blocker the resolver looked at changes; a SECOND,
      // live blocker is attached after it decided.
      beforeWrite.run = () =>
        seedBlocksEdge({
          organizationId,
          sourceId: lateBlockerId,
          targetId: dependentId,
        });

      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.resolvedIds).toEqual([dependentId]);
      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("declines a dependent whose late blocker belongs to ANOTHER organization", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      // Terminal in ITS OWN org. The write must still refuse: an artifact this
      // org cannot read may not certify that this org's work is ready.
      const foreignBlockerId = await seedArtifact({
        organizationId: otherOrganizationId,
        status: IssueStatus.Done,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: blockerId,
        targetId: dependentId,
      });

      beforeWrite.run = () =>
        seedBlocksEdge({
          organizationId,
          sourceId: foreignBlockerId,
          targetId: dependentId,
        });

      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("declines a dependent whose late blocker is a non-terminal DOCUMENT-lifecycle artifact", async () => {
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
      // A PRD in DRAFT. `DONE` is not in its vocabulary at all, so the write's
      // predicate has to pick the DOCUMENT terminal set for it — reading it
      // against the Issue set would classify DRAFT as resolved.
      const draftPrdId = await seedArtifact({
        organizationId,
        status: DocumentStatus.Draft,
        subtype: DocumentType.Prd as ArtifactSubtype,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: blockerId,
        targetId: dependentId,
      });

      beforeWrite.run = () =>
        seedBlocksEdge({
          organizationId,
          sourceId: draftPrdId,
          targetId: dependentId,
        });

      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("still writes when nothing changed between the read and the write", async () => {
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
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      // The guard must not be a blanket refusal — the feature still has to work.
      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
    });
  });
});
