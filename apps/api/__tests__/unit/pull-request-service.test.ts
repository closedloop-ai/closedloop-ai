import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ChecksStatus: {
    UNKNOWN: "UNKNOWN",
    PENDING: "PENDING",
    PASSING: "PASSING",
    FAILING: "FAILING",
  },
  GitHubPRState: {
    OPEN: "OPEN",
    CLOSED: "CLOSED",
    MERGED: "MERGED",
  },
  ReviewDecision: {
    APPROVED: "APPROVED",
    CHANGES_REQUESTED: "CHANGES_REQUESTED",
    REVIEW_REQUIRED: "REVIEW_REQUIRED",
  },
}));

import {
  ArtifactType,
  ChecksStatus,
  GitHubPRState,
  ReviewDecision,
} from "@repo/database";
import {
  pullRequestService,
  type UpsertBranchArtifactInput,
} from "@/app/pull-requests/pull-request-service";

const ORG_ID = "org-1";
const PROJECT_ID = "proj-1";
const REPO_ID = "repo-1";
const expectedPullRequestInclude = {
  pullRequest: true,
  branch: { include: { currentPullRequestDetail: true } },
};

function baseUpsertInput(
  overrides: Partial<UpsertBranchArtifactInput> = {}
): UpsertBranchArtifactInput {
  return {
    organizationId: ORG_ID,
    repositoryId: REPO_ID,
    githubId: "gh-123",
    number: 42,
    title: "Add feature",
    htmlUrl: "https://github.com/o/r/pull/42",
    headBranch: "feature",
    baseBranch: "main",
    headSha: "abc123",
    prState: GitHubPRState.OPEN,
    isDraft: false,
    projectId: PROJECT_ID,
    ...overrides,
  };
}

