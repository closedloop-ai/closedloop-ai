import { keys } from "@repo/database/keys";
import { externalLinksService } from "@/app/external-links/service";
import { workstreamsService } from "@/app/workstreams/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

async function setupTestData() {
  const testOrgId = await createTestOrganization();
  const testProjectId = await createTestProject(testOrgId);
  const testUser = await createTestUser(testOrgId);
  return { testOrgId, testProjectId, testUser };
}

describe.skipIf(!hasDatabase)("External Links Service Integration", () => {
  it("creates and retrieves an external link", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const link = await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      expect(link.id).toBeDefined();
      expect(link.organizationId).toBe(testOrgId);
      expect(link.type).toBe("PULL_REQUEST");
      expect(link.title).toBe("PR #42");
      expect(link.externalUrl).toBe("https://github.com/org/repo/pull/42");
      expect(link.metadata).toBeNull();

      const found = await externalLinksService.findById(link.id, testOrgId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(link.id);
    });
  });

  it("creates link with workstream and metadata", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const workstream = await workstreamsService.create(
        testOrgId,
        testUser.id,
        {
          projectId: testProjectId,
          title: "Test Workstream",
          description: "Test",
        }
      );

      const link = await externalLinksService.create(testOrgId, {
        type: "PREVIEW_DEPLOYMENT",
        title: "Preview",
        externalUrl: "https://preview.vercel.app",
        workstreamId: workstream.id,
        metadata: { state: "ready", environment: "preview" },
      });

      expect(link.workstreamId).toBe(workstream.id);
      expect(link.metadata).toEqual({
        state: "ready",
        environment: "preview",
      });
    });
  });

  it("finds links by workstream", async () => {
    await autoRollbackTransaction(async () => {
      const { testOrgId, testProjectId, testUser } = await setupTestData();

      const workstream = await workstreamsService.create(
        testOrgId,
        testUser.id,
        {
          projectId: testProjectId,
          title: "Test Workstream",
          description: "Test",
        }
      );

      await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #1",
        externalUrl: "https://github.com/org/repo/pull/1",
        workstreamId: workstream.id,
      });

      await externalLinksService.create(testOrgId, {
        type: "PREVIEW_DEPLOYMENT",
        title: "Preview",
        externalUrl: "https://preview.vercel.app",
        workstreamId: workstream.id,
      });

      const allLinks = await externalLinksService.findByWorkstream(
        workstream.id
      );
      expect(allLinks).toHaveLength(2);

      const deploymentLinks = await externalLinksService.findByWorkstream(
        workstream.id,
        "PREVIEW_DEPLOYMENT"
      );
      expect(deploymentLinks).toHaveLength(1);
      expect(deploymentLinks[0].type).toBe("PREVIEW_DEPLOYMENT");
    });
  });

  it("finds links with org and type filters", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #1",
        externalUrl: "https://github.com/org/repo/pull/1",
      });

      await externalLinksService.create(testOrgId, {
        type: "FIGMA_DESIGN",
        title: "Design File",
        externalUrl: "https://figma.com/file/abc",
      });

      const all = await externalLinksService.findAll({
        organizationId: testOrgId,
      });
      expect(all).toHaveLength(2);

      const prs = await externalLinksService.findAll({
        organizationId: testOrgId,
        type: "PULL_REQUEST",
      });
      expect(prs).toHaveLength(1);
      expect(prs[0].type).toBe("PULL_REQUEST");
    });
  });

  it("updates external link", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const link = await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      const updated = await externalLinksService.update(testOrgId, link.id, {
        title: "PR #42 - Updated",
        externalUrl: "https://github.com/org/repo/pull/42/files",
      });

      expect(updated.title).toBe("PR #42 - Updated");
      expect(updated.externalUrl).toBe(
        "https://github.com/org/repo/pull/42/files"
      );
    });
  });

  it("deletes external link", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const link = await externalLinksService.create(testOrgId, {
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      await externalLinksService.delete(testOrgId, link.id);

      const found = await externalLinksService.findById(link.id, testOrgId);
      expect(found).toBeNull();
    });
  });

  it("enforces org isolation on findById", async () => {
    await autoRollbackTransaction(async () => {
      const org1Id = await createTestOrganization({
        clerkId: "org_1",
        name: "Org 1",
        slug: "org-1",
      });
      const org2Id = await createTestOrganization({
        clerkId: "org_2",
        name: "Org 2",
        slug: "org-2",
      });

      const link = await externalLinksService.create(org1Id, {
        type: "PULL_REQUEST",
        title: "PR #42",
        externalUrl: "https://github.com/org/repo/pull/42",
      });

      // Same org can find it
      const found = await externalLinksService.findById(link.id, org1Id);
      expect(found).not.toBeNull();

      // Different org cannot find it
      const notFound = await externalLinksService.findById(link.id, org2Id);
      expect(notFound).toBeNull();
    });
  });
});
