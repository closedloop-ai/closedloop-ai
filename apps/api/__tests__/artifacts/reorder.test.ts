/**
 * Unit tests for artifact reorder service method.
 * Tests sortOrder assignment and validation.
 */
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactsService } from "@/app/artifacts/service";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

describe("reorder artifacts", () => {
  let orgId: string;
  let userId: string;
  let projectId: string;

  beforeEach(async () => {
    orgId = await createTestOrganization({
      clerkId: `org_test_${Date.now()}`,
      slug: `test-org-${Date.now()}`,
    });

    const user = await createTestUser(orgId, {
      clerkId: `clerk_test_${Date.now()}`,
    });
    userId = user.id;

    projectId = await createTestProject(orgId);
  });

  it("valid reorder assigns sortOrder 0, 1, 2 in order", async () => {
    // Create 3 artifacts
    const artifact1 = await withDb((db) =>
      db.artifact.create({
        data: {
          title: "Artifact 1",
          type: "DOCUMENT",
          subtype: "PRD",
          organizationId: orgId,
          generatedBy: userId,
          projectId,
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
          projectId,
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
          projectId,
        },
      })
    );

    // Reorder: 3, 1, 2
    await artifactsService.reorder(
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

  it("empty array returns without error", async () => {
    await expect(artifactsService.reorder([], orgId)).resolves.not.toThrow();
  });

  it("non-existent artifact ID throws error", async () => {
    const fakeId = "01FAKE000000000000000000";

    await expect(artifactsService.reorder([fakeId], orgId)).rejects.toThrow();
  });
});
