import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_ID,
  projectionRow,
  reconcileMarker,
  reconcileResult,
  unsyncedMarker,
} from "@/__tests__/support/branches/branch-comments-service.test-helpers";
import { resolveMockPullRequestDetails } from "../../__tests__/fixtures/branch-pull-request-details";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  readMarker: vi.fn(),
  reconcileOnView: vi.fn(),
  withDb: vi.fn(),
}));

// The canonical by-id gate returns an id only when both a valid Session and
// current complete non-default authority qualify the Branch.
const LINKED_SESSION_MEMBERSHIP_ROWS = [
  { id: "11111111-1111-4111-8111-111111111111" },
];

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: mocks.withDb,
  };
});

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile-marker",
  () => ({ readPullRequestCommentsReconcileMarker: mocks.readMarker })
);

vi.mock(
  "@/app/comments/service/github/github-comment-on-demand-reconcile",
  () => ({ reconcilePullRequestCommentsOnView: mocks.reconcileOnView })
);

import { branchCommentsService } from "./branch-comments-service";

describe("branchCommentsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
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
    // Default: the branch is a corpus member (has a valid linked session).
    mocks.queryRaw.mockResolvedValue(LINKED_SESSION_MEMBERSHIP_ROWS);
    mocks.readMarker.mockResolvedValue(reconcileMarker());
    mocks.reconcileOnView.mockResolvedValue(reconcileResult());
  });

  it("reads only active GitHub comment projections for the scoped branch PR", async () => {
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);

    const result = await getComments();

    expect(result?.state).toBe(BranchCommentsState.Populated);
    expect(result?.comments[0]).toMatchObject({
      providerCommentId: "123456",
      kind: BranchPrCommentKind.Review,
      author: { actorType: GitHubActorType.Bot },
    });
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          githubProjection: { is: { githubDeletedAt: null } },
        }),
        select: expect.objectContaining({
          syncStates: {
            where: { provider: CommentSyncProvider.Github },
            select: { state: true },
          },
        }),
      })
    );
  });

  it("returns an empty UnsyncedUnknown envelope for an eligible Branch with no selected PR", async () => {
    // The shared SQL gate is mocked eligible here. Once admitted, absence of a
    // selected PR yields an honest empty envelope without a reconcile.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
      })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      comments: [],
      prNumber: null,
      prUrl: null,
      providerProofedAt: null,
    });
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.readMarker).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("returns null when the shared Product-membership gate excludes the Branch", async () => {
    // The canonical gate (mocked via $queryRaw) returns no rows, so
    // the context resolves to null → the route 404s, and no reads fire.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
      })
    );
    mocks.queryRaw.mockResolvedValue([]);

    const result = await getComments();

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("fails closed when Product eligibility disappears during context hydration", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce(LINKED_SESSION_MEMBERSHIP_ROWS)
      .mockResolvedValueOnce([]);

    const result = await getComments();

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("fails closed when Product eligibility is revoked after projection work", async () => {
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);
    mockFinalEligibilityRevoked();

    const result = await getComments();

    expect(result).toBeNull();
    expect(mocks.commentFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3);
  });

  it("fails closed when Product eligibility is revoked after a first-view reconcile", async () => {
    mocks.readMarker.mockResolvedValue(unsyncedMarker());
    mockFinalEligibilityRevoked();

    const result = await getComments();

    expect(result).toBeNull();
    expect(mocks.reconcileOnView).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3);
  });

  it("scopes context lookup to non-deleted branches before fetching comments", async () => {
    mocks.artifactFindFirst.mockResolvedValue(null);

    const result = await getComments();

    expect(result).toBeNull();
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch: { deletedAt: null },
        }),
      })
    );
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("uses an exact persisted cross-repository associated PR", async () => {
    // The Branch passed the shared Product gate, but its only
    // "current" PR belongs to a DIFFERENT repository. It is still a persisted
    // associated PR of this Branch, so its stored comments are read.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        },
      })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.SyncedEmpty,
      comments: [],
      prNumber: 42,
      prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    expect(mocks.readMarker).toHaveBeenCalledWith("org-1", "pr-detail-1");
  });

  it("does not use mismatched current PR details when remote head evidence is present", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        },
        firstPushedAt: new Date("2026-07-03T00:00:00.000Z"),
        pullRequestDetails: [],
      })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.readMarker).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("does not guess when persisted associated PRs are both active", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "foreign-current-pr-detail",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        },
        pullRequestDetails: [
          {
            id: "foreign-fallback-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-2",
            number: 99,
            htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/99",
          },
          {
            id: "owned-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-1",
            number: 17,
            htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/17",
          },
        ],
      })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          pullRequestDetails: expect.objectContaining({
            orderBy: [
              { repositoryId: "asc" },
              { number: "desc" },
              { id: "asc" },
            ],
          }),
        }),
      })
    );
  });

  it("scopes projections and the first-view reconcile to an explicit persisted PR", async () => {
    const row = branchContextRow();
    const first = row.pullRequestDetails[0];
    if (!first) {
      throw new Error("Expected PR fixture");
    }
    row.pullRequestDetails.push({
      ...first,
      id: "historical-pr-detail",
      number: 17,
      htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/17",
    });
    mocks.artifactFindFirst.mockResolvedValue(row);
    mocks.readMarker.mockResolvedValue(unsyncedMarker());

    const result = await getComments({
      repositoryFullName: "closedloop-ai/closedloop-ai",
      pullRequestNumber: 17,
    });

    expect(result).toMatchObject({
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 17,
    });
    expect(mocks.reconcileOnView).toHaveBeenCalledWith("historical-pr-detail");
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: expect.objectContaining({
            githubProjection: {
              is: expect.objectContaining({
                pullRequestDetailId: "historical-pr-detail",
              }),
            },
          }),
        }),
      })
    );
  });

  it("rejects a foreign explicit PR before projection or reconcile", async () => {
    const result = await getComments({
      repositoryFullName: "other/repository",
      pullRequestNumber: 999,
    });

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("omits actor type for malformed legacy provider detail", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ providerDetail: ["legacy"] }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.author).not.toHaveProperty("actorType");
  });
});

