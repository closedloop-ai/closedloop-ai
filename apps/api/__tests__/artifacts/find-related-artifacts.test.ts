/**
 * Integration tests for findRelatedArtifacts service method.
 * Tests parent/child chain traversal for artifact relationships.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
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
      const projectId = await createTestProject(orgId);

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Standalone Artifact",
            type: "DOCUMENT",
            subtype: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
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
      const projectId = await createTestProject(orgId);

      // Create PRD (parent: null)
      const prd = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "PRD",
            type: "DOCUMENT",
            subtype: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
          },
        })
      );

      // Create Plan (parent: PRD.id)
      const plan = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Implementation Plan",
            type: "DOCUMENT",
            subtype: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: prd.id,
          },
        })
      );

      // Create third artifact (parent: Plan.id)
      const strategy = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Implementation Strategy",
            type: "DOCUMENT",
            subtype: "IMPLEMENTATION_STRATEGY",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: plan.id,
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
      const projectId = await createTestProject(orgId);

      // Create root
      const root = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Root",
            type: "DOCUMENT",
            subtype: "PRD",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
          },
        })
      );

      // Create 2 children
      const child1 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Child 1",
            type: "DOCUMENT",
            subtype: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: root.id,
          },
        })
      );

      const child2 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Child 2",
            type: "DOCUMENT",
            subtype: "IMPLEMENTATION_PLAN",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: root.id,
          },
        })
      );

      // Create 2 grandchildren
      const grandchild1 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Grandchild 1",
            type: "DOCUMENT",
            subtype: "CODE_REVIEW_REPORT",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: child1.id,
          },
        })
      );

      const grandchild2 = await withDb((db) =>
        db.artifact.create({
          data: {
            title: "Grandchild 2",
            type: "DOCUMENT",
            subtype: "TEST_REPORT",
            organizationId: orgId,
            generatedBy: user.id,
            projectId,
            parentId: child2.id,
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
