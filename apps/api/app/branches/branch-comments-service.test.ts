import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  ThreadStatus,
  withDb,
} from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMockPullRequestDetails } from "../../__tests__/fixtures/branch-pull-request-details";

const WRITE_AFFORDANCE_KEYS_REGEX =
  /canReply|viewerCan|action|mutation|replyUrl|editUrl|deleteUrl|resolveUrl|capabilityContext/;

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  resolveBranchViewReadClient: vi.fn(),
  getInstallationOctokit: vi.fn(),
  listPullRequestIssueCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewCommentsWithProviderResult: vi.fn(),
  listPullRequestReviewsWithProviderResult: vi.fn(),
  withDb: vi.fn(),
}));

// Existing installation client retained for provider-proof acquisition.
const INSTALLATION_OCTOKIT = { marker: "installation-octokit" };

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

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    listPullRequestIssueCommentsWithProviderResult:
      mocks.listPullRequestIssueCommentsWithProviderResult,
    listPullRequestReviewCommentsWithProviderResult:
      mocks.listPullRequestReviewCommentsWithProviderResult,
    listPullRequestReviewsWithProviderResult:
      mocks.listPullRequestReviewsWithProviderResult,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: mocks.getInstallationOctokit,
}));

vi.mock("@/lib/github/github-branch-view-read-client", () => ({
  resolveBranchViewReadClient: mocks.resolveBranchViewReadClient,
}));

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
    mocks.getInstallationOctokit.mockResolvedValue(INSTALLATION_OCTOKIT);
    mocks.resolveBranchViewReadClient.mockResolvedValue({
      ok: true,
      value: { octokit: {}, kind: "user_token" },
    });
    // Default: the branch is a corpus member (has a valid linked session).
    mocks.queryRaw.mockResolvedValue(LINKED_SESSION_MEMBERSHIP_ROWS);
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    mocks.listPullRequestReviewsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
  });

  it("reads only active GitHub comment projections for the scoped branch PR", async () => {
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.StaleMixed);
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
      })
    );
  });

  it("treats legacyState and lastSyncedAt as stale mixed evidence, not synced empty proof", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        legacyState: GitHubLegacyCommentState.ADDRESSED,
        lastSyncedAt: new Date("2026-07-03T12:00:00.000Z"),
      }),
    ]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.StaleMixed,
      stale: true,
      mixedProjection: true,
      providerProofedAt: null,
    });
    expect(result?.comments[0]?.stale).toBe(true);
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("preserves simultaneous stale and body-truncated evidence with an exact aggregate count", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        body: "x".repeat(BranchCommentsBudget.MaxBodyBytes + 1),
      }),
    ]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      budget: { bodyTruncatedCount: 1 },
      mixedProjection: true,
      stale: true,
      state: BranchCommentsState.StaleMixed,
    });
    expect(result?.comments[0]).toMatchObject({
      bodyTruncated: true,
      stale: true,
    });
  });

  it("requires current-request provider proof before returning synced empty", async () => {
    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.SyncedEmpty);
    expect(result?.providerProofedAt).toEqual(expect.any(String));
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      42,
      { limit: 101, pageSize: 50 }
    );
    expect(
      (withDb as unknown as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(2);
  });

  it("returns an empty UnsyncedUnknown envelope for a session-only unpushed branch (no push state, no current PR) without fetching comments", async () => {
    // FEA-4311 (review: wongk, shafty023) — a session-linked branch whose detail
    // now loads BEFORE any push/PR must NOT 404 its `/comments` request. With no
    // owned current PR and no `firstPushedAt`, `getBranchComments` returns the
    // empty `UnsyncedUnknown` envelope (not null → not a 404), so the detail page
    // shows "no comments yet" instead of "PR comments unavailable". The branch is
    // still gated on corpus membership (a valid linked session), so no provider or
    // projection reads fire.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      comments: [],
      prNumber: null,
      prUrl: null,
      providerProofedAt: null,
    });
    expect(mocks.resolveBranchViewReadClient).not.toHaveBeenCalled();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("returns null (404) for a session-less unpushed branch — the corpus-membership gate excludes it", async () => {
    // FEA-4311 — a GitHub-only / backfill / loop-only branch that no valid session
    // links to stays OUT of the comments corpus exactly as it stays out of the
    // list/detail. The canonical gate (mocked via $queryRaw) returns no rows, so
    // the context resolves to null → the route 404s, and no reads fire.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
      })
    );
    mocks.queryRaw.mockResolvedValue([]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("scopes context lookup to non-deleted branches before fetching comments", async () => {
    mocks.artifactFindFirst.mockResolvedValue(null);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toBeNull();
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch: { deletedAt: null },
        }),
      })
    );
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("uses an exact persisted cross-repository associated PR", async () => {
    // FEA-4311 — the branch is a corpus member (session-linked) but its only
    // "current" PR belongs to a DIFFERENT repository, so `getOwnedCurrentPullRequestDetail`
    // rejects it (repositoryId mismatch) and no PR context is used. The mismatched
    // PR must not leak: with no owned current PR and no push state, the response is
    // the empty `UnsyncedUnknown` envelope (prNumber null, no comments), and no
    // projection or provider read fires for the foreign PR.
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.SyncedEmpty,
      comments: [],
      prNumber: 42,
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    });
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalled();
  });

  it("does not use mismatched current PR details when remote head evidence is present", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "pr-detail-1",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
        firstPushedAt: new Date("2026-07-03T00:00:00.000Z"),
        pullRequestDetails: [],
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("does not guess when persisted associated PRs are both active", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        currentPullRequestDetail: {
          id: "foreign-current-pr-detail",
          branchArtifactId: "11111111-1111-4111-8111-111111111111",
          repositoryId: "repository-2",
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        },
        pullRequestDetails: [
          {
            id: "foreign-fallback-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-2",
            isCurrent: true,
            number: 99,
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/99",
          },
          {
            id: "owned-pr-detail",
            branchArtifactId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "repository-1",
            isCurrent: true,
            number: 17,
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/17",
          },
        ],
      })
    );

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

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

  it("scopes projections and provider reads to an explicit persisted PR", async () => {
    const row = branchContextRow();
    const first = row.pullRequestDetails[0];
    if (!first) {
      throw new Error("Expected PR fixture");
    }
    row.pullRequestDetails.push({
      ...first,
      id: "historical-pr-detail",
      number: 17,
      htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/17",
    });
    mocks.artifactFindFirst.mockResolvedValue(row);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111",
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 17,
      }
    );

    expect(result).toMatchObject({
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber: 17,
    });
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      17,
      expect.any(Object)
    );
  });

  it("rejects a foreign explicit PR before projection or provider reads", async () => {
    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111",
      {
        repositoryFullName: "other/repository",
        pullRequestNumber: 999,
      }
    );

    expect(result).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("uses review comments as provider proof before returning synced empty", async () => {
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewComment()],
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.Populated);
    expect(result?.comments).toHaveLength(1);
    expect(result?.comments[0]).toMatchObject({
      kind: BranchPrCommentKind.Review,
      providerCommentId: "987",
      path: "packages/app/branches/components/pr-comments-panel.tsx",
      author: { actorType: GitHubActorType.Mannequin },
    });
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      42,
      { includeReviewThreadMetadata: false, limit: 101, pageSize: 50 }
    );
  });

  it("projects actor type from every live GitHub comment source", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerIssueComment(123)],
    });
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewComment()],
    });
    mocks.listPullRequestReviewsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewBody()],
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerCommentId: "123",
          author: expect.objectContaining({ actorType: GitHubActorType.User }),
        }),
        expect.objectContaining({
          providerCommentId: "987",
          author: expect.objectContaining({
            actorType: GitHubActorType.Mannequin,
          }),
        }),
        expect.objectContaining({
          providerCommentId: "654",
          author: expect.objectContaining({
            actorType: GitHubActorType.Organization,
          }),
        }),
      ])
    );
  });

  it("omits actor type for malformed legacy provider detail", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ providerDetail: ["legacy"] }),
    ]);

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.comments[0]?.author).not.toHaveProperty("actorType");
  });

  it("marks count-budget truncation with the over-limit state", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: Array.from({ length: 101 }, (_, index) =>
        providerIssueComment(index + 1)
      ),
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result?.state).toBe(BranchCommentsState.OverLimitTruncated);
    expect(result?.comments).toHaveLength(100);
    expect(result?.budget).toMatchObject({
      providerTruncated: true,
      omittedComments: 1,
    });
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("stops provider proof calls at the comments budget plus sentinel", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: Array.from({ length: 101 }, (_, index) =>
        providerIssueComment(index + 1)
      ),
    });

    await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      42,
      { limit: 101, pageSize: 50 }
    );
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });

  it("returns a read-only comments DTO key set", async () => {
    mocks.listPullRequestReviewCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: [providerReviewComment()],
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(Object.keys(result ?? {}).sort()).toEqual([
      "branchId",
      "budget",
      "comments",
      "mixedProjection",
      "prNumber",
      "prUrl",
      "providerProofedAt",
      "repositoryFullName",
      "stale",
      "state",
    ]);
    expect(Object.keys(result?.comments[0] ?? {}).sort()).toEqual([
      "author",
      "body",
      "bodyTruncated",
      "createdAt",
      "id",
      "inReplyToId",
      "kind",
      "line",
      "path",
      "providerCommentId",
      "providerNodeId",
      "providerUrl",
      "resolved",
      "stale",
      "threadId",
      "updatedAt",
    ]);
    expect(JSON.stringify(result)).not.toMatch(WRITE_AFFORDANCE_KEYS_REGEX);
  });

  it("folds a user-scoped provider read failure into ProviderError", async () => {
    mocks.listPullRequestIssueCommentsWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "11111111-1111-4111-8111-111111111111"
    );

    expect(result).toMatchObject({
      state: BranchCommentsState.ProviderError,
      failureReason: BranchCommentsFailureReason.ProviderUnavailable,
      comments: [],
      providerProofedAt: expect.any(String),
      stale: false,
    });
    expect(
      mocks.listPullRequestIssueCommentsWithProviderResult
    ).toHaveBeenCalledWith(
      INSTALLATION_OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      42,
      { limit: 101, pageSize: 50 }
    );
    expect(
      mocks.listPullRequestReviewCommentsWithProviderResult
    ).not.toHaveBeenCalled();
    expect(
      mocks.listPullRequestReviewsWithProviderResult
    ).not.toHaveBeenCalled();
  });
});

