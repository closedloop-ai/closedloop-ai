import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import {
  hasDatabase,
  readStatus,
  seedArtifact,
  seedBlockedFanOut,
  seedBlocksEdge,
  terminalize,
} from "./__tests__/blocked-dependent-fixtures";
import {
  blockedDependentUnblockService,
  UNBLOCK_CANDIDATE_CHUNK_SIZE,
} from "./blocked-dependent-unblock-service";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the resolver's where-clauses, org scope, and page walk — never the per-chunk commit boundary, which has its own committed fixture in blocked-dependent-unblock-chunk-boundary.integration.test.ts"
);

/**
 * ISS-9632 — DB-backed coverage for auto-clearing stale `BLOCKED` artifacts.
 *
 * Real Postgres via `withDb` (self-skips when DATABASE_URL is unset), with the
 * wide write case using an isolated persisted fixture so the resolver can run
 * each chunk as its own atomic statement. The whole point of putting these on a real
 * database is that the `where` clauses are what decide the outcome — the
 * `status = BLOCKED` narrowing, the org scope, and the `linkType = BLOCKS`
 * narrowing. A query mock that ignored its own `where` would report every one
 * of them green. The write guard's own predicate gets its interleaved cases in
 * `blocked-dependent-unblock-write-guard.integration.test.ts`; the audit rows
 * the sweep emits are in `blocked-dependent-unblock-audit-trail.integration.test.ts`.
 */

const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * Ambient-transaction budget for the wide preview case (ISS-9632 suite).
 *
 * `autoRollbackTransaction` opens ONE Prisma interactive transaction around the
 * whole case. The write fan-out test deliberately does NOT use this harness:
 * its ambient transaction would absorb the service's per-chunk statements and
 * put fixture setup plus every chunk under one deadline.
 *
 * The budget is raised rather than the work cut because the work IS the
 * contract: the count is deliberately one past the chunk bound, and anything
 * at or under it would pass against an unbounded `IN (…)` too.
 */
const FAN_OUT_TX_BUDGET = { maxWait: 5000, timeout: 20_000 };

