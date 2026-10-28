import { LinkType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { artifactLinksService } from "@/app/artifact-links/service";
import {
  hasDatabase,
  readStatus,
  seedArtifact,
  seedBlocksEdge,
  terminalize,
} from "./__tests__/blocked-dependent-fixtures";
import { blockedDependentUnblockService } from "./blocked-dependent-unblock-service";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin which deleted BLOCKS edges wake the resolver, not the per-chunk commit boundary; the boundary and its receipt atomicity are covered by the committed fixture in app/documents/blocked-dependent-unblock-chunk-boundary.integration.test.ts"
);

/**
 * ISS-9632 — the DELETE half of "a blocker is resolved" (whitlockk, ISS-9632
 * review).
 *
 * The spec counts a blocker as resolved when its source went terminal OR the
 * `BLOCKS` edge no longer exists. Only the first half had a trigger, so a
 * dependent whose OTHER blockers were already terminal before the last live edge
 * was removed stayed `BLOCKED` with nothing holding it, indefinitely.
 *
 * THE ORDERING IS THE POINT. `blocked-dependent-unblock.integration.test.ts`
 * covers delete-then-terminalize, which the terminalize wakes up; that ordering
 * passes with no delete trigger at all. These cases run it the other way —
 * terminalize FIRST, delete LAST — so the delete is the only event left that can
 * move the dependent.
 */

const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("removed BLOCKS edge wakes the resolver", () => {
  it("clears the dependent when the last LIVE edge is deleted after the other blocker terminalized", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const terminalBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const liveBlockerId = await seedArtifact({
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
      const liveLinkId = await seedBlocksEdge({
        organizationId,
        sourceId: liveBlockerId,
        targetId: dependentId,
      });

      // FIRST the other blocker goes terminal. The dependent must NOT move —
      // the live edge is still there.
      await terminalize({
        organizationId,
        id: terminalBlockerId,
        status: IssueStatus.Done,
      });
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId,
        changedArtifactIds: [terminalBlockerId],
      });
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);

      // THEN the live edge is removed. Nothing else happens after this, so the
      // delete is the only thing that can clear the dependent.
      const { unblockCandidateIds } = await artifactLinksService.deleteLink(
        liveLinkId,
        organizationId
      );
      const outcome =
        await blockedDependentUnblockService.resolveBlocksForRemovedEdges({
          organizationId,
          dependentIds: unblockCandidateIds,
        });

      expect(unblockCandidateIds).toEqual([dependentId]);
      expect(outcome.unblockedIds).toEqual([dependentId]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Todo);
      // The blocker itself is untouched — only the edge went away.
      expect(await readStatus(liveBlockerId)).toBe(IssueStatus.InProgress);
    });
  });

  it("leaves the dependent BLOCKED when a deleted edge was not the last live one", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const survivingBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const removedBlockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const dependentId = await seedArtifact({
        organizationId,
        status: IssueStatus.Blocked,
      });
      await seedBlocksEdge({
        organizationId,
        sourceId: survivingBlockerId,
        targetId: dependentId,
      });
      const removedLinkId = await seedBlocksEdge({
        organizationId,
        sourceId: removedBlockerId,
        targetId: dependentId,
      });

      const { unblockCandidateIds } = await artifactLinksService.deleteLink(
        removedLinkId,
        organizationId
      );
      const outcome =
        await blockedDependentUnblockService.resolveBlocksForRemovedEdges({
          organizationId,
          dependentIds: unblockCandidateIds,
        });

      expect(outcome.unblockedIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("names no dependent when the deleted link is not a BLOCKS edge", async () => {
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
      const relatesLink = await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId,
            targetId: dependentId,
            linkType: LinkType.RelatesTo,
          },
          select: { id: true },
        })
      );

      const { unblockCandidateIds } = await artifactLinksService.deleteLink(
        relatesLink.id,
        organizationId
      );

      // A link that never blocked anything must not nominate its target, or the
      // delete of ANY link would sweep unrelated rows.
      expect(unblockCandidateIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });

  it("names no dependent when the link belongs to another organization", async () => {
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
      const linkId = await seedBlocksEdge({
        organizationId,
        sourceId: blockerId,
        targetId: dependentId,
      });

      // The delete matches no row for the other org, so it must not name — let
      // alone move — an artifact that org cannot see.
      const { unblockCandidateIds } = await artifactLinksService.deleteLink(
        linkId,
        otherOrganizationId
      );

      expect(unblockCandidateIds).toEqual([]);
      expect(await readStatus(dependentId)).toBe(IssueStatus.Blocked);
    });
  });
});