function branchContextRow(
  overrides: {
    currentPullRequestDetail?: {
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      isCurrent: boolean;
      number: number;
      htmlUrl: string;
    } | null;
    deletedAt?: Date | null;
    firstPushedAt?: Date | null;
    pullRequestDetails?: Array<{
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      isCurrent: boolean;
      number: number;
      htmlUrl: string;
    }>;
    repositoryId?: string;
  } = {}
) {
  const branchId = "11111111-1111-4111-8111-111111111111";
  const repositoryId = overrides.repositoryId ?? "repository-1";
  const currentPullRequestDetail =
    overrides.currentPullRequestDetail === undefined
      ? {
          id: "pr-detail-1",
          branchArtifactId: branchId,
          repositoryId,
          isCurrent: true,
          number: 42,
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
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
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repository: {
      fullName: "closedloop-ai/symphony-alpha",
      owner: "closedloop-ai",
      name: "symphony-alpha",
      installation: { installationId: "installation-1" },
    },
    ...detail,
  }));
  return {
    id: branchId,
    pullRequestDetails,
    branch: {
      deletedAt: overrides.deletedAt ?? null,
      firstPushedAt: overrides.firstPushedAt ?? null,
      repositoryId,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      currentPullRequestDetail,
      repository: {
        fullName: "closedloop-ai/symphony-alpha",
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "installation-1" },
      },
    },
  };
}

