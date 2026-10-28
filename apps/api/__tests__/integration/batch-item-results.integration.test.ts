/**
 * ISS-9464 — the per-item `/v2` batch mutations against a real Postgres.
 *
 * The route and service suites that shipped with each milestone prove the
 * classification against a fake seam. These cases exist for the half a fake
 * cannot answer: whether the eligible subset was actually WRITTEN and whether a
 * failed item's row is genuinely UNCHANGED. `FOR NO KEY UPDATE` locks, the raw
 * org-scoped lock predicates and `updateMany`'s row count have no fake at all.
 *
 * The per-item SERVICES are the entry points, not the routes: the routes'
 * envelope, ordering and side-effect wiring are already pinned by the route
 * tests, so repeating them here would re-prove the cheap half against the
 * expensive fixture.
 *
 * The six services do NOT share one return shape, so neither do the assertions:
 * status and priority hand back their success object directly, move and tag
 * hand back a `Result`, delete goes through v1's `{ deletedIds, failedIds }`,
 * and bulk-assign hands back a `Result` of the per-item map. Read each call
 * below against its own service, not against a generalisation.
 *
 * The bulk-assign half lives in the sibling
 * `batch-item-results-bulk-assign.integration.test.ts`, because it cannot use
 * this file's harness — see that file's header.
 *
 * Documents are seeded with a null `slug` throughout. Nothing under test reads
 * one, and `documentService.batchDelete` asks Liveblocks to drop a room for
 * every slug it deleted — a network call this suite has no reason to make.
 */
import { randomUUID } from "node:crypto";
import {
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  readArtifactProjectId,
  resultFor,
} from "@/__tests__/support/integration/batch-item-results.test-helpers";
import { userAuditActor } from "@/app/audit/audit-emit-service";
import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";
import { documentBatchMoveService } from "@/app/documents/document-batch-move-service";
import { documentService } from "@/app/documents/document-service";
import { documentStatusBatchItemService } from "@/app/documents/document-status-batch-item-service";
import { batchApplyTagService } from "@/app/tags/batch-apply-tag-service";
import {
  BatchRemoveTagRefusal,
  batchRemoveTagService,
} from "@/app/tags/batch-remove-tag-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);

type World = {
  organizationId: string;
  userId: string;
  projectId: string;
};

async function seedWorld(): Promise<World> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, userId: user.id, projectId };
}

function seedDocument(
  world: World,
  overrides: {
    name: string;
    status: string;
    subtype?: ArtifactSubtype;
    priority?: Priority;
    projectId?: string;
  }
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        projectId: overrides.projectId ?? world.projectId,
        type: ArtifactType.DOCUMENT,
        subtype: overrides.subtype ?? ArtifactSubtype.PRD,
        name: overrides.name,
        slug: null,
        status: overrides.status,
        priority: overrides.priority ?? null,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

function readStatus(id: string): Promise<string | undefined> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id },
      select: { status: true },
    });
    return row?.status;
  });
}

function readPriority(id: string): Promise<string | null | undefined> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id },
      select: { priority: true },
    });
    return row?.priority;
  });
}

function artifactExists(id: string): Promise<boolean> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  });
}

function readTaggedArtifactIds(tagId: string): Promise<string[]> {
  return withDb(async (db) => {
    const rows = await db.tagArtifact.findMany({
      where: { tagId },
      select: { artifactId: true },
    });
    return rows.map((row) => row.artifactId).sort();
  });
}

function applyTag(tagId: string, artifactIds: string[]): Promise<unknown> {
  return withDb((db) =>
    db.tagArtifact.createMany({
      data: artifactIds.map((artifactId) => ({ tagId, artifactId })),
      skipDuplicates: true,
    })
  );
}

function seedTag(world: World): Promise<string> {
  return withDb(async (db) => {
    const tag = await db.tag.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: `tag-${randomUUID().slice(0, 8)}`,
        color: "blue",
      },
      select: { id: true },
    });
    return tag.id;
  });
}