describeIfDb("blocked-dependent unblock — forward path", () => {
  it("clears the dependent when its only blocker goes terminal", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
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

      await terminalize({
        organizationId,
        id: blockerId,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.resolvedIds).toEqual([dependentId]);
      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
    });
  });

  it("joins an ambient transaction so its guarded write rolls back with the caller", async () => {
    const organizationId = await createTestOrganization();
    try {
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

      await joinAmbientTransaction(async () => {
        const outcome =
          await blockedDependentUnblockService.unblockDependentsOfChanged({
            organizationId,
            changedArtifactIds: [blockerId],
          });
        expect(outcome.unblockedIds).toEqual([dependentId]);
        expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
      });

      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    } finally {
      await withDb(async (db) => {
        await db.artifactLink.deleteMany({ where: { organizationId } });
        await db.artifact.deleteMany({ where: { organizationId } });
        await db.organization.delete({ where: { id: organizationId } });
      });
    }
  });

  it("keeps the dependent BLOCKED while a second blocker is live, then clears it", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const firstBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const secondBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: firstBlockerId,
        targetId: dependentId,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: secondBlockerId,
        targetId: dependentId,
      });

      await terminalize({
        organizationId,
        id: firstBlockerId,
        status: IssueStatus.Done,
      });
      const afterFirst =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [firstBlockerId],
        });

      expect(afterFirst.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);

      await terminalize({
        organizationId,
        id: secondBlockerId,
        status: IssueStatus.Canceled,
      });
      const afterSecond =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [secondBlockerId],
        });

      expect(afterSecond.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
    });
  });

  it("leaves an IN_PROGRESS dependent alone when its last blocker goes terminal", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: blockerId,
        targetId: dependentId,
      });

      await terminalize({
        organizationId,
        id: blockerId,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.InProgress);
    });
  });

  it("counts a DELETED edge as resolved and clears on the surviving terminal one", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const terminalBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const abandonedBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: terminalBlockerId,
        targetId: dependentId,
      });
      const abandonedLinkId = await seedBlocksEdge({
        organizationId,
        sourceId: abandonedBlockerId,
        targetId: dependentId,
      });

      // The second blocker is still LIVE — it is the edge that goes away.
      await withDb((db) =>
        db.artifactLink.delete({ where: { id: abandonedLinkId } })
      );
      await terminalize({
        organizationId,
        id: terminalBlockerId,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [terminalBlockerId],
        });

      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
      expect(await readStatus(abandonedBlockerId)).toBe(IssueStatus.InProgress);
    });
  });

  it("does not act on a status write that was not a real transition", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
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

      // The blocker never reached a terminal status, so nothing resolves.
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("ignores a non-BLOCKS edge from the terminal artifact", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const sourceId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId,
            targetId: dependentId,
            linkType: LinkType.RelatesTo,
          },
        })
      );

      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [sourceId],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("never moves a Document-lifecycle artifact into TODO", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      // Reachable because `Artifact.status` is a freeform column with no DB
      // enum (PRD-495): a PRD can carry a stray `BLOCKED` its own vocabulary
      // has no `TODO` to move to.
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
        subtype: DocumentType.Prd,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: blockerId,
        targetId: dependentId,
      });

      await terminalize({
        organizationId,
        id: blockerId,
        status: IssueStatus.Done,
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

  it("clears a dependent blocked by an APPROVED PRD", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: DocumentStatus.InReview,
        subtype: DocumentType.Prd,
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

      const beforeApproval =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });
      expect(beforeApproval.unblockedIds).toEqual([]);

      await terminalize({
        organizationId,
        id: blockerId,
        status: DocumentStatus.Approved,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
    });
  });

  it("resolves a BLOCKS cycle without cascading back onto the terminal side", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const artifactA = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const artifactB = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: artifactA,
        targetId: artifactB,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: artifactB,
        targetId: artifactA,
      });

      await terminalize({
        organizationId,
        id: artifactA,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [artifactA],
        });

      expect(outcome.unblockedIds).toEqual([artifactB]);
      expect(await readStatus(artifactB)).toBe(IssueStatus.Todo);
      // A stays DONE: it is not BLOCKED, so it was never a candidate, and
      // B's new status is non-terminal so it could not have unblocked anyone.
      expect(await readStatus(artifactA)).toBe(IssueStatus.Done);
    });
  });

  it("will not read another org's artifact as a blocker through a cross-org link row", async () => {
    await joinAmbientTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      // The DEPENDENT is org A's, so org A's own filters happily reach it. The
      // BLOCKER is org B's, reachable only through a link row org A owns. Org
      // B's status must neither be read nor decide org A's outcome, so the
      // dependent stays BLOCKED even though that blocker is terminal.
      const foreignBlocker = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Done,
      });
      const dependentA = await seedArtifact({
        organizationId: orgA,
        status: IssueStatus.Blocked,
      });
      const ownBlocker = await seedArtifact({
        organizationId: orgA,
        status: IssueStatus.InProgress,
      });
      await seedBlocksEdge({
        organizationId: orgA,
        sourceId: foreignBlocker,
        targetId: dependentA,
      });
      await seedBlocksEdge({
        organizationId: orgA,
        sourceId: ownBlocker,
        targetId: dependentA,
      });

      await terminalize({
        organizationId: orgA,
        id: ownBlocker,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId: orgA,
          changedArtifactIds: [ownBlocker],
        });

      // Org A's own blocker IS terminal. The only thing still holding the
      // dependent is the edge whose source org A may not read.
      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentA)).toBe(IssueStatus.Blocked);
    });
  });

  describe("wide dependent fan-out", () => {
    let organizationId = "";
    let blockerId: string;
    let dependentIds: string[];

    beforeAll(async () => {
      organizationId = await createTestOrganization();
      blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      // Keep the 201-row fan-out even when the transaction bound changes.
      dependentIds = await seedBlockedFanOut({
        organizationId,
        blockerId,
        count: 201,
      });
      await terminalize({
        organizationId,
        id: blockerId,
        status: IssueStatus.Done,
      });
    });

    afterAll(async () => {
      if (organizationId) {
        await withDb(async (db) => {
          await db.artifactLink.deleteMany({ where: { organizationId } });
          await db.artifact.deleteMany({ where: { organizationId } });
          await db.organization.delete({ where: { id: organizationId } });
        });
      }
    });

    it("clears a dependent fan-out wider than one chunk", async () => {
      expect(dependentIds).toHaveLength(201);
      expect(dependentIds.length).toBeGreaterThan(UNBLOCK_CANDIDATE_CHUNK_SIZE);
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId,
          changedArtifactIds: [blockerId],
        });

      expect(outcome.unblockedIds).toHaveLength(dependentIds.length);
      expect(outcome.resolvedIds.sort()).toEqual([...dependentIds].sort());
      expect(outcome.unblockedIds.sort()).toEqual([...dependentIds].sort());
      const stillBlocked = await withDb((db) =>
        db.artifact.count({
          where: { organizationId, status: IssueStatus.Blocked },
        })
      );
      expect(stillBlocked).toBe(0);
    });
  });

  it("never crosses an organization boundary", async () => {
    await joinAmbientTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const blockerB = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Done,
      });
      const dependentB = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId: orgB,
        sourceId: blockerB,
        targetId: dependentB,
      });

      // Org A asking about org B's just-changed artifact must see nothing.
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId: orgA,
          changedArtifactIds: [blockerB],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentB)).toBe(IssueStatus.Blocked);

      // …and the same call scoped to org B does move it, so the assertion
      // above is about the org filter and not about an unreachable fixture.
      const scoped =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId: orgB,
          changedArtifactIds: [blockerB],
        });
      expect(scoped.unblockedIds).toEqual([dependentB]);
    });
  });

  it("will not write another org's artifact through a cross-org link row", async () => {
    await joinAmbientTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const blockerA = await seedArtifact({
        organizationId: orgA,
        status: IssueStatus.InProgress,
      });
      const dependentB = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Blocked,
      });
      // A link row stamped with org A while both endpoints… are not. Nothing at
      // the schema level makes `ArtifactLink.organizationId` agree with its
      // endpoints' orgs, so this shape is reachable from a bad write, and it is
      // what makes the org predicate on the DEPENDENT lookup decidable: with
      // the edge itself visible to org A, only that filter stands between org
      // A's write and a status change on org B's artifact.
      await seedBlocksEdge({
        organizationId: orgA,
        sourceId: blockerA,
        targetId: dependentB,
      });

      await terminalize({
        organizationId: orgA,
        id: blockerA,
        status: IssueStatus.Done,
      });
      const outcome =
        await blockedDependentUnblockService.unblockDependentsOfChanged({
          organizationId: orgA,
          changedArtifactIds: [blockerA],
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentB)).toBe(IssueStatus.Blocked);
    });
  });
});

