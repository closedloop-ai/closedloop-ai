import { keys } from "@repo/database/keys";
import { v7 as uuidv7 } from "uuid";
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

describe.skipIf(!hasDatabase)("Artifacts Service Integration", () => {
  it("creates artifact with auto-slug generation", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);
      const testProjectId = await createTestProject(testOrgId, testUser.id);
      const testUserId = testUser.id;

      const artifact = await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Requirements",
        content: "Feature details...",
      });

      expect(artifact).not.toBeNull();
      expect(artifact!.slug).toBeDefined();
      expect(artifact!.latestVersion).toBe(1);
      expect(artifact!.title).toBe("My Feature Requirements");
    });
  });

  it("throws error when no project/workstream provided for non-template artifacts", async () => {
    // This validation happens before any database operation, so we don't need autoRollbackTransaction
    const testOrgId = uuidv7();
    const testUserId = uuidv7();

    // Create artifact without projectId or workstreamId - should throw error
    // Type assertion needed to test runtime validation of missing projectId
    await expect(
      documentsService.create(testOrgId, testUserId, {
        type: "PRD",
        title: "Standalone Feature",
        content: "Feature details...",
      } as Parameters<typeof documentsService.create>[2])
    ).rejects.toThrow(
      "Artifacts (except templates) must be associated with a project or workstream"
    );
  });

  it("creates multiple artifacts each with latestVersion 1", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);
      const testProjectId = await createTestProject(testOrgId, testUser.id);
      const testUserId = testUser.id;

      // Create first artifact
      const a1 = await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature",
        content: "Version 1 content",
      });

      expect(a1).not.toBeNull();
      expect(a1!.latestVersion).toBe(1);

      // Create second artifact - independent, also latestVersion 1
      const a2 = await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Updated",
        content: "Version 2 content",
      });

      expect(a2).not.toBeNull();
      expect(a2!.latestVersion).toBe(1);
    });
  });

  it("createNewVersion creates a new version of artifact content", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);
      const testProjectId = await createTestProject(testOrgId, testUser.id);
      const testUserId = testUser.id;

      // Create original artifact
      const original = await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Original Plan",
        content: "# Original Content\n\nOriginal implementation details",
        status: "APPROVED",
      });

      expect(original).not.toBeNull();

      // Create new version with updated content
      const updated = await documentsService.createNewVersion(
        original!.id,
        testOrgId,
        testUserId,
        "# Updated Content\n\nUpdated implementation details"
      );

      expect(updated).toBeTruthy();
      expect(updated!.title).toBe(original!.title);
      expect(updated!.projectId).toBe(original!.projectId);
      expect(updated!.type).toBe(original!.type);

      // Original should still exist
      const originalAfter = await documentsService.findByIdSimple(
        original!.id,
        testOrgId
      );
      expect(originalAfter).not.toBeNull();
    });
  });

  it("findAll filters by type", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);
      const testProjectId = await createTestProject(testOrgId, testUser.id);
      const testUserId = testUser.id;

      // Create a PRD and a plan
      await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "Test PRD",
        content: "PRD content",
      });

      await documentsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Test Plan",
        content: "Plan content",
      });

      // Filter by type
      const prds = await documentsService.findAll({
        organizationId: testOrgId,
        type: "PRD",
      });

      expect(prds).toHaveLength(1);
      expect(prds[0].type).toBe("PRD");
    });
  });
});