function projectionRow(
  overrides: {
    body?: string;
    createdAt?: Date;
    id?: string;
    legacyState?: GitHubLegacyCommentState | null;
    lastSyncedAt?: Date | null;
    providerDetail?: unknown;
  } = {}
) {
  return {
    id: overrides.id ?? "comment-1",
    body: { markdown: overrides.body ?? "Please cover desktop parity." },
    plainText: overrides.body ?? "Please cover desktop parity.",
    createdAt: overrides.createdAt ?? new Date("2026-07-03T10:00:00.000Z"),
    updatedAt: new Date("2026-07-03T10:01:00.000Z"),
    deletedAt: null,
    githubProjection: {
      githubCommentId: "123456",
      githubInReplyToCommentId: null,
      githubHtmlUrl:
        "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r123456",
      githubUpdatedAt: new Date("2026-07-03T10:02:00.000Z"),
      githubDeletedAt: null,
      externalAuthor: {
        providerLogin: "reviewer",
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
        providerDetail: overrides.providerDetail ?? {
          actorType: GitHubActorType.Bot,
        },
      },
    },
    thread: {
      id: "thread-1",
      status: ThreadStatus.OPEN,
      githubProjection: {
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        path: "apps/api/app/branches/branch-comments-service.ts",
        line: 12,
        legacyState: overrides.legacyState ?? GitHubLegacyCommentState.PENDING,
        lastSyncedAt:
          overrides.lastSyncedAt ?? new Date("2026-07-03T10:02:00.000Z"),
      },
    },
  };
}

function providerIssueComment(id: number) {
  return {
    id,
    node_id: `IC_${id}`,
    user: {
      id,
      login: "reviewer",
      node_id: `U_${id}`,
      avatar_url: "https://github.com/avatar.png",
      actorType: GitHubActorType.User,
    },
    body: `Issue comment ${id}`,
    author_association: "MEMBER",
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    html_url: `https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-${id}`,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function providerReviewComment() {
  return {
    id: 987,
    node_id: "PRRC_987",
    path: "packages/app/branches/components/pr-comments-panel.tsx",
    line: 12,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 12,
    original_start_line: null,
    body: "Review-only comment",
    user: {
      id: 7,
      login: "reviewer",
      node_id: "U_7",
      avatar_url: "https://github.com/avatar.png",
      actorType: GitHubActorType.Mannequin,
    },
    author_association: "MEMBER",
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r987",
    commit_id: "abc",
    pull_request_review_id: 456,
    review_thread_node_id: "PRRT_1",
    review_thread_is_resolved: false,
    in_reply_to_id: null,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
  };
}

function providerReviewBody() {
  return {
    id: 654,
    user: {
      id: 8,
      login: "acme",
      node_id: "O_8",
      avatar_url: "https://github.com/org-avatar.png",
      actorType: GitHubActorType.Organization,
    },
    state: "COMMENTED",
    body: "Review body",
    submitted_at: "2026-07-03T12:00:01.000Z",
    html_url:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-654",
  };
}