function getComments(query = {}) {
  return branchCommentsService.getBranchComments("org-1", BRANCH_ID, query);
}

function branchContextRow(
  overrides: {
    currentPullRequestDetail?: {
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      number: number;
      htmlUrl: string;
    } | null;
    deletedAt?: Date | null;
    firstPushedAt?: Date | null;
    pullRequestDetails?: Array<{
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      number: number;
      htmlUrl: string;
    }>;
    repositoryId?: string;
  } = {}
) {
  const repositoryId = overrides.repositoryId ?? "repository-1";
  const currentPullRequestDetail =
    overrides.currentPullRequestDetail === undefined
      ? {
          id: "pr-detail-1",
          branchArtifactId: BRANCH_ID,
          repositoryId,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        }
      : overrides.currentPullRequestDetail;
  const pullRequestDetails = resolveMockPullRequestDetails(
    overrides,
    currentPullRequestDetail
  ).map((detail) => ({
    title: "Pull request",
    prState: "OPEN" as const,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: new Date("2026-07-01T00:00:01.000Z"),
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: {
      fullName: "closedloop-ai/closedloop-ai",
      owner: "closedloop-ai",
      name: "closedloop-ai",
    },
    ...detail,
  }));
  return {
    id: BRANCH_ID,
    pullRequestDetails,
    branch: {
      deletedAt: overrides.deletedAt ?? null,
      firstPushedAt: overrides.firstPushedAt ?? null,
      repositoryId,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repository: {
        fullName: "closedloop-ai/closedloop-ai",
        owner: "closedloop-ai",
        name: "closedloop-ai",
      },
    },
  };
}

function mockFinalEligibilityRevoked(): void {
  mocks.queryRaw
    .mockResolvedValueOnce(LINKED_SESSION_MEMBERSHIP_ROWS)
    .mockResolvedValueOnce(LINKED_SESSION_MEMBERSHIP_ROWS)
    .mockResolvedValueOnce([]);
}
