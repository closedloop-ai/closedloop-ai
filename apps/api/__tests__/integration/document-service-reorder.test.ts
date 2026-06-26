/**
 * Integration tests for `documentService.reorder`.
 *
 * The implementation uses raw SQL via `tx.$executeRaw` (a single
 * `UPDATE … FROM (VALUES …)` statement) so this suite runs against a real
 * Postgres database to verify Postgres-specific behavior — parameter binding,
 * type coercion, transactional rollback, and the org/type scoping in the
 * WHERE clause.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  documentService,
  STACK_RANK_GAP,
} from "@/app/documents/document-service";
import { generateSlug } from "@/app/documents/document-utils";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("documentService.reorder", () => {
  it("valid reorder assigns sortOrder 0, 1, 2 in order", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Create 3 artifacts
      const artifact1 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 1",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      const artifact2 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 2",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      const artifact3 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 3",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Reorder: 3, 1, 2
      await documentService.reorder(
        projectId,
        [artifact3.id, artifact1.id, artifact2.id],
        orgId
      );

      // Verify sortOrder — spaced by STACK_RANK_GAP per the rank-grid
      // strategy seeded by the backfill migration.
      const artifacts = await withDb((db) =>
        db.artifact.findMany({
          where: {
            id: { in: [artifact1.id, artifact2.id, artifact3.id] },
          },
          orderBy: { sortOrder: "asc" },
        })
      );

      expect(artifacts[0].id).toBe(artifact3.id);
      expect(artifacts[0].sortOrder).toBe(0);

      expect(artifacts[1].id).toBe(artifact1.id);
      expect(artifacts[1].sortOrder).toBe(STACK_RANK_GAP);

      expect(artifacts[2].id).toBe(artifact2.id);
      expect(artifacts[2].sortOrder).toBe(STACK_RANK_GAP * 2);
    });
  });

  it("empty array returns without error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);
      await expect(
        documentService.reorder(projectId, [], orgId)
      ).resolves.not.toThrow();
    });
  });

  it("non-existent artifact ID throws error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);
      const fakeId = "01FAKE000000000000000000";
      await expect(
        documentService.reorder(projectId, [fakeId], orgId)
      ).rejects.toThrow();
    });
  });

  it("rejects artifacts from another organization", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization();
      const userA = await createTestUser(orgA);
      const projectA = await createTestProject(orgA, userA.id);
      const orgB = await createTestOrganization();

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact in org A",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgA,
            createdById: userA.id,
            projectId: projectA,
          },
        })
      );

      await expect(
        documentService.reorder(projectA, [artifact.id], orgB)
      ).rejects.toThrow("not found in organization");

      // Verify the artifact's sortOrder was not touched.
      const after = await withDb((db) =>
        db.artifact.findUnique({ where: { id: artifact.id } })
      );
      expect(after?.sortOrder).toBeNull();
    });
  });

  it("rejects artifacts that belong to a different project in the same org", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectA = await createTestProject(orgId, user.id);
      const projectB = await createTestProject(orgId, user.id);

      const artifactInB = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact in project B",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectB,
          },
        })
      );

      // Caller asks to reorder in project A but passes an id that lives in
      // project B. The project-scoping validation must reject this.
      await expect(
        documentService.reorder(projectA, [artifactInB.id], orgId)
      ).rejects.toThrow("not found in organization");

      const after = await withDb((db) =>
        db.artifact.findUnique({ where: { id: artifactInB.id } })
      );
      expect(after?.sortOrder).toBeNull();
    });
  });

  it("reverses sortOrder correctly for a 100-row batch (raw SQL at non-trivial N)", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const artifacts = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          withDb((db) =>
            db.artifact.create({
              data: {
                name: `Artifact ${index}`,
                slug: generateSlug(),
                type: ArtifactType.DOCUMENT,
                subtype: ArtifactSubtype.PRD,
                status: DocumentStatus.Draft,
                organizationId: orgId,
                createdById: user.id,
                projectId,
              },
            })
          )
        )
      );

      // Reverse the order to exercise full reindex.
      const reversed = artifacts.map((a) => a.id).reverse();

      await documentService.reorder(projectId, reversed, orgId);

      const persisted = await withDb((db) =>
        db.artifact.findMany({
          where: { id: { in: reversed } },
          orderBy: { sortOrder: "asc" },
          select: { id: true, sortOrder: true },
        })
      );

      expect(persisted).toHaveLength(100);
      for (const [index, row] of persisted.entries()) {
        expect(row.sortOrder).toBe(index * STACK_RANK_GAP);
        expect(row.id).toBe(reversed[index]);
      }
    });
  });
});
