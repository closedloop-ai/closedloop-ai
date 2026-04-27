/**
 * Integration tests for findRelatedDocuments service method.
 * Tests artifact link chain traversal for artifact relationships.
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

describe.skipIf(!hasDatabase)("findRelatedDocuments", () => {
  it("single artifact with no relations returns only self", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Standalone Artifact",
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

      const relatedIds = await documentsService.findRelatedDocuments(
        artifact.id,
        orgId
      );

      expect(relatedIds).toEqual([artifact.id]);
    });
  });

  it("parent-child chain returns all three", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Create PRD (root, no source)
      const prd = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "PRD",
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

      // Create Plan (source: PRD)
      const plan = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Implementation Plan",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link PRD → Plan
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: prd.id,
            targetId: plan.id,
            linkType: "PRODUCES",
          },
        })
      );

      // Create third artifact (source: Plan)
      const strategy = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Implementation Strategy",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link Plan → Strategy
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: plan.id,
            targetId: strategy.id,
            linkType: "PRODUCES",
          },
        })
      );

      // Test from any artifact in chain
      const fromPrd = await documentsService.findRelatedDocuments(
        prd.id,
        orgId
      );
      const fromPlan = await documentsService.findRelatedDocuments(
        plan.id,
        orgId
      );
      const fromStrategy = await documentsService.findRelatedDocuments(
        strategy.id,
        orgId
      );

      // All should return the same set
      const expected = [prd.id, plan.id, strategy.id].sort();
      expect(fromPrd.sort()).toEqual(expected);
      expect(fromPlan.sort()).toEqual(expected);
      expect(fromStrategy.sort()).toEqual(expected);
    });
  });

  it("multi-level hierarchy with multiple children", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      // Create root
      const root = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Root",
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

      // Create 2 children
      const child1 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Child 1",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link root → child1
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: root.id,
            targetId: child1.id,
            linkType: "PRODUCES",
          },
        })
      );

      const child2 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Child 2",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link root → child2
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: root.id,
            targetId: child2.id,
            linkType: "PRODUCES",
          },
        })
      );

      // Create 2 grandchildren
      const grandchild1 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Grandchild 1",
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

      // Link child1 → grandchild1
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: child1.id,
            targetId: grandchild1.id,
            linkType: "PRODUCES",
          },
        })
      );

      const grandchild2 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Grandchild 2",
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

      // Link child2 → grandchild2
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: orgId,
            sourceId: child2.id,
            targetId: grandchild2.id,
            linkType: "PRODUCES",
          },
        })
      );

      const relatedIds = await documentsService.findRelatedDocuments(
        root.id,
        orgId
      );

      const expected = [
        root.id,
        child1.id,
        child2.id,
        grandchild1.id,
        grandchild2.id,
      ].sort();
      expect(relatedIds.sort()).toEqual(expected);
    });
  });

  it("artifact not found returns empty array", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const relatedIds = await documentsService.findRelatedDocuments(
        fakeId,
        orgId
      );

      expect(relatedIds).toEqual([]);
    });
  });
});
