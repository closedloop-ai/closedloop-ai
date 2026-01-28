import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { v7 as uuidv7 } from "uuid";
import { artifactsService } from "@/app/artifacts/service";
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
      const testUserId = uuidv7();

      // Create artifact without documentSlug - should auto-generate from title
      const artifact = await artifactsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Requirements",
        content: "Feature details...",
      });

      expect(artifact).not.toBeNull();
      expect(artifact!.version).toBe(1);
      expect(artifact!.isLatest).toBe(true);
      expect(artifact!.documentSlug).toBeDefined();
      expect(artifact!.title).toBe("My Feature Requirements");
    });
  });

  it("returns null when no project/workstream provided", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUserId = uuidv7();

      // Create artifact without projectId or workstreamId - should return null
      const artifact = await artifactsService.create(testOrgId, testUserId, {
        type: "PRD",
        title: "Standalone Feature",
        content: "Feature details...",
      });

      expect(artifact).toBeNull();
    });
  });

  it("creates multiple artifacts with version 1", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUserId = uuidv7();

      // Create first artifact (v1)
      const v1 = await artifactsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature",
        content: "Version 1 content",
      });

      expect(v1).not.toBeNull();
      expect(v1!.version).toBe(1);
      expect(v1!.isLatest).toBe(true);

      // Create second artifact - also v1 (versioning removed)
      const v2 = await artifactsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature Updated",
        content: "Version 2 content",
      });

      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(1);
      expect(v2!.isLatest).toBe(true);

      // Both artifacts exist independently
      const v1Unchanged = await artifactsService.findByIdSimple(
        v1!.id,
        testOrgId
      );
      expect(v1Unchanged?.isLatest).toBe(true);
    });
  });

  it("createNewVersion creates linked version of artifact", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUserId = uuidv7();

      // Create original artifact
      const original = await artifactsService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Original Plan",
        content: "# Original Content\n\nOriginal implementation details",
        status: "APPROVED",
      });

      expect(original).not.toBeNull();

      // Create new version with updated content
      const newVersion = await artifactsService.createNewVersion(
        original!.id,
        testOrgId,
        "# Updated Content\n\nUpdated implementation details"
      );

      expect(newVersion).toBeDefined();
      expect(newVersion.version).toBe(2); // Versioned via createArtifactVersion
      expect(newVersion.isLatest).toBe(true);
      expect(newVersion.content).toBe(
        "# Updated Content\n\nUpdated implementation details"
      );
      expect(newVersion.title).toBe(original!.title);
      expect(newVersion.projectId).toBe(original!.projectId);
      expect(newVersion.type).toBe(original!.type);

      // Original should still exist and be marked as not latest
      const originalAfter = await artifactsService.findByIdSimple(
        original!.id,
        testOrgId
      );
      expect(originalAfter).not.toBeNull();
      expect(originalAfter!.isLatest).toBe(false);
    });
  });

  it("findOrCreateWorkstream finds existing workstream", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUserId = uuidv7();

      // Create a workstream manually
      const workstream = await withDb((db) =>
        db.workstream.create({
          data: {
            organizationId: testOrgId,
            projectId: testProjectId,
            title: "Test Workstream",
            description: "Test description",
            createdById: testUserId,
          },
        })
      );

      // Create PRD artifact linked to workstream
      const prd = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: testOrgId,
            projectId: testProjectId,
            workstreamId: workstream.id,
            type: "PRD",
            title: "Feature PRD",
            content: "PRD content here",
            version: 1,
            isLatest: true,
          },
        })
      );

      // Create implementation plan linked to same workstream
      const plan = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: testOrgId,
            projectId: testProjectId,
            workstreamId: workstream.id,
            type: "IMPLEMENTATION_PLAN",
            title: "Implementation Plan: Feature PRD",
            content: "Plan content",
            version: 1,
            isLatest: true,
          },
        })
      );

      // Fetch plan with workstream context
      const planWithContext = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: plan.id },
          include: {
            workstream: {
              include: {
                project: {
                  include: {
                    repositories: true,
                  },
                },
              },
            },
          },
        })
      );

      // Find or create workstream should return existing
      const result = await artifactsService.findOrCreateWorkstream(
        testOrgId,
        planWithContext as any,
        testUserId
      );

      expect(result.workstream).not.toBeNull();
      expect(result.workstream?.id).toBe(workstream.id);
      expect(result.prdArtifact).not.toBeNull();
      expect(result.prdArtifact?.id).toBe(prd.id);
    });
  });

  it("findOrCreateWorkstream creates workstream from PRD title match", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUserId = uuidv7();

      // Create PRD artifact (no workstream)
      const prd = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: testOrgId,
            projectId: testProjectId,
            type: "PRD",
            title: "User Authentication",
            content: "PRD content for auth feature",
            version: 1,
            isLatest: true,
          },
        })
      );

      // Create plan without workstream, but with title matching PRD
      const plan = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: testOrgId,
            projectId: testProjectId,
            type: "IMPLEMENTATION_PLAN",
            title: "Implementation Plan: User Authentication",
            content: "Implementation details",
            version: 1,
            isLatest: true,
          },
        })
      );

      // Call findOrCreateWorkstream
      const result = await artifactsService.findOrCreateWorkstream(
        testOrgId,
        {
          id: plan.id,
          title: plan.title,
          projectId: plan.projectId,
          parentId: null,
          workstream: null,
        } as any,
        testUserId
      );

      // Should auto-create workstream and link artifacts
      expect(result.workstream).not.toBeNull();
      expect(result.prdArtifact).not.toBeNull();
      expect(result.prdArtifact?.id).toBe(prd.id);

      // Verify artifacts were linked to new workstream
      const updatedPlan = await withDb((db) =>
        db.artifact.findUnique({ where: { id: plan.id } })
      );
      const updatedPrd = await withDb((db) =>
        db.artifact.findUnique({ where: { id: prd.id } })
      );

      expect(updatedPlan?.workstreamId).toBe(result.workstream?.id);
      expect(updatedPrd?.workstreamId).toBe(result.workstream?.id);
    });
  });
});