describe.skipIf(!hasDatabase)(
  "ISS-9464 per-item batch mutations against real Postgres",
  () => {
    it("commits only the eligible ids of a mixed status batch and leaves another org's row untouched", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const applied = await seedDocument(world, {
          name: "applied",
          status: DocumentStatus.Draft,
        });
        const alsoApplied = await seedDocument(world, {
          name: "also-applied",
          status: DocumentStatus.Draft,
        });
        // A FEATURE reads the Issue vocabulary, which has no EXECUTED.
        const wrongSubtype = await seedDocument(world, {
          name: "wrong-subtype",
          status: IssueStatus.Todo,
          subtype: ArtifactSubtype.FEATURE,
        });
        const stale = await seedDocument(world, {
          name: "stale",
          status: DocumentStatus.Draft,
        });
        // A REAL row another organization holds, and a valid target for this
        // status. It is the only id here that separates a dropped
        // `organizationId` lock predicate from an absent row: `missing` is not
        // found with or without the predicate, so it cannot fail for the leak.
        const foreignDocument = await seedDocument(foreign, {
          name: "foreign-status",
          status: DocumentStatus.Draft,
        });
        const missing = randomUUID();

        const { resultsById, changedIds } =
          await documentStatusBatchItemService.batchUpdateStatus(
            [
              applied,
              missing,
              foreignDocument,
              wrongSubtype,
              stale,
              alsoApplied,
            ],
            DocumentStatus.Executed,
            world.organizationId,
            { [stale]: DocumentStatus.Approved }
          );

        expect(changedIds.slice().sort()).toEqual(
          [applied, alsoApplied].sort()
        );
        expect(resultFor(resultsById, applied)).toEqual({
          id: applied,
          status: 200,
        });
        expect(resultFor(resultsById, alsoApplied)).toEqual({
          id: alsoApplied,
          status: 200,
        });
        expect(resultFor(resultsById, missing)).toMatchObject({
          id: missing,
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });
        // AC-002: the only datum a missing id has is its own id, so nothing
        // rides in `details` — the key is omitted, not serialized null.
        expect(resultFor(resultsById, missing)).not.toHaveProperty("details");
        expect(resultFor(resultsById, foreignDocument)).toMatchObject({
          id: foreignDocument,
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });
        expect(resultFor(resultsById, foreignDocument)).not.toHaveProperty(
          "details"
        );
        expect(resultFor(resultsById, wrongSubtype)).toMatchObject({
          id: wrongSubtype,
          status: 400,
          code: BatchItemFailureCode.InvalidStatusForSubtype,
          details: { targetStatus: DocumentStatus.Executed },
        });
        expect(resultFor(resultsById, stale)).toMatchObject({
          id: stale,
          status: 409,
          code: BatchItemFailureCode.StaleStatus,
          details: {
            currentStatus: DocumentStatus.Draft,
            expectedStatus: DocumentStatus.Approved,
          },
        });

        await expect(readStatus(applied)).resolves.toBe(
          DocumentStatus.Executed
        );
        await expect(readStatus(alsoApplied)).resolves.toBe(
          DocumentStatus.Executed
        );
        await expect(readStatus(wrongSubtype)).resolves.toBe(IssueStatus.Todo);
        await expect(readStatus(stale)).resolves.toBe(DocumentStatus.Draft);
        await expect(readStatus(foreignDocument)).resolves.toBe(
          DocumentStatus.Draft
        );
      });
    });

    it("leaves stale-guarded and foreign-org rows untouched while the priority batch commits the rest", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const applied = await seedDocument(world, {
          name: "priority-applied",
          status: DocumentStatus.Draft,
          priority: Priority.Low,
        });
        const stale = await seedDocument(world, {
          name: "priority-stale",
          status: DocumentStatus.Draft,
          priority: Priority.Low,
        });
        // Unguarded on purpose: with the lock's `organizationId` predicate
        // dropped, nothing else would stop this row from being written.
        const foreignDocument = await seedDocument(foreign, {
          name: "priority-foreign",
          status: DocumentStatus.Draft,
          priority: Priority.Low,
        });
        const missing = randomUUID();

        const { resultsById, changedIds } =
          await artifactBulkPriorityService.batchUpdatePriorityPerItem(
            [applied, stale, foreignDocument, missing],
            Priority.Urgent,
            world.organizationId,
            { [stale]: Priority.Medium }
          );

        expect(changedIds).toEqual([applied]);
        expect(resultFor(resultsById, applied)).toEqual({
          id: applied,
          status: 200,
        });
        expect(resultFor(resultsById, stale)).toMatchObject({
          id: stale,
          status: 409,
          code: BatchItemFailureCode.StalePriority,
          details: {
            currentPriority: Priority.Low,
            expectedPriority: Priority.Medium,
          },
        });
        expect(resultFor(resultsById, foreignDocument)).toMatchObject({
          id: foreignDocument,
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });
        expect(resultFor(resultsById, missing)).toMatchObject({
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });

        await expect(readPriority(applied)).resolves.toBe(Priority.Urgent);
        await expect(readPriority(stale)).resolves.toBe(Priority.Low);
        await expect(readPriority(foreignDocument)).resolves.toBe(Priority.Low);
      });
    });

    it("moves the documents it found and leaves another org's row in its project", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const destinationId = await createTestProject(
          world.organizationId,
          world.userId,
          { name: "Destination" }
        );
        const moved = await seedDocument(world, {
          name: "moved",
          status: DocumentStatus.Draft,
        });
        const foreignDocument = await seedDocument(foreign, {
          name: "foreign",
          status: DocumentStatus.Draft,
        });

        const result = await documentBatchMoveService.batchMovePerItem(
          [moved, foreignDocument],
          destinationId,
          world.organizationId
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(resultFor(result.value.results, moved)).toEqual({
          id: moved,
          status: 200,
        });
        expect(resultFor(result.value.results, foreignDocument)).toMatchObject({
          id: foreignDocument,
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });
        expect(
          resultFor(result.value.results, foreignDocument)
        ).not.toHaveProperty("details");

        await expect(readArtifactProjectId(moved)).resolves.toBe(destinationId);
        await expect(readArtifactProjectId(foreignDocument)).resolves.toBe(
          foreign.projectId
        );
      });
    });

    it("reports another org's id as not found and leaves the row in place on delete", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const deleted = await seedDocument(world, {
          name: "deleted",
          status: DocumentStatus.Draft,
        });
        const foreignDocument = await seedDocument(foreign, {
          name: "foreign-delete",
          status: DocumentStatus.Draft,
        });

        const { deletedIds, failedIds } = await documentService.batchDelete(
          [deleted, foreignDocument],
          world.organizationId,
          userAuditActor(world.userId),
          randomUUID()
        );

        expect(deletedIds).toEqual([deleted]);
        expect(failedIds).toEqual([foreignDocument]);
        await expect(artifactExists(deleted)).resolves.toBe(false);
        await expect(artifactExists(foreignDocument)).resolves.toBe(true);
      });
    });

    it("writes no tag row for an id outside the caller's organization", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const tagId = await seedTag(world);
        const tagged = await seedDocument(world, {
          name: "tagged",
          status: DocumentStatus.Draft,
        });
        const foreignDocument = await seedDocument(foreign, {
          name: "foreign-tag",
          status: DocumentStatus.Draft,
        });

        const result = await batchApplyTagService.applyPerItem(
          tagId,
          TagEntityType.Artifact,
          [tagged, foreignDocument],
          world.organizationId
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(resultFor(result.value.results, tagged)).toEqual({
          id: tagged,
          status: 200,
        });
        expect(resultFor(result.value.results, foreignDocument)).toMatchObject({
          id: foreignDocument,
          status: 404,
          code: BatchItemFailureCode.ArtifactsNotFound,
        });
        expect(
          resultFor(result.value.results, foreignDocument)
        ).not.toHaveProperty("details");

        await expect(readTaggedArtifactIds(tagId)).resolves.toEqual([tagged]);
      });
    });

    it("removes only present memberships and reports absent memberships as success (ISS-10686 AC-001/AC-004)", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const tagId = await seedTag(world);
        const carrying = await seedDocument(world, {
          name: "carrying",
          status: DocumentStatus.Draft,
        });
        const bare = await seedDocument(world, {
          name: "bare",
          status: DocumentStatus.Draft,
        });
        const untouched = await seedDocument(world, {
          name: "untouched",
          status: DocumentStatus.Draft,
        });
        await applyTag(tagId, [carrying, untouched]);

        const result = await batchRemoveTagService.removePerItem(
          tagId,
          TagEntityType.Artifact,
          [carrying, bare],
          world.organizationId
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(resultFor(result.value.results, carrying)).toEqual({
          id: carrying,
          status: 200,
          outcome: BatchItemAppliedOutcome.Removed,
        });
        expect(resultFor(result.value.results, bare)).toEqual({
          id: bare,
          status: 200,
          outcome: BatchItemAppliedOutcome.NotPresent,
        });
        await expect(readTaggedArtifactIds(tagId)).resolves.toEqual([
          untouched,
        ]);
      });
    });

    it("rolls back the whole removal batch when any id is outside the organization (ISS-10686 AC-002)", async () => {
      await autoRollbackTransaction(async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const tagId = await seedTag(world);
        const carrying = await seedDocument(world, {
          name: "carrying",
          status: DocumentStatus.Draft,
        });
        const foreignDocument = await seedDocument(foreign, {
          name: "foreign-remove",
          status: DocumentStatus.Draft,
        });
        await applyTag(tagId, [carrying]);

        const result = await batchRemoveTagService.removePerItem(
          tagId,
          TagEntityType.Artifact,
          [carrying, foreignDocument],
          world.organizationId
        );

        expect(result).toEqual({
          ok: false,
          error: BatchRemoveTagRefusal.UnresolvedIds,
        });
        await expect(readTaggedArtifactIds(tagId)).resolves.toEqual([carrying]);
      });
    });
  }
);
