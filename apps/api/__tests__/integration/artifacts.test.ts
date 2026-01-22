import { keys } from "@repo/database/keys";
import { artifactsService } from "@/app/artifacts/service";
import { projectsService } from "@/app/projects/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Artifacts Service Integration", () => {
  it("creates artifact with auto-versioning and auto-slug generation", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);

      // Create artifact without documentSlug - should auto-generate from title
      const artifact = await artifactsService.create(testOrgId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Requirements",
        content: "Feature details...",
      });

      expect(artifact.version).toBe(1);
      expect(artifact.isLatest).toBe(true);
      expect(artifact.documentSlug).toBe("my-feature-requirements");
      expect(artifact.title).toBe("My Feature Requirements");
    });
  });

  it("creates artifact with default project when no project/workstream provided", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      // Create artifact without projectId or workstreamId
      const artifact = await artifactsService.create(testOrgId, {
        type: "PRD",
        title: "Standalone Feature",
        content: "Feature details...",
      });

      expect(artifact.projectId).toBeDefined();
      expect(artifact.projectId).not.toBeNull();
      expect(artifact.version).toBe(1);
      expect(artifact.isLatest).toBe(true);

      // Verify the default project was created
      const projects = await projectsService.findByOrganization(testOrgId);
      const defaultProject = projects.find((p) => p.name === "Default Project");
      expect(defaultProject).toBeDefined();
      expect(artifact.projectId).toBe(defaultProject?.id);
    });
  });

  it("increments version when creating artifact with same scope", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);

      // Create first artifact (v1)
      const v1 = await artifactsService.create(testOrgId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature",
        documentSlug: "my-feature",
        content: "Version 1 content",
      });

      expect(v1.version).toBe(1);
      expect(v1.isLatest).toBe(true);

      // Create second artifact with same scope (v2)
      const v2 = await artifactsService.create(testOrgId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Updated",
        documentSlug: "my-feature",
        content: "Version 2 content",
      });

      expect(v2.version).toBe(2);
      expect(v2.isLatest).toBe(true);

      // Verify v1 is no longer latest
      const v1Updated = await artifactsService.findByIdSimple(v1.id, testOrgId);
      expect(v1Updated?.isLatest).toBe(false);
    });
  });

  it("duplicates artifact with correct versioning", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);

      // Create original artifact
      const original = await artifactsService.create(testOrgId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Original Plan",
        fileName: "plan.md",
        documentSlug: "plan",
        content: "Original content",
        status: "APPROVED",
      });

      expect(original.version).toBe(1);
      expect(original.isLatest).toBe(true);

      // Duplicate the artifact
      const duplicate = await artifactsService.duplicate(
        original.id,
        testOrgId
      );

      // Verify duplicate has correct properties
      expect(duplicate.version).toBe(2);
      expect(duplicate.isLatest).toBe(true);
      expect(duplicate.title).toBe("Original Plan (Copy)");
      expect(duplicate.fileName).toBe("plan-copy.md");
      expect(duplicate.documentSlug).toBe("plan"); // Same slug = same version group
      expect(duplicate.content).toBe("Original content");
      expect(duplicate.status).toBe("DRAFT"); // Status reset to DRAFT
      expect(duplicate.projectId).toBe(original.projectId);

      // Verify original is no longer latest
      const originalUpdated = await artifactsService.findByIdSimple(
        original.id,
        testOrgId
      );
      expect(originalUpdated?.isLatest).toBe(false);
    });
  });

  it("duplicate throws error when artifact not found", async () => {
    const testOrgId = await autoRollbackTransaction(() =>
      createTestOrganization()
    );

    // Try to duplicate non-existent artifact - should throw error
    await expect(
      artifactsService.duplicate("non-existent-id", testOrgId)
    ).rejects.toThrow();
  });
});
