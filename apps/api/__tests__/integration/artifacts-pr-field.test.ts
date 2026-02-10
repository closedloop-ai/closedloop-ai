import { WorkstreamState, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { artifactsService } from "@/app/artifacts/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)(
  "Artifacts Service Integration - pullRequest Field",
  () => {
    it("includes pullRequest field in findAll response when PR exists", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        // Create a workstream
        const workstream = await withDb((db) =>
          db.workstream.create({
            data: {
              id: `ws-${Date.now()}`,
              organizationId: testOrgId,
              projectId: testProjectId,
              createdById: testUser.id,
              title: "Test Workstream",
              state: WorkstreamState.INITIATED,
            },
          })
        );

        // Create an artifact associated with the workstream
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD with PR",
          content: "Content",
        });

        // Create a GitHub PR associated with the workstream
        await withDb((db) =>
          db.gitHubPullRequest.create({
            data: {
              workstreamId: workstream.id,
              repositoryId: `repo-${Date.now()}`,
              githubId: 123_456,
              number: 42,
              title: "Test PR",
              htmlUrl: "https://github.com/org/repo/pull/42",
              state: "OPEN",
              headBranch: "feature-branch",
              baseBranch: "main",
            },
          })
        );

        // Fetch artifacts via service
        const artifacts = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "PRD",
        });

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].pullRequest).toBeDefined();
        expect(artifacts[0].pullRequest).not.toBeNull();
        expect(artifacts[0].pullRequest?.number).toBe(42);
        expect(artifacts[0].pullRequest?.htmlUrl).toBe(
          "https://github.com/org/repo/pull/42"
        );
        expect(artifacts[0].pullRequest?.state).toBe("OPEN");
        expect(artifacts[0].pullRequest?.headBranch).toBe("feature-branch");
        expect(artifacts[0].pullRequest?.baseBranch).toBe("main");
      });
    });

    it("returns null pullRequest when artifact has no workstream", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        // Create artifact WITHOUT workstream
        await artifactsService.create(testOrgId, testUser.id, {
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD without workstream",
          content: "Content",
        });

        const artifacts = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "PRD",
        });

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].pullRequest).toBeNull();
      });
    });

    it("returns null pullRequest when workstream has no PR", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        // Create workstream without PR
        const workstream = await withDb((db) =>
          db.workstream.create({
            data: {
              id: `ws-no-pr-${Date.now()}`,
              organizationId: testOrgId,
              projectId: testProjectId,
              createdById: testUser.id,
              title: "Workstream without PR",
              state: WorkstreamState.INITIATED,
            },
          })
        );

        // Create artifact with workstream but no PR
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD with workstream, no PR",
          content: "Content",
        });

        const artifacts = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "PRD",
        });

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].pullRequest).toBeNull();
      });
    });

    it("returns most recent PR when workstream has multiple PRs", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        const workstream = await withDb((db) =>
          db.workstream.create({
            data: {
              id: `ws-multi-pr-${Date.now()}`,
              organizationId: testOrgId,
              projectId: testProjectId,
              createdById: testUser.id,
              title: "Workstream with multiple PRs",
              state: WorkstreamState.INITIATED,
            },
          })
        );

        // Create artifact
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD with multiple PRs",
          content: "Content",
        });

        // Create older PR
        await withDb((db) =>
          db.gitHubPullRequest.create({
            data: {
              workstreamId: workstream.id,
              repositoryId: `repo-multi-pr-${Date.now()}`,
              githubId: 1001,
              number: 10,
              title: "Older PR",
              htmlUrl: "https://github.com/org/repo/pull/10",
              state: "MERGED",
              headBranch: "old-feature",
              baseBranch: "main",
              createdAt: new Date("2024-01-01T10:00:00Z"),
            },
          })
        );

        // Create newer PR
        await withDb((db) =>
          db.gitHubPullRequest.create({
            data: {
              workstreamId: workstream.id,
              repositoryId: `repo-multi-pr-${Date.now()}`,
              githubId: 1002,
              number: 20,
              title: "Newer PR",
              htmlUrl: "https://github.com/org/repo/pull/20",
              state: "OPEN",
              headBranch: "new-feature",
              baseBranch: "main",
              createdAt: new Date("2024-01-15T10:00:00Z"),
            },
          })
        );

        const artifacts = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "PRD",
        });

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].pullRequest).toBeDefined();
        // Should return the newer PR (number 20)
        expect(artifacts[0].pullRequest?.number).toBe(20);
        expect(artifacts[0].pullRequest?.title).toBe("Newer PR");
      });
    });

    it("shares same PR across multiple artifacts with same workstream", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        const workstream = await withDb((db) =>
          db.workstream.create({
            data: {
              id: `ws-shared-${Date.now()}`,
              organizationId: testOrgId,
              projectId: testProjectId,
              createdById: testUser.id,
              title: "Shared workstream",
              state: WorkstreamState.INITIATED,
            },
          })
        );

        // Create PR for workstream
        await withDb((db) =>
          db.gitHubPullRequest.create({
            data: {
              workstreamId: workstream.id,
              repositoryId: `repo-shared-${Date.now()}`,
              githubId: 2001,
              number: 100,
              title: "Shared PR",
              htmlUrl: "https://github.com/org/repo/pull/100",
              state: "OPEN",
              headBranch: "shared-feature",
              baseBranch: "main",
            },
          })
        );

        // Create PRD
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD in shared workstream",
          content: "PRD content",
        });

        // Create implementation plan
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "IMPLEMENTATION_PLAN",
          title: "Plan in shared workstream",
          content: "Plan content",
        });

        // Fetch all artifacts
        const artifacts = await artifactsService.findAll({
          organizationId: testOrgId,
          latestOnly: true,
        });

        expect(artifacts).toHaveLength(2);

        // Both artifacts should reference the same PR
        const prdArtifact = artifacts.find((a) => a.subtype === "PRD");
        const planArtifact = artifacts.find(
          (a) => a.subtype === "IMPLEMENTATION_PLAN"
        );

        expect(prdArtifact?.pullRequest?.number).toBe(100);
        expect(planArtifact?.pullRequest?.number).toBe(100);
        expect(prdArtifact?.pullRequest?.htmlUrl).toBe(
          planArtifact?.pullRequest?.htmlUrl
        );
      });
    });

    it("filters artifacts by subtype and includes pullRequest field", async () => {
      await autoRollbackTransaction(async () => {
        const testOrgId = await createTestOrganization();
        const testProjectId = await createTestProject(testOrgId);
        const testUser = await createTestUser(testOrgId);

        const workstream = await withDb((db) =>
          db.workstream.create({
            data: {
              id: `ws-filter-${Date.now()}`,
              organizationId: testOrgId,
              projectId: testProjectId,
              createdById: testUser.id,
              title: "Filter test workstream",
              state: WorkstreamState.INITIATED,
            },
          })
        );

        await withDb((db) =>
          db.gitHubPullRequest.create({
            data: {
              workstreamId: workstream.id,
              repositoryId: `repo-filter-${Date.now()}`,
              githubId: 3001,
              number: 50,
              title: "Filter test PR",
              htmlUrl: "https://github.com/org/repo/pull/50",
              state: "OPEN",
              headBranch: "filter-feature",
              baseBranch: "main",
            },
          })
        );

        // Create PRD
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "PRD",
          title: "PRD for filtering",
          content: "Content",
        });

        // Create Plan (should be filtered out when querying for PRDs)
        await artifactsService.create(testOrgId, testUser.id, {
          workstreamId: workstream.id,
          projectId: testProjectId,
          subtype: "IMPLEMENTATION_PLAN",
          title: "Plan for filtering",
          content: "Content",
        });

        // Query only PRDs
        const prds = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "PRD",
        });

        expect(prds).toHaveLength(1);
        expect(prds[0].subtype).toBe("PRD");
        expect(prds[0].pullRequest?.number).toBe(50);

        // Query only plans
        const plans = await artifactsService.findAll({
          organizationId: testOrgId,
          subtype: "IMPLEMENTATION_PLAN",
        });

        expect(plans).toHaveLength(1);
        expect(plans[0].subtype).toBe("IMPLEMENTATION_PLAN");
        expect(plans[0].pullRequest?.number).toBe(50);
      });
    });
  }
);
