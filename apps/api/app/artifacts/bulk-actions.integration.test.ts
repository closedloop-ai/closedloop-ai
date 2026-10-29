import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { batchUpdateDocumentAssignee } from "@/app/documents/document-assignee-batch-item-service";
import { batchSetArtifactFavorites } from "./favorites-batch-service";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const inRollback = autoRollbackTransactionJoining(
  "The outer rollback owns fixture cleanup; these tests assert the service writes and scoped locks, not a nested transaction boundary."
);

async function seed() {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  const nextOwner = await createTestUser(organizationId);
  const foreignOwner = await createTestUser(otherOrganizationId);
  const projectId = await createTestProject(organizationId, owner.id);
  const foreignProjectId = await createTestProject(
    otherOrganizationId,
    foreignOwner.id
  );
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        createdById: owner.id,
        name: "Batch document",
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        assigneeId: owner.id,
      },
    })
  );
  const issue = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        createdById: owner.id,
        name: "Batch issue",
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: IssueStatus.Backlog,
      },
    })
  );
  const foreign = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: otherOrganizationId,
        projectId: foreignProjectId,
        createdById: foreignOwner.id,
        name: "Foreign document",
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
      },
    })
  );
  return {
    organizationId,
    owner,
    nextOwner,
    foreignOwner,
    document,
    issue,
    foreign,
  };
}

describeIfDb("shared artifact batch write services", () => {
  it("assigns only locked organization documents/issues and reports unresolved IDs per item", async () => {
    await inRollback(async () => {
      const fixture = await seed();
      const missingId = "99999999-9999-4999-8999-999999999999";
      const ids = [
        fixture.document.id,
        fixture.foreign.id,
        fixture.issue.id,
        missingId,
      ];
      const written = await withDb.tx((tx) =>
        batchUpdateDocumentAssignee(
          tx,
          ids,
          fixture.nextOwner.id,
          fixture.organizationId
        )
      );
      expect(written.validAssignee).toBe(true);
      expect([...written.resultsById.values()]).toEqual([
        batchItemApplied(fixture.document.id),
        batchItemFailed(
          fixture.foreign.id,
          BatchItemFailureCode.ArtifactsNotFound
        ),
        batchItemApplied(fixture.issue.id),
        batchItemFailed(missingId, BatchItemFailureCode.ArtifactsNotFound),
      ]);
      expect(written.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: fixture.document.id,
            before: fixture.owner.id,
            after: fixture.nextOwner.id,
          }),
          expect.objectContaining({
            artifactId: fixture.issue.id,
            before: null,
            after: fixture.nextOwner.id,
          }),
        ])
      );
      const stored = await withDb((db) =>
        db.artifact.findMany({
          where: { id: { in: ids } },
          select: { id: true, assigneeId: true },
        })
      );
      expect(
        stored.find((row) => row.id === fixture.document.id)?.assigneeId
      ).toBe(fixture.nextOwner.id);
      expect(
        stored.find((row) => row.id === fixture.issue.id)?.assigneeId
      ).toBe(fixture.nextOwner.id);
      expect(
        stored.find((row) => row.id === fixture.foreign.id)?.assigneeId
      ).toBeNull();

      const retry = await withDb.tx((tx) =>
        batchUpdateDocumentAssignee(
          tx,
          ids,
          fixture.nextOwner.id,
          fixture.organizationId
        )
      );
      expect(retry.changes).toEqual([]);
    });
  });

  it("matches uppercase requested UUIDs to canonical database rows", async () => {
    await inRollback(async () => {
      const fixture = await seed();
      const requestedId = fixture.document.id.toUpperCase();
      const assignment = await withDb.tx((tx) =>
        batchUpdateDocumentAssignee(
          tx,
          [requestedId],
          fixture.nextOwner.id,
          fixture.organizationId
        )
      );
      expect(assignment.resultsById.get(requestedId)).toEqual(
        batchItemApplied(requestedId)
      );

      const favorites = await withDb.tx((tx) =>
        batchSetArtifactFavorites(
          tx,
          [requestedId],
          fixture.owner.id,
          fixture.organizationId,
          true
        )
      );
      expect(favorites.get(requestedId)).toEqual(batchItemApplied(requestedId));
    });
  });

  it("rejects an owner from another organization without writing a row", async () => {
    await inRollback(async () => {
      const fixture = await seed();
      const written = await withDb.tx((tx) =>
        batchUpdateDocumentAssignee(
          tx,
          [fixture.document.id],
          fixture.foreignOwner.id,
          fixture.organizationId
        )
      );
      expect(written).toEqual({
        validAssignee: false,
        resultsById: new Map(),
        changes: [],
      });
      const row = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: fixture.document.id },
          select: { assigneeId: true },
        })
      );
      expect(row.assigneeId).toBe(fixture.owner.id);
    });
  });

  it("keeps the 500-ID bound at each service boundary as well as at the route", async () => {
    await inRollback(async () => {
      const fixture = await seed();
      const overLimit = Array.from(
        { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
        () => fixture.document.id
      );
      await expect(
        withDb.tx((tx) =>
          batchUpdateDocumentAssignee(
            tx,
            overLimit,
            fixture.nextOwner.id,
            fixture.organizationId
          )
        )
      ).rejects.toThrow(RangeError);
      await expect(
        withDb.tx((tx) =>
          batchSetArtifactFavorites(
            tx,
            overLimit,
            fixture.owner.id,
            fixture.organizationId,
            true
          )
        )
      ).rejects.toThrow(RangeError);
      const favoriteCount = await withDb((db) =>
        db.favoriteArtifact.count({
          where: { userId: fixture.owner.id },
        })
      );
      expect(favoriteCount).toBe(0);
    });
  });

  it("sets and clears favorites idempotently for found artifacts only", async () => {
    await inRollback(async () => {
      const fixture = await seed();
      const ids = [fixture.issue.id, fixture.foreign.id, fixture.document.id];
      const set = () =>
        withDb.tx((tx) =>
          batchSetArtifactFavorites(
            tx,
            ids,
            fixture.owner.id,
            fixture.organizationId,
            true
          )
        );
      const results = await set();
      expect([...results.values()]).toEqual([
        batchItemApplied(fixture.issue.id),
        batchItemFailed(
          fixture.foreign.id,
          BatchItemFailureCode.ArtifactsNotFound
        ),
        batchItemApplied(fixture.document.id),
      ]);
      await set();
      const count = await withDb((db) =>
        db.favoriteArtifact.count({
          where: { userId: fixture.owner.id },
        })
      );
      expect(count).toBe(2);
      await withDb.tx((tx) =>
        batchSetArtifactFavorites(
          tx,
          ids,
          fixture.owner.id,
          fixture.organizationId,
          false
        )
      );
      const cleared = await withDb((db) =>
        db.favoriteArtifact.count({
          where: { userId: fixture.owner.id },
        })
      );
      expect(cleared).toBe(0);
    });
  });
});