describeIfDb("blocked-dependent unblock — batch write path", () => {
  it("unblocks off the batch path's changed set", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const firstBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const secondBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      const otherDependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: firstBlockerId,
        targetId: dependentId,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: secondBlockerId,
        targetId: otherDependentId,
      });

      // The real batch write path, closing both blockers at once.
      const updateResult =
        await documentStatusMutationService.batchUpdateStatus(
          [firstBlockerId, secondBlockerId],
          IssueStatus.Done,
          organizationId
        );
      expect(updateResult.ok).toBe(true);
      const changedIds = updateResult.ok ? updateResult.value.changedIds : [];
      expect(changedIds).toHaveLength(2);

      const outcome =
        await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
          organizationId,
          changedArtifactIds: changedIds,
        });

      expect(outcome.unblockedIds.sort()).toEqual(
        [dependentId, otherDependentId].sort()
      );
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
      expect(await readStatus(otherDependentId)).toBe(IssueStatus.Todo);
    });
  });

  it("does nothing for a batch whose rows were already at the target status", async () => {
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

      const updateResult =
        await documentStatusMutationService.batchUpdateStatus(
          [blockerId],
          IssueStatus.Done,
          organizationId
        );
      expect(updateResult.ok).toBe(true);
      const changedIds = updateResult.ok ? updateResult.value.changedIds : [];

      // No transition happened, so the forward path is never handed anything…
      expect(changedIds).toEqual([]);
      const outcome =
        await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
          organizationId,
          changedArtifactIds: changedIds,
        });

      expect(outcome.unblockedIds).toEqual([]);
      // …and the dependent stays put, even though its blocker IS terminal.
      // The sweep below is what reconciles a row in this shape.
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });
});

