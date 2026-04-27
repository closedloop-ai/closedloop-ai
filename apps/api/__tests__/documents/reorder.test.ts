/**
 * Integration tests for artifact reorder service method.
 * Tests sortOrder assignment and validation.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { generateSlug } from "@/app/documents/document-utils";
import { documentsService } from "@/app/documents/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("reorder artifacts", () => {
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
      await documentsService.reorder(
        [artifact3.id, artifact1.id, artifact2.id],
        orgId
      );

      // Verify sortOrder
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
      expect(artifacts[1].sortOrder).toBe(1);

      expect(artifacts[2].id).toBe(artifact2.id);
      expect(artifacts[2].sortOrder).toBe(2);
    });
  });

  it("empty array returns without error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await expect(documentsService.reorder([], orgId)).resolves.not.toThrow();
    });
  });

  it("non-existent artifact ID throws error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const fakeId = "01FAKE000000000000000000";
      await expect(documentsService.reorder([fakeId], orgId)).rejects.toThrow();
    });
  });
});
