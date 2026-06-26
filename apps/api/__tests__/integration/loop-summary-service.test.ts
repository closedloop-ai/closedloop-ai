/**
 * Integration tests for `loopSummaryService.getSummariesForDocuments`.
 *
 * Exercises the recursive CTE against a real Postgres against the cycle guard,
 * depth bound, cross-org isolation, and the "one entry per requested
 * documentId" contract — none of which can be verified with mocked Prisma.
 *
 * Gated on RUN_DB_INTEGRATION_TESTS=true and DATABASE_URL.
 */
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { LinkType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { loopSummaryService } from "@/app/loops/loop-summary-service";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const env = keys();
const hasDatabase =
  !!env.DATABASE_URL && process.env.RUN_DB_INTEGRATION_TESTS === "true";

async function createTestArtifact(
  organizationId: string,
  projectId: string,
  name: string
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: "DOCUMENT",
        subtype: "FEATURE",
        name,
        status: "DRAFT",
      },
    })
  );
  return artifact.id;
}

async function createProducesLink(
  organizationId: string,
  sourceId: string,
  targetId: string
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.PRODUCES,
      },
    })
  );
}

async function createTestProject(
  organizationId: string,
  createdById: string
): Promise<string> {
  const project = await withDb((db) =>
    db.project.create({
      data: {
        organizationId,
        createdById,
        name: `Test Project ${Date.now()}`,
        description: "Integration test project",
      },
    })
  );
  return project.id;
}

async function createRunningLoop(
  organizationId: string,
  userId: string,
  artifactId: string
): Promise<string> {
  const loop = await withDb((db) =>
    db.loop.create({
      data: {
        organizationId,
        userId,
        artifactId,
        command: LoopCommand.Plan,
        status: LoopStatus.Running,
        startedAt: new Date(),
      },
    })
  );
  return loop.id;
}

describe.skipIf(!hasDatabase)(
  "loopSummaryService.getSummariesForDocuments — integration",
  () => {
    it("aggregates a loop on a direct PRODUCES child", async () => {
      const suffix = Date.now();
      const orgId = await createTestOrganization({
        clerkId: `org_loopsum_${suffix}`,
        slug: `org-loopsum-${suffix}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_loopsum_${suffix}`,
        email: `loopsum-${suffix}@example.com`,
      });
      const projectId = await createTestProject(orgId, user.id);
      const root = await createTestArtifact(orgId, projectId, "root");
      const child = await createTestArtifact(orgId, projectId, "child");
      await createProducesLink(orgId, root, child);
      const childLoopId = await createRunningLoop(orgId, user.id, child);

      const result = await loopSummaryService.getSummariesForDocuments(orgId, [
        root,
      ]);

      expect(result[root].activeLoop).not.toBeNull();
      expect(result[root].activeLoop?.loopId).toBe(childLoopId);
      expect(result[root].activeLoop?.isDirectLoop).toBe(false);
    });

    it("traverses recursively to grandchildren via PRODUCES", async () => {
      const suffix = Date.now();
      const orgId = await createTestOrganization({
        clerkId: `org_loopsum_grand_${suffix}`,
        slug: `org-loopsum-grand-${suffix}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_loopsum_grand_${suffix}`,
        email: `loopsum-grand-${suffix}@example.com`,
      });
      const projectId = await createTestProject(orgId, user.id);
      const root = await createTestArtifact(orgId, projectId, "root");
      const child = await createTestArtifact(orgId, projectId, "child");
      const grandchild = await createTestArtifact(orgId, projectId, "grand");
      await createProducesLink(orgId, root, child);
      await createProducesLink(orgId, child, grandchild);
      const grandLoopId = await createRunningLoop(orgId, user.id, grandchild);

      const result = await loopSummaryService.getSummariesForDocuments(orgId, [
        root,
      ]);

      expect(result[root].activeLoop?.loopId).toBe(grandLoopId);
    });

    it("terminates on a PRODUCES cycle (A -> B -> A) without infinite recursion", async () => {
      const suffix = Date.now();
      const orgId = await createTestOrganization({
        clerkId: `org_loopsum_cycle_${suffix}`,
        slug: `org-loopsum-cycle-${suffix}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_loopsum_cycle_${suffix}`,
        email: `loopsum-cycle-${suffix}@example.com`,
      });
      const projectId = await createTestProject(orgId, user.id);
      const a = await createTestArtifact(orgId, projectId, "a");
      const b = await createTestArtifact(orgId, projectId, "b");
      await createProducesLink(orgId, a, b);
      await createProducesLink(orgId, b, a);
      const loopId = await createRunningLoop(orgId, user.id, b);

      const result = await loopSummaryService.getSummariesForDocuments(orgId, [
        a,
      ]);

      // Reaches B once (directly via the A→B edge); the cycle guard prevents
      // re-traversing back to A. Loop on B surfaces as the active state for A.
      expect(result[a].activeLoop?.loopId).toBe(loopId);
    });

    it("isolates loops by organization (no cross-org leakage)", async () => {
      const suffix = Date.now();
      const orgIdA = await createTestOrganization({
        clerkId: `org_loopsum_orgA_${suffix}`,
        slug: `org-loopsum-orga-${suffix}`,
      });
      const orgIdB = await createTestOrganization({
        clerkId: `org_loopsum_orgB_${suffix}`,
        slug: `org-loopsum-orgb-${suffix}`,
      });
      const userA = await createTestUser(orgIdA, {
        clerkId: `clerk_loopsum_a_${suffix}`,
        email: `loopsum-a-${suffix}@example.com`,
      });
      const userB = await createTestUser(orgIdB, {
        clerkId: `clerk_loopsum_b_${suffix}`,
        email: `loopsum-b-${suffix}@example.com`,
      });
      const projectA = await createTestProject(orgIdA, userA.id);
      const projectB = await createTestProject(orgIdB, userB.id);
      // Create an artifact in org A so the org has data, but we'll only query
      // for artifactB (foreign-org) to assert no cross-org leakage.
      await createTestArtifact(orgIdA, projectA, "a");
      const artifactB = await createTestArtifact(orgIdB, projectB, "b");
      await createRunningLoop(orgIdB, userB.id, artifactB);

      // Caller from org A passes B's artifact ID — should get an empty summary
      // (no existence leak), not B's loop.
      const result = await loopSummaryService.getSummariesForDocuments(orgIdA, [
        artifactB,
      ]);
      expect(result[artifactB]).toEqual({
        activeLoop: null,
        latestCompleted: null,
        latestFailed: null,
      });
    });

    it("returns one entry per requested documentId, even when no descendants exist", async () => {
      const suffix = Date.now();
      const orgId = await createTestOrganization({
        clerkId: `org_loopsum_empty_${suffix}`,
        slug: `org-loopsum-empty-${suffix}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_loopsum_empty_${suffix}`,
        email: `loopsum-empty-${suffix}@example.com`,
      });
      const projectId = await createTestProject(orgId, user.id);
      const root = await createTestArtifact(orgId, projectId, "lonely");

      const result = await loopSummaryService.getSummariesForDocuments(orgId, [
        root,
      ]);
      expect(result[root]).toEqual({
        activeLoop: null,
        latestCompleted: null,
        latestFailed: null,
      });
    });
  }
);
