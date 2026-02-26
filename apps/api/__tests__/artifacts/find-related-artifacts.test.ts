/**
 * Integration tests for findRelatedArtifacts service method.
 * Tests entity link chain traversal for artifact relationships.
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

describe.skipIf(!hasDatabase)("findRelatedArtifacts", () => {
  it("single artifact with no relations returns only self", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Standalone Artifact",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      const relatedIds = await artifactsService.findRelatedArtifacts(
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
            title: "PRD",
            slug: generateSlug(),
            type: "PRD",
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
            title: "Implementation Plan",
            slug: generateSlug(),
            type: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link PRD → Plan
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: prd.id,
            sourceType: "ARTIFACT",
            targetId: plan.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      // Create third artifact (source: Plan)
      const strategy = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Implementation Strategy",
            slug: generateSlug(),
            type: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link Plan → Strategy
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: plan.id,
            sourceType: "ARTIFACT",
            targetId: strategy.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      // Test from any artifact in chain
      const fromPrd = await artifactsService.findRelatedArtifacts(
        prd.id,
        orgId
      );
      const fromPlan = await artifactsService.findRelatedArtifacts(
        plan.id,
        orgId
      );
      const fromStrategy = await artifactsService.findRelatedArtifacts(
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
            title: "Root",
            slug: generateSlug(),
            type: "PRD",
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
            title: "Child 1",
            slug: generateSlug(),
            type: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link root → child1
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: root.id,
            sourceType: "ARTIFACT",
            targetId: child1.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      const child2 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Child 2",
            slug: generateSlug(),
            type: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link root → child2
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: root.id,
            sourceType: "ARTIFACT",
            targetId: child2.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      // Create 2 grandchildren
      const grandchild1 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Grandchild 1",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link child1 → grandchild1
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: child1.id,
            sourceType: "ARTIFACT",
            targetId: grandchild1.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      const grandchild2 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Grandchild 2",
            slug: generateSlug(),
            type: "PRD",
            organizationId: orgId,
            createdById: user.id,
            projectId,
          },
        })
      );

      // Link child2 → grandchild2
      await withDb((db) =>
        db.entityLink.create({
          data: {
            organizationId: orgId,
            sourceId: child2.id,
            sourceType: "ARTIFACT",
            targetId: grandchild2.id,
            targetType: "ARTIFACT",
            linkType: "PRODUCES",
          },
        })
      );

      const relatedIds = await artifactsService.findRelatedArtifacts(
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

      const relatedIds = await artifactsService.findRelatedArtifacts(
        fakeId,
        orgId
      );

      expect(relatedIds).toEqual([]);
    });
  });
});
