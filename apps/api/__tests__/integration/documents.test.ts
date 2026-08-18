import { DocumentType } from "@repo/api/src/types/document";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
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

      const artifact = await documentService.create(testOrgId, testUserId, {
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

  it("creates an unparented DOC when no project is provided", async () => {
    await autoRollbackTransaction(async () => {
      // Org-level artifacts — a generic Document (DOC) or a Template — may be
      // created without a project (FEA-1749/FEA-4345) and yield projectId=null.
      // SSOT: isProjectOptionalDocumentType.
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);

      const artifact = await documentService.create(testOrgId, testUser.id, {
        type: DocumentType.Doc,
        title: "Standalone Document",
        content: "Evergreen details...",
      } as Parameters<typeof documentService.create>[2]);

      // `not.toBeNull()` alone still passes for `undefined`, so narrow to a
      // defined record before asserting the org-level (projectId=null) shape.
      expect(artifact).toBeDefined();
      expect(artifact).not.toBeNull();
      expect(artifact?.projectId ?? null).toBeNull();
    });
  });

  it("rejects a project-bound PRD create when no project is provided", async () => {
    await autoRollbackTransaction(async () => {
      // Project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE) require a
      // project (FEA-4345). The service-layer guard in createDocumentRecord
      // returns null — the "failed to create" contract callers already handle —
      // rather than silently persisting a project-less PRD.
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);

      const artifact = await documentService.create(testOrgId, testUser.id, {
        type: DocumentType.Prd,
        title: "Standalone Feature",
        content: "Feature details...",
      } as Parameters<typeof documentService.create>[2]);

      expect(artifact).toBeNull();
    });
  });

  it("creates multiple artifacts each with latestVersion 1", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testUser = await createTestUser(testOrgId);
      const testProjectId = await createTestProject(testOrgId, testUser.id);
      const testUserId = testUser.id;

      // Create first artifact
      const a1 = await documentService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "My Feature",
        content: "Version 1 content",
      });

      expect(a1).not.toBeNull();
      expect(a1!.latestVersion).toBe(1);

      // Create second artifact - independent, also latestVersion 1
      const a2 = await documentService.create(testOrgId, testUserId, {
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
      const original = await documentService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Original Plan",
        content: "# Original Content\n\nOriginal implementation details",
        status: "APPROVED",
      });

      expect(original).not.toBeNull();

      // Create new version with updated content
      const updated = await documentVersionService.createNewVersion(
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
      const originalAfter = await documentService.findByIdSimple(
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
      await documentService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "PRD",
        title: "Test PRD",
        content: "PRD content",
      });

      await documentService.create(testOrgId, testUserId, {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Test Plan",
        content: "Plan content",
      });

      // Filter by type
      const prds = await documentService.findAll({
        organizationId: testOrgId,
        type: "PRD",
      });

      expect(prds).toHaveLength(1);
      expect(prds[0].type).toBe("PRD");
    });
  });

  it("lists only project-less DOC docs for the org (FEA-4140)", async () => {
    await autoRollbackTransaction(async () => {
      // Two orgs, each with a project. Org A gets: a project-less DOC (the
      // one the org index should return), a project-attached DOC (excluded —
      // it belongs to a project), and a project-less TEMPLATE (excluded —
      // wrong type). The TEMPLATE must be a project-optional subtype that
      // actually persists (a project-less PRD is rejected by the FEA-4345
      // guard, so it never lands and could not exercise the type filter). Org
      // B gets its own project-less DOC that must never leak into org A's
      // result (org isolation).
      const orgA = await createTestOrganization();
      const userA = await createTestUser(orgA);
      const projectA = await createTestProject(orgA, userA.id);

      const orgB = await createTestOrganization();
      const userB = await createTestUser(orgB);

      const orgLevelDoc = await documentService.create(orgA, userA.id, {
        type: DocumentType.Doc,
        title: "Org A evergreen doc",
        content: "Evergreen content",
      } as Parameters<typeof documentService.create>[2]);

      await documentService.create(orgA, userA.id, {
        projectId: projectA,
        type: DocumentType.Doc,
        title: "Org A project doc",
        content: "Project-scoped content",
      });

      const orgLevelTemplate = await documentService.create(orgA, userA.id, {
        type: DocumentType.Template,
        title: "Org A standalone template",
        content: "Template content",
      } as Parameters<typeof documentService.create>[2]);

      // The wrong-type fixture must actually persist for the type filter to
      // have something to exclude; a null here means the fixture never landed.
      expect(orgLevelTemplate).toBeDefined();
      expect(orgLevelTemplate).not.toBeNull();
      expect(orgLevelTemplate?.projectId ?? null).toBeNull();

      await documentService.create(orgB, userB.id, {
        type: DocumentType.Doc,
        title: "Org B evergreen doc",
        content: "Other-org content",
      } as Parameters<typeof documentService.create>[2]);

      const results = await documentService.findAll({
        organizationId: orgA,
        type: DocumentType.Doc,
        unassignedProject: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(orgLevelDoc?.id);
      expect(results[0].type).toBe(DocumentType.Doc);
      expect(results[0].projectId ?? null).toBeNull();
    });
  });
});
