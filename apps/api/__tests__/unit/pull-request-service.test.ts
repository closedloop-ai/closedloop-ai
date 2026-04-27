import { beforeEach, describe, expect, it, vi } from "vitest";
import { asTx, mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
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
  type UpsertPullRequestArtifactInput,
} from "@/lib/services/pull-request-service";

const ORG_ID = "org-1";
const PROJECT_ID = "proj-1";
const REPO_ID = "repo-1";

function baseUpsertInput(
  overrides: Partial<UpsertPullRequestArtifactInput> = {}
): UpsertPullRequestArtifactInput {
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

  describe("upsertPullRequestArtifact", () => {
    it("creates a new artifact + detail when no PR exists for githubId", async () => {
      const created = {
        id: "art-1",
        pullRequest: { artifactId: "art-1" },
      };
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        artifact: {
          create: vi.fn().mockResolvedValue(created),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await pullRequestService.upsertPullRequestArtifact(
        baseUpsertInput()
      );

      expect(mockDb.pullRequestDetail.findUnique).toHaveBeenCalledWith({
        where: { githubId: "gh-123" },
        select: { artifactId: true },
      });
      expect(mockDb.artifact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: ArtifactType.PULL_REQUEST,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          workstreamId: null,
          name: "Add feature",
          status: GitHubPRState.OPEN,
          externalUrl: "https://github.com/o/r/pull/42",
          pullRequest: {
            create: expect.objectContaining({
              repositoryId: REPO_ID,
              githubId: "gh-123",
              number: 42,
              headBranch: "feature",
              baseBranch: "main",
              headSha: "abc123",
              prState: GitHubPRState.OPEN,
              isDraft: false,
            }),
          },
        }),
        include: { pullRequest: true },
      });
      expect(mockDb.artifact.update).not.toHaveBeenCalled();
      expect(result).toBe(created);
    });

    it("updates an existing artifact when detail already exists", async () => {
      const updated = { id: "art-99", pullRequest: { artifactId: "art-99" } };
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
          update: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
        },
        artifact: {
          findUnique: vi.fn().mockResolvedValue(updated),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          create: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await pullRequestService.upsertPullRequestArtifact(
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
          name: "Add feature",
          status: GitHubPRState.MERGED,
          externalUrl: "https://github.com/o/r/pull/42",
          projectId: PROJECT_ID,
        }),
      });
      // PR detail update is keyed by the detail's artifactId PK.
      expect(mockDb.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "art-99" },
        data: expect.objectContaining({
          prState: GitHubPRState.MERGED,
          mergedAt: new Date("2026-01-01"),
          mergeCommitSha: "deadbeef",
        }),
      });
      expect(result).toBe(updated);
    });

    it("disconnects workstream when workstreamId is null on update", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
          update: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
        },
        artifact: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: "art-99", pullRequest: null }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertPullRequestArtifact(
        baseUpsertInput({ workstreamId: null })
      );

      // workstreamId: null sets the scalar column to null (disconnect).
      expect(mockDb.artifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ workstreamId: null }),
        })
      );
    });

    it("connects workstream when workstreamId is set on update", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
          update: vi.fn().mockResolvedValue({ artifactId: "art-99" }),
        },
        artifact: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: "art-99", pullRequest: null }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertPullRequestArtifact(
        baseUpsertInput({ workstreamId: "ws-1" })
      );

      expect(mockDb.artifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ workstreamId: "ws-1" }),
        })
      );
    });

    it("omits optional detail fields when not supplied on create", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertPullRequestArtifact(baseUpsertInput());

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.pullRequest.create).not.toHaveProperty("checksStatus");
      expect(data.pullRequest.create).not.toHaveProperty("reviewDecision");
    });

    it("includes checksStatus and reviewDecision when supplied on create", async () => {
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.upsertPullRequestArtifact(
        baseUpsertInput({
          checksStatus: ChecksStatus.PASSING,
          reviewDecision: ReviewDecision.APPROVED,
        })
      );

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.pullRequest.create.checksStatus).toBe(ChecksStatus.PASSING);
      expect(data.pullRequest.create.reviewDecision).toBe(
        ReviewDecision.APPROVED
      );
    });

    it("uses the supplied tx instead of opening withDb.tx", async () => {
      const mockTx = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        artifact: {
          create: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      const { withDb } = await import("@repo/database");
      const txSpy = withDb.tx as unknown as ReturnType<typeof vi.fn>;

      await pullRequestService.upsertPullRequestArtifact(
        baseUpsertInput(),
        asTx(mockTx)
      );

      expect(txSpy).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).toHaveBeenCalled();
    });

    it("refuses to update a PR artifact that belongs to a different org", async () => {
      // PullRequestDetail.githubId is globally unique. If a reinstalled App
      // reuses ids, findUnique({ githubId }) can match another org's row.
      // updateExistingPullRequest must re-scope by organizationId via the
      // updateMany guard; count=0 means no matching row in this org.
      const mockDb = {
        pullRequestDetail: {
          findUnique: vi.fn().mockResolvedValue({ artifactId: "cross-org-99" }),
          update: vi.fn(),
        },
        artifact: {
          findUnique: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      mockWithDbTx(mockDb);

      await expect(
        pullRequestService.upsertPullRequestArtifact(baseUpsertInput())
      ).rejects.toThrow("not found in organization");

      expect(mockDb.artifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cross-org-99", organizationId: ORG_ID },
        })
      );
      expect(mockDb.pullRequestDetail.update).not.toHaveBeenCalled();
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
          type: ArtifactType.PULL_REQUEST,
          pullRequest: { githubId: "gh-123" },
        },
        include: { pullRequest: true },
      });
      expect(result).toEqual({ id: "art-1" });
    });

    it("uses the supplied tx instead of withDb", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const { withDb } = await import("@repo/database");
      const dbSpy = withDb as unknown as ReturnType<typeof vi.fn>;

      await pullRequestService.findByGithubId("gh-123", ORG_ID, asTx(mockTx));

      expect(dbSpy).not.toHaveBeenCalled();
      expect(mockTx.artifact.findFirst).toHaveBeenCalled();
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
          findUnique: vi.fn().mockResolvedValue({ artifactId: "art-1" }),
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
        select: { artifactId: true },
      });
      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "art-1" },
        include: { pullRequest: true },
      });
      expect(result).toBe(artifact);
    });
  });

  describe("updateReviewState", () => {
    it("only sets detail fields that were supplied", async () => {
      const mockDb = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", {
        checksStatus: ChecksStatus.FAILING,
      });

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.pullRequest.update).toEqual({
        checksStatus: ChecksStatus.FAILING,
      });
      // No prState → parent status untouched
      expect(data).not.toHaveProperty("status");
    });

    it("sets artifact.status when prState is supplied", async () => {
      const mockDb = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", {
        prState: GitHubPRState.CLOSED,
        closedAt: new Date("2026-02-02"),
      });

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.status).toBe(GitHubPRState.CLOSED);
      expect(data.pullRequest.update).toEqual({
        prState: GitHubPRState.CLOSED,
        closedAt: new Date("2026-02-02"),
      });
    });

    it("supports passing null to clear reviewDecision", async () => {
      const mockDb = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.updateReviewState("art-1", {
        reviewDecision: null,
      });

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.pullRequest.update).toEqual({ reviewDecision: null });
    });
  });

  describe("recordReviewDecision", () => {
    it("delegates to updateReviewState with just reviewDecision", async () => {
      const mockDb = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "art-1", pullRequest: null }),
        },
      };
      mockWithDbTx(mockDb);

      await pullRequestService.recordReviewDecision(
        "art-1",
        ReviewDecision.CHANGES_REQUESTED
      );

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.pullRequest.update).toEqual({
        reviewDecision: ReviewDecision.CHANGES_REQUESTED,
      });
      expect(data).not.toHaveProperty("status");
    });
  });
});
