/**
 * Integration tests for batch move artifacts service method.
 * Tests cross-project artifact moves with atomicity.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { documentService } from "@/app/documents/document-service";
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

describe.skipIf(!hasDatabase)("batchMove artifacts", () => {
  it("valid batch move updates projectId for all artifacts", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectAId = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const projectBId = await createTestProject(orgId, user.id, {
        name: "Project B",
      });

      // Create 3 artifacts in project A
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
            projectId: projectAId,
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
            projectId: projectAId,
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
            projectId: projectAId,
          },
        })
      );

      // Move all 3 to project B
      await documentService.batchMove(
        [artifact1.id, artifact2.id, artifact3.id],
        projectBId,
        orgId
      );

      // Verify all artifacts now have projectId: projectBId
      const artifacts = await withDb((db) =>
        db.artifact.findMany({
          where: {
            id: { in: [artifact1.id, artifact2.id, artifact3.id] },
          },
        })
      );

      expect(artifacts).toHaveLength(3);
      for (const artifact of artifacts) {
        expect(artifact.projectId).toBe(projectBId);
      }
    });
  });

  it("target project not found throws error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectAId = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const fakeProjectId = "01FAKE000000000000000000";

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectAId,
          },
        })
      );

      await expect(
        documentService.batchMove([artifact.id], fakeProjectId, orgId)
      ).rejects.toThrow();
    });
  });

  it("empty artifactIds array returns without error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectBId = await createTestProject(orgId, user.id, {
        name: "Project B",
      });
      await expect(
        documentService.batchMove([], projectBId, orgId)
      ).resolves.not.toThrow();
    });
  });
});
