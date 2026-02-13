/**
 * Unit tests for batch move artifacts service method.
 * Tests cross-project artifact moves with atomicity.
 */
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactsService } from "@/app/artifacts/service";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

describe("batchMove artifacts", () => {
  let orgId: string;
  let userId: string;
  let projectAId: string;
  let projectBId: string;

  beforeEach(async () => {
    orgId = await createTestOrganization({
      clerkId: `org_test_${Date.now()}`,
      slug: `test-org-${Date.now()}`,
    });

    const user = await createTestUser(orgId, {
      clerkId: `clerk_test_${Date.now()}`,
    });
    userId = user.id;

    projectAId = await createTestProject(orgId, { name: "Project A" });
    projectBId = await createTestProject(orgId, { name: "Project B" });
  });

  it("valid batch move updates projectId for all artifacts", async () => {
    // Create 3 artifacts in project A
    const artifact1 = await withDb((db) =>
      db.artifact.create({
        data: {
          title: "Artifact 1",
          type: "DOCUMENT",
          subtype: "PRD",
          organizationId: orgId,
          generatedBy: userId,
          projectId: projectAId,
        },
      })
    );

    const artifact2 = await withDb((db) =>
      db.artifact.create({
        data: {
          title: "Artifact 2",
          type: "DOCUMENT",
          subtype: "PRD",
          organizationId: orgId,
          generatedBy: userId,
          projectId: projectAId,
        },
      })
    );

    const artifact3 = await withDb((db) =>
      db.artifact.create({
        data: {
          title: "Artifact 3",
          type: "DOCUMENT",
          subtype: "PRD",
          organizationId: orgId,
          generatedBy: userId,
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

  it("target project not found throws error", async () => {
    const fakeProjectId = "01FAKE000000000000000000";

    const artifact = await withDb((db) =>
      db.artifact.create({
        data: {
          title: "Artifact",
          type: "DOCUMENT",
          subtype: "PRD",
          organizationId: orgId,
          generatedBy: userId,
          projectId: projectAId,
        },
      })
    );

    await expect(
      artifactsService.batchMove([artifact.id], fakeProjectId, orgId)
    ).rejects.toThrow();
  });

  it("empty artifactIds array returns without error", async () => {
    await expect(
      artifactsService.batchMove([], projectBId, orgId)
    ).resolves.not.toThrow();
  });
});