describeIfDb("stale BLOCKED reconciliation sweep", () => {
  it("moves the rows that went stale, then is a no-op on a second run", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const resolvedBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const liveBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const staleDependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      const genuinelyBlockedId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      const unmodelledBlockedId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: resolvedBlockerId,
        targetId: staleDependentId,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: liveBlockerId,
        targetId: genuinelyBlockedId,
      });

      const preview =
        await blockedDependentUnblockService.previewStaleBlockedArtifacts({
          organizationId,
        });
      expect(preview.resolvedIds).toEqual([staleDependentId]);
      expect(preview.unblockedIds).toEqual([]);
      // A preview writes nothing.
      expect(await readStatus(staleDependentId)).toBe(IssueStatus.Blocked);

      const first =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        });
      expect(first.scanned).toBe(3);
      expect(first.unblockedIds).toEqual([staleDependentId]);
      expect(await readStatus(staleDependentId)).toBe(IssueStatus.Todo);
      expect(await readStatus(genuinelyBlockedId)).toBe(IssueStatus.Blocked);
      // A BLOCKED artifact with no BLOCKS edge at all is somebody's manual
      // block, not a stale one — the sweep must not reinterpret it.
      expect(await readStatus(unmodelledBlockedId)).toBe(IssueStatus.Blocked);

      const second =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        });
      expect(second.unblockedIds).toEqual([]);
      expect(second.scanned).toBe(2);
    });
  });

  it("previews a page wider than one chunk without dropping any of it", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const dependentIds = await seedBlockedFanOut({
        organizationId,
        blockerId,
        count: UNBLOCK_CANDIDATE_CHUNK_SIZE + 1,
      });

      // `pageSize` is caller-supplied and clamped only at the bottom, so a page
      // can exceed the chunk bound. Preview must chunk it the same way the
      // applying path does rather than rely on the two constants being equal.
      const preview =
        await blockedDependentUnblockService.previewStaleBlockedArtifacts({
          organizationId,
          pageSize: UNBLOCK_CANDIDATE_CHUNK_SIZE * 3,
        });

      expect(preview.resolvedIds).toHaveLength(dependentIds.length);
      expect(preview.unblockedIds).toEqual([]);
      // A preview still writes nothing, however wide the page.
      expect(await readStatus(dependentIds[0] as string)).toBe(
        IssueStatus.Blocked
      );
    }, FAN_OUT_TX_BUDGET);
  });

  it("does not scan artifacts outside the DOCUMENT population", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      // `Artifact.status` is one freeform column across every artifact type, so
      // a BRANCH row can carry the string `BLOCKED` — but `BLOCKED` belongs to
      // the Document-subtype vocabulary (PRD-495), so such a row is not in this
      // sweep's population. Pinning it also keeps the scan on
      // `[organizationId, type, status]`, the only status-bearing Artifact
      // index: drop `type` and the scan loses its equality prefix.
      await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.Branch,
            name: "a branch that happens to say BLOCKED",
            status: IssueStatus.Blocked,
          },
        })
      );

      const swept =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        });

      expect(swept.scanned).toBe(0);
      expect(swept.unblockedIds).toEqual([]);
    });
  });

  it("walks every page rather than stopping at the first", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.Done,
      });
      const dependentIds: string[] = [];
      for (let index = 0; index < 5; index++) {
        const dependentId = await seedArtifact({
          organizationId,
          status: IssueStatus.Blocked,
          name: `dependent ${index}`,
        });
        await seedBlocksEdge({
          organizationId,
          sourceId: blockerId,
          targetId: dependentId,
        });
        dependentIds.push(dependentId);
      }

      // Page size below the population: an offset-paginated sweep would skip
      // the rows that shift down as earlier pages are moved out of BLOCKED.
      const outcome =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
          pageSize: 2,
        });

      expect(outcome.scanned).toBe(5);
      expect(outcome.unblockedIds.sort()).toEqual(dependentIds.sort());
    });
  });

  it("stays inside the organization it was asked about", async () => {
    await joinAmbientTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const blockerB = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Done,
      });
      const dependentB = await seedArtifact({
        organizationId: orgB,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId: orgB,
        sourceId: blockerB,
        targetId: dependentB,
      });

      const sweptA =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId: orgA,
        });

      expect(sweptA.scanned).toBe(0);
      expect(sweptA.unblockedIds).toEqual([]);
      expect(await readStatus(dependentB)).toBe(IssueStatus.Blocked);

      const sweptB =
        await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId: orgB,
        });
      expect(sweptB.unblockedIds).toEqual([dependentB]);
    });
  });
});
