/**
 * Integration tests for batch move artifacts service method.
 * Tests cross-project artifact moves with atomicity.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { generateSlug } from "@/app/artifacts/artifact-utils";
import { artifactsService } from "@/app/artifacts/service";
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
      const projectAId = await createTestProject(orgId, { name: "Project A" });
      const projectBId = await createTestProject(orgId, { name: "Project B" });

      // Create 3 artifacts in project A
      const artifact1 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Artifact 1",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId: projectAId,
          },
        })
      );

      const artifact2 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Artifact 2",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId: projectAId,
          },
        })
      );

      const artifact3 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Artifact 3",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId: projectAId,
          },
        })
      );

      // Move all 3 to project B
      await artifactsService.batchMove(
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
      const projectAId = await createTestProject(orgId, { name: "Project A" });
      const fakeProjectId = "01FAKE000000000000000000";

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Artifact",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId: projectAId,
          },
        })
      );

      await expect(
        artifactsService.batchMove([artifact.id], fakeProjectId, orgId)
      ).rejects.toThrow();
    });
  });

  it("empty artifactIds array returns without error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const projectBId = await createTestProject(orgId, { name: "Project B" });
      await expect(
        artifactsService.batchMove([], projectBId, orgId)
      ).resolves.not.toThrow();
    });
  });
});