describe("pullRequestService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("upsertBranchArtifact", () => {
    it("creates a new artifact + detail when no PR exists for githubId", async () => {
      const created = {
        id: "art-1",
        branch: { currentPullRequestDetail: null },
        pullRequest: null,
      };
      const reread = {
        id: "art-1",
        branch: { currentPullRequestDetail: { id: "detail-1" } },
        pullRequest: null,
      };
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "detail-1" }),
        },
        gitHubInstallationRepository: {
          findUnique: vi.fn().mockResolvedValue({ fullName: "owner/repo" }),
        },
        branchDetail: {
          findUnique: vi.fn().mockResolvedValue({ headSha: "abc123" }),
          update: vi.fn(),
        },
        artifact: {
          create: vi.fn().mockResolvedValue(created),
          findUnique: vi.fn().mockResolvedValue(reread),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await pullRequestService.upsertBranchArtifact(
        baseUpsertInput()
      );

      expect(mockDb.pullRequestDetail.findUnique).toHaveBeenNthCalledWith(1, {
        where: { githubId: "gh-123" },
        select: { id: true, artifactId: true, branchArtifactId: true },
      });
      expect(mockDb.artifact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: ArtifactType.BRANCH,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          name: "feature",
          status: GitHubPRState.OPEN,
          externalUrl: "https://github.com/o/r/tree/feature",
          branch: {
            create: expect.objectContaining({
              repositoryId: REPO_ID,
              branchName: "feature",
              baseBranch: "main",
              headSha: "abc123",
            }),
          },
          pullRequestDetails: {
            create: expect.objectContaining({
              repositoryId: REPO_ID,
              githubId: "gh-123",
              number: 42,
              prState: GitHubPRState.OPEN,
              isDraft: false,
            }),
          },
        }),
        include: {
          pullRequest: true,
          branch: { include: { currentPullRequestDetail: true } },
        },
      });
      expect(mockDb.artifact.update).not.toHaveBeenCalled();
      expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "art-1" },
        data: { currentPullRequestDetailId: "detail-1" },
      });
      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "art-1" },
        include: expectedPullRequestInclude,
      });
      expect(result).toEqual({ ok: true, value: reread });
    });

    it("updates an existing artifact when detail already exists", async () => {
      const updated = { id: "art-99", pullRequest: { artifactId: "art-99" } };
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({
            id: "detail-99",
            artifactId: null,
            branchArtifactId: "art-99",
          }),
          update: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        branchDetail: {
          findUnique: vi.fn().mockResolvedValue({ headSha: "abc123" }),
          update: vi.fn(),
        },
        artifact: {
          findUnique: vi.fn().mockResolvedValue(updated),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          create: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await pullRequestService.upsertBranchArtifact(
        baseUpsertInput({
          prState: GitHubPRState.MERGED,
          mergedAt: new Date("2026-01-01"),
          mergeCommitSha: "deadbeef",
        })
      );

      expect(mockDb.artifact.create).not.toHaveBeenCalled();
      // Parent update is atomic via updateMany scoped by (id, organizationId).
      expect(mockDb.artifact.updateMany).toHaveBeenCalledWith({
        where: { id: "art-99", organizationId: ORG_ID },
        data: expect.objectContaining({
          name: "feature",
          status: GitHubPRState.MERGED,
          externalUrl: "https://github.com/o/r/tree/feature",
          projectId: PROJECT_ID,
        }),
      });
      expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "art-99" },
        data: expect.objectContaining({
          branchName: "feature",
          baseBranch: "main",
          headSha: "abc123",
        }),
      });
      // PR detail update is keyed by the stable PullRequestDetail.id.
      expect(mockDb.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { id: "detail-99" },
        data: expect.objectContaining({
          prState: GitHubPRState.MERGED,
          mergedAt: new Date("2026-01-01"),
          mergeCommitSha: "deadbeef",
        }),
      });
      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: {
          branchArtifactId: "art-99",
          isCurrent: true,
          id: { not: "detail-99" },
        },
        data: { isCurrent: false },
      });
      expect(result).toEqual({ ok: true, value: updated });
    });

    it("omits optional detail fields when not supplied on create", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        gitHubInstallationRepository: {
          findUnique: vi.fn().mockResolvedValue({ fullName: "owner/repo" }),
        },
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
          findUnique: vi.fn().mockResolvedValue({
            id: "art-1",
            pullRequest: null,
          }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertBranchArtifact(baseUpsertInput());

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.branch.create).not.toHaveProperty("checksStatus");
      expect(data.pullRequestDetails.create).not.toHaveProperty(
        "reviewDecision"
      );
    });

    it("includes checksStatus and reviewDecision when supplied on create", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        // D2: createPullRequest resolves the branch's normalized repo full name
        // from the installation repo before creating the branch row.
        gitHubInstallationRepository: {
          findUnique: vi.fn().mockResolvedValue({ fullName: "owner/repo" }),
        },
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
          findUnique: vi.fn().mockResolvedValue({
            id: "art-1",
            pullRequest: null,
          }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertBranchArtifact(
        baseUpsertInput({
          checksStatus: ChecksStatus.PASSING,
          reviewDecision: ReviewDecision.APPROVED,
        })
      );

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.branch.create.checksStatus).toBe(ChecksStatus.PASSING);
      expect(data.pullRequestDetails.create.reviewDecision).toBe(
        ReviewDecision.APPROVED
      );
    });

    it("returns Status.NotFound when the PR artifact belongs to a different org", async () => {
      // PullRequestDetail.githubId is globally unique. If a reinstalled App
      // reuses ids, findUnique({ githubId }) can match another org's row.
      // updateExistingPullRequest must re-scope by organizationId via the
      // updateMany guard; count=0 means no matching row in this org.
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cross-org-detail",
            artifactId: null,
            branchArtifactId: "cross-org-99",
          }),
          update: vi.fn(),
        },
        branchDetail: {
          update: vi.fn(),
        },
        artifact: {
          findUnique: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await pullRequestService.upsertBranchArtifact(
        baseUpsertInput()
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(mockDb.artifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cross-org-99", organizationId: ORG_ID },
        })
      );
      expect(mockDb.pullRequestDetail.update).not.toHaveBeenCalled();
    });
  });

  describe("findById", () => {
    it("returns the artifact + detail when present in the org", async () => {
      const found = { id: "art-1", pullRequest: { githubId: "gh-1" } };
      const mockDb = {
        artifact: { findFirst: vi.fn().mockResolvedValue(found) },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.findById("art-1", ORG_ID);

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "art-1",
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
        },
        include: expectedPullRequestInclude,
      });
      expect(result).toBe(found);
    });

    it("returns null when no row matches in the org (cross-org row not returned)", async () => {
      const mockDb = {
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.findById("art-1", ORG_ID);

      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("scopes to organizationId and BRANCH type, ordered desc by createdAt", async () => {
      const mockDb = {
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
      };
      mockWithDbCall(mockDb);

      await pullRequestService.list({ organizationId: ORG_ID });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
        },
        include: expectedPullRequestInclude,
        orderBy: { createdAt: "desc" },
      });
    });

    it("forwards optional projectId, workstreamId, and prState filters", async () => {
      const mockDb = {
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
      };
      mockWithDbCall(mockDb);

      await pullRequestService.list({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        prState: GitHubPRState.OPEN,
      });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
          projectId: PROJECT_ID,
          pullRequestDetails: {
            some: { prState: GitHubPRState.OPEN, isCurrent: true },
          },
        },
        include: expectedPullRequestInclude,
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("delete", () => {
    it("returns Result.ok when the row was deleted", async () => {
      const mockDb = {
        artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.delete("art-1", ORG_ID);

      expect(mockDb.artifact.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "art-1",
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
        },
      });
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("returns Status.NotFound when no PR artifact matches in the org", async () => {
      const mockDb = {
        artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.delete("missing", ORG_ID);

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });
  });

  describe("findByGithubId", () => {
    it("queries artifact.findFirst with the nested detail filter", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "art-1" }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.findByGithubId("gh-123", ORG_ID);

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
          pullRequestDetails: { some: { githubId: "gh-123" } },
        },
        include: expectedPullRequestInclude,
      });
      expect(result).toEqual({ id: "art-1" });
    });
  });

  describe("findByRepositoryAndNumber", () => {
    it("returns null when no detail row matches", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        artifact: {
          findUnique: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.findByRepositoryAndNumber(
        REPO_ID,
        42
      );

      expect(result).toBeNull();
      expect(mockDb.artifact.findUnique).not.toHaveBeenCalled();
    });

    it("returns the artifact+detail when detail row found", async () => {
      const artifact = {
        id: "art-1",
        pullRequest: { githubId: "gh-123" },
      };
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ artifactId: null, branchArtifactId: "art-1" }),
        },
        artifact: {
          findUnique: vi.fn().mockResolvedValue(artifact),
        },
      };
      mockWithDbCall(mockDb);

      const result = await pullRequestService.findByRepositoryAndNumber(
        REPO_ID,
        42
      );

      expect(mockDb.pullRequestDetail.findUnique).toHaveBeenCalledWith({
        where: { repositoryId_number: { repositoryId: REPO_ID, number: 42 } },
        select: { artifactId: true, branchArtifactId: true },
      });
      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "art-1" },
        include: expectedPullRequestInclude,
      });
      expect(result).toBe(artifact);
    });
  });

  describe("updateReviewState", () => {
    it("only sets detail fields that were supplied", async () => {
      const mockDb = {
        branchDetail: {
          update: vi.fn().mockResolvedValue({}),
        },
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", ORG_ID, {
        checksStatus: ChecksStatus.FAILING,
      });

      expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "art-1" },
        data: { checksStatus: ChecksStatus.FAILING },
      });
      const data = mockDb.artifact.update.mock.calls[0][0].data;
      // No prState → parent status untouched
      expect(data).not.toHaveProperty("status");
    });

    it("sets artifact.status when prState is supplied", async () => {
      const mockDb = {
        pullRequestDetail: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", ORG_ID, {
        prState: GitHubPRState.CLOSED,
        closedAt: new Date("2026-02-02"),
      });

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.status).toBe(GitHubPRState.CLOSED);
      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: { branchArtifactId: "art-1", isCurrent: true },
        data: {
          prState: GitHubPRState.CLOSED,
          closedAt: new Date("2026-02-02"),
        },
      });
    });

    it("supports passing null to clear reviewDecision", async () => {
      const mockDb = {
        pullRequestDetail: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", ORG_ID, {
        reviewDecision: null,
      });

      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: { branchArtifactId: "art-1", isCurrent: true },
        data: { reviewDecision: null },
      });
    });
  });

  describe("recordReviewDecision", () => {
    it("delegates to updateReviewState with just reviewDecision", async () => {
      const mockDb = {
        pullRequestDetail: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.recordReviewDecision(
        "art-1",
        ORG_ID,
        ReviewDecision.CHANGES_REQUESTED
      );

      expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
        where: { branchArtifactId: "art-1", isCurrent: true },
        data: { reviewDecision: ReviewDecision.CHANGES_REQUESTED },
      });
      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("status");
    });
  });
});
