import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubCommentThreadKind, ThreadStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileMarker,
  reconcileResult,
} from "@/__tests__/support/branches/branch-comments-service.test-helpers";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  readMarker: vi.fn(),
  reconcileOnView: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile-marker",
  () => ({ readPullRequestCommentsReconcileMarker: mocks.readMarker })
);

vi.mock(
  "@/app/comments/service/github/github-comment-on-demand-reconcile",
  () => ({ reconcilePullRequestCommentsOnView: mocks.reconcileOnView })
);

import { branchCommentsService } from "./branch-comments-service";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("branchCommentsService selected-PR identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback) =>
      callback({
        artifact: { findFirst: mocks.artifactFindFirst },
        comment: { findMany: mocks.commentFindMany },
        gitHubInstallationRepository: {
          findFirst: mocks.repositoryFindFirst,
        },
        $queryRaw: mocks.queryRaw,
      })
    );
    mocks.artifactFindFirst.mockResolvedValue(branchContextRow());
    mocks.commentFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([{ id: branchId }]);
    mocks.readMarker.mockResolvedValue(reconcileMarker());
    mocks.reconcileOnView.mockResolvedValue(reconcileResult());
  });

  it("orders equal-time persisted projections deterministically by id", async () => {
    const rows = [projectionRow("comment-b"), projectionRow("comment-a")];
    mocks.commentFindMany.mockImplementation((args) =>
      Promise.resolve(
        args.orderBy?.[1]?.id === "asc"
          ? [...rows].sort((left, right) => left.id.localeCompare(right.id))
          : rows
      )
    );

    const result = await getComments();

    expect(result?.comments.map(({ id }) => id)).toEqual([
      "comment-a",
      "comment-b",
    ]);
    expect(result?.state).toBe(BranchCommentsState.Populated);
    expect(result?.comments[0]?.kind).toBe(BranchPrCommentKind.Review);
    expect(result?.comments[0]).toMatchObject({
      author: { login: "reviewer" },
      bodyTruncated: false,
      inReplyToId: null,
      line: 1,
      path: "file.ts",
      resolved: false,
      stale: false,
      threadId: "thread-comment-a",
    });
    expect(result?.budget).toMatchObject({
      bodyTruncatedCount: 0,
      omittedComments: 0,
    });
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
  });

  it("uses the selected cross-repository relation and normalized identity", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({ includeCrossRepository: true })
    );

    const result = await getComments({
      repositoryFullName: "other/repository",
      pullRequestNumber: 42,
    });

    expect(result).toMatchObject({
      repositoryFullName: "other/repository",
      prNumber: 42,
    });
    expect(mocks.repositoryFindFirst).not.toHaveBeenCalled();
    expect(mocks.readMarker).toHaveBeenCalledWith("org-1", "pr-cross");
  });

  it("reads an installation-less cross-repo PR as its own repository, never the Branch's", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        includeCrossRepository: true,
        omitCrossRelation: true,
      })
    );
    mocks.repositoryFindFirst.mockResolvedValue(null);

    const result = await getComments({
      repositoryFullName: "other/repository",
      pullRequestNumber: 42,
    });

    expect(result).toMatchObject({
      repositoryFullName: "other/repository",
      prNumber: 42,
    });
    expect(result?.prUrl).toBe("https://github.com/other/repository/pull/42");
    expect(mocks.readMarker).toHaveBeenCalledWith("org-1", "pr-cross");
    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: { equals: "other/repository", mode: "insensitive" },
          installation: { organizationId: "org-1" },
        }),
      })
    );
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: expect.objectContaining({
            githubProjection: {
              is: expect.objectContaining({ pullRequestDetailId: "pr-cross" }),
            },
          }),
        }),
      })
    );
  });
});

function getComments(query = {}) {
  return branchCommentsService.getBranchComments("org-1", branchId, query);
}

function branchContextRow(options?: {
  includeCrossRepository?: boolean;
  omitCrossRelation?: boolean;
}) {
  const mainRepository = repository("closedloop-ai", "closedloop-ai");
  const current = pullRequest("pr-main", "repository-1", mainRepository);
  const pullRequestDetails = [current];
  if (options?.includeCrossRepository) {
    pullRequestDetails.push({
      ...pullRequest(
        "pr-cross",
        "repository-2",
        options.omitCrossRelation ? null : repository("Other", "Repository")
      ),
      repositoryFullName: "Other/Repository",
    });
  }
  return {
    id: branchId,
    pullRequestDetails,
    branch: {
      deletedAt: null,
      firstPushedAt: new Date("2026-07-01T00:00:00.000Z"),
      repositoryId: "repository-1",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repository: mainRepository,
    },
  };
}

function repository(owner: string, name: string) {
  return { fullName: `${owner}/${name}`, owner, name };
}

function pullRequest(
  id: string,
  repositoryId: string,
  selectedRepository: ReturnType<typeof repository> | null
) {
  return {
    id,
    branchArtifactId: branchId,
    repositoryId,
    repositoryFullName: selectedRepository?.fullName ?? "other/repository",
    number: 42,
    title: "Pull request",
    htmlUrl: `https://github.com/${selectedRepository?.fullName ?? "other/repository"}/pull/42`,
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: new Date("2026-07-01T00:00:01.000Z"),
    repository: selectedRepository,
  };
}

function projectionRow(id: string) {
  const createdAt = new Date("2026-07-03T10:00:00.000Z");
  return {
    id,
    body: { markdown: "Review" },
    plainText: "Review",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    syncStates: [],
    githubProjection: {
      githubCommentId: id,
      githubInReplyToCommentId: null,
      githubHtmlUrl: null,
      githubUpdatedAt: createdAt,
      githubDeletedAt: null,
      externalAuthor: {
        providerLogin: "reviewer",
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
        providerDetail: { actorType: GitHubActorType.User },
      },
    },
    thread: {
      id: `thread-${id}`,
      status: ThreadStatus.OPEN,
      githubProjection: {
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        path: "file.ts",
        line: 1,
      },
    },
  };
}
