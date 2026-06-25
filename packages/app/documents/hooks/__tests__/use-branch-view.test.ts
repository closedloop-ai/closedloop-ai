import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentSource,
  BranchViewCommentWriteIdentityStatus,
  type BranchViewData,
  BranchViewLoadErrorCode,
  BranchViewPrLifecycleRepairStatus,
  BranchViewSyncErrorCode,
  BranchViewSyncPresentationState,
  BranchViewSyncScope,
  type BranchViewSyncState,
  BranchViewSyncThrottleReason,
  CommentKind,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import type { JsonObject } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import {
  branchViewCommentOnError,
  parseBranchViewCommentIdentityBlocker,
} from "@repo/app/github/lib/branch-view-comment-identity-blocker";
import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchViewLoadUiMode,
  branchViewKeys,
  getBranchSyncRetryState,
  getBranchViewLoadState,
  useBranchView,
  useBranchViewSyncControl,
  useCreateBranchViewConversationComment,
  useCreateBranchViewInlineComment,
  useDeleteBranch,
  useDeleteBranchViewConversationComment,
  useDeleteBranchViewReviewComment,
  useEditBranchViewConversationComment,
  useEditBranchViewReviewComment,
  useResolveBranchViewReviewThread,
  useSyncBranchView,
  useUnresolveBranchViewReviewThread,
} from "../use-branch-view";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function branchViewData(
  repairStatus: BranchViewPrLifecycleRepairStatus,
  overrides: Partial<BranchViewData> = {}
): BranchViewData {
  const prState = overrides.prState ?? GitHubPRState.Open;
  return {
    authorLogin: "octocat",
    baseBranch: "main",
    branch: null,
    canCreateConversationComment: false,
    canCreateInlineComment: false,
    checksStatus: null,
    comments: [],
    committedFiles: [],
    currentPullRequest: null,
    externalLinkId: "branch-artifact-1",
    externalUrl: "https://github.com/acme/repo/pull/42",
    featureSlug: null,
    featureTitle: null,
    headBranch: "feature/branch",
    headSha: "head-sha",
    isAuthor: false,
    isDraft: false,
    prHtmlUrl: "https://github.com/acme/repo/pull/42",
    prLifecycleRepair: { status: repairStatus },
    prNumber: 42,
    prState,
    prTitle: "Feature branch",
    producedByPlanSlug: null,
    producedByPlanTitle: null,
    projectId: "project-1",
    projectName: "Project",
    repoFullName: "acme/repo",
    reviewDecision: null,
    reviews: [],
    teamId: null,
    teamName: null,
    ...overrides,
  };
}

function syncState(
  overrides: Partial<BranchViewSyncState> = {}
): BranchViewSyncState {
  return {
    backgroundRefreshAfterAt: "2026-05-27T16:59:00.000Z",
    branchLastAttemptedAt: "2026-05-27T16:54:00.000Z",
    branchLastSyncedAt: "2026-05-27T16:54:00.000Z",
    inProgress: false,
    lastOutcome: {
      code: null,
      httpStatus: null,
      message: null,
      retryAfterSeconds: null,
      source: null,
      synced: true,
    },
    lifecycleLastAttemptedAt: "2026-05-27T16:54:00.000Z",
    lifecycleLastSyncedAt: "2026-05-27T16:54:00.000Z",
    presentation: BranchViewSyncPresentationState.Fresh,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function branchViewComment(input: {
  resolved: boolean;
}): BranchViewData["comments"][number] {
  return {
    id: "123",
    githubCommentId: "123",
    source: BranchViewCommentSource.Github,
    threadId: "thread-1",
    commentId: "comment-1",
    author: "octocat",
    authorAvatar: null,
    authorProfileUrl: "https://github.com/octocat",
    authorKind: PrCommentAuthorKind.User,
    body: "Looks good",
    createdAt: "2026-05-29T12:00:00.000Z",
    path: "src/app.ts",
    line: 42,
    anchorCommitSha: "abc123",
    side: GitHubDiffSide.Right,
    startLine: null,
    startSide: null,
    state: PRReviewCommentState.Addressed,
    reviewId: "review-1",
    htmlUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    resolvable: true,
    resolved: input.resolved,
    canDelete: false,
    canEdit: false,
    canReply: false,
    canResolve: !input.resolved,
    canUnresolve: input.resolved,
  };
}

describe("useBranchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches while lifecycle repair is pending and stops when it becomes idle", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Pending)
      )
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
          prState: GitHubPRState.Closed,
        })
      );

    const { result } = renderHook(() => useBranchView("branch-artifact-1"), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() =>
      expect(result.current.data?.prLifecycleRepair?.status).toBe(
        BranchViewPrLifecycleRepairStatus.Pending
      )
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await vi.waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(result.current.data?.prLifecycleRepair?.status).toBe(
        BranchViewPrLifecycleRepairStatus.Idle
      )
    );
    expect(result.current.data?.prState).toBe(GitHubPRState.Closed);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  it("refetches while projected branch sync is refreshing and stops when it becomes fresh", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
          syncState: syncState({
            backgroundRefreshAfterAt: null,
            inProgress: true,
            presentation: BranchViewSyncPresentationState.Refreshing,
          }),
        })
      )
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
          syncState: syncState({
            backgroundRefreshAfterAt: null,
            inProgress: false,
            presentation: BranchViewSyncPresentationState.Fresh,
          }),
        })
      );

    const { result } = renderHook(() => useBranchView("branch-artifact-1"), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() =>
      expect(result.current.data?.syncState?.presentation).toBe(
        BranchViewSyncPresentationState.Refreshing
      )
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await vi.waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(result.current.data?.syncState?.presentation).toBe(
        BranchViewSyncPresentationState.Fresh
      )
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  it("surfaces updated review-thread resolution after refetch", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
          comments: [branchViewComment({ resolved: false })],
        })
      )
      .mockResolvedValueOnce(
        branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
          comments: [branchViewComment({ resolved: true })],
        })
      );

    const { result } = renderHook(() => useBranchView("branch-artifact-1"), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() =>
      expect(result.current.data?.comments[0]?.resolved).toBe(false)
    );

    await act(async () => {
      await result.current.refetch();
    });

    await vi.waitFor(() =>
      expect(result.current.data?.comments[0]?.resolved).toBe(true)
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });
});

describe("getBranchViewLoadState", () => {
  it("maps API load codes, auth status, and unknown errors to UI modes", () => {
    expect(
      getBranchViewLoadState(
        new ApiError("Missing", 404, {
          code: BranchViewLoadErrorCode.LinkNotFound,
        })
      ).mode
    ).toBe(BranchViewLoadUiMode.LinkNotFound);
    expect(
      getBranchViewLoadState(
        new ApiError("Unavailable", 404, {
          code: BranchViewLoadErrorCode.PullRequestUnavailable,
        })
      ).mode
    ).toBe(BranchViewLoadUiMode.PullRequestUnavailable);
    expect(
      getBranchViewLoadState(
        new ApiError("Temporary", 500, {
          code: BranchViewLoadErrorCode.TransientLoadError,
        })
      ).mode
    ).toBe(BranchViewLoadUiMode.TransientLoadError);
    expect(getBranchViewLoadState(new ApiError("Forbidden", 403)).mode).toBe(
      BranchViewLoadUiMode.Unauthorized
    );
    expect(getBranchViewLoadState(new Error("plain")).mode).toBe(
      BranchViewLoadUiMode.Unknown
    );
  });

  it("keeps only canonical GitHub URLs and safe action route details", () => {
    const state = getBranchViewLoadState(
      new ApiError("Unavailable", 404, {
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        details: {
          githubPullRequestUrl: "javascript:alert(1)",
          featureSlug: "feature/unsafe",
          producedByPlanSlug: "PLN-741",
          projectId: "project-1",
          teamId: "team-1",
        },
      })
    );

    expect(state.details).toEqual({
      producedByPlanSlug: "PLN-741",
      projectId: "project-1",
      teamId: "team-1",
    });
  });
});

describe("parseBranchViewCommentIdentityBlocker", () => {
  it("accepts exact identity blockers and rejects malformed details", () => {
    expect(
      parseBranchViewCommentIdentityBlocker(
        new ApiError("Connect GitHub", 403, {
          details: {
            identityBlocker: {
              status: BranchViewCommentWriteIdentityStatus.Revoked,
            },
          },
        })
      )
    ).toEqual({ status: BranchViewCommentWriteIdentityStatus.Revoked });

    expect(
      parseBranchViewCommentIdentityBlocker(
        new ApiError("Malformed", 403, {
          details: {
            identityBlocker: {
              status: BranchViewCommentWriteIdentityStatus.Missing,
              login: "octocat",
            },
          },
        })
      )
    ).toBeNull();
    expect(
      parseBranchViewCommentIdentityBlocker(new Error("plain"))
    ).toBeNull();
  });
});

describe("useSyncBranchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces branch-view sync retry metadata from the API client contract", async () => {
    const error = new ApiError("Branch view sync is throttled", 429, {
      code: "branch_view_sync_throttled",
      details: { retryAfterSeconds: 37 },
      data: {
        success: false,
        error: "Branch view sync is throttled",
        code: "branch_view_sync_throttled",
        details: { retryAfterSeconds: 37 },
      },
    });
    mockApiClient.post.mockRejectedValueOnce(error);

    const { result } = renderHook(
      () => useSyncBranchView("branch-artifact-1"),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ scope: BranchViewSyncScope.Branch });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Branch }
    );
    expect(result.current.error).toBe(error);
    expect(result.current.error).toMatchObject({
      status: 429,
      code: "branch_view_sync_throttled",
      details: { retryAfterSeconds: 37 },
    });
  });

  it("invalidates branch detail and file diffs after a successful sync", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValueOnce({
      synced: true,
      scope: BranchViewSyncScope.Branch,
    });

    const { result } = renderHook(
      () => useSyncBranchView("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() =>
      result.current.mutateAsync({ scope: BranchViewSyncScope.Branch })
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: branchViewKeys.detail("branch-artifact-1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: branchViewKeys.fileDiffsForLink("branch-artifact-1"),
    });
  });

  it("sends comments scope without invalidating file diffs", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValueOnce({
      synced: true,
      scope: BranchViewSyncScope.Comments,
    });

    const { result } = renderHook(
      () => useSyncBranchView("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() =>
      result.current.mutateAsync({ scope: BranchViewSyncScope.Comments })
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Comments }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: branchViewKeys.detail("branch-artifact-1"),
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: branchViewKeys.fileDiffsForLink("branch-artifact-1"),
    });
  });
});

describe("useBranchViewSyncControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      BranchViewSyncThrottleReason.LocalDedupe,
      BranchViewSyncThrottleReason.LocalDedupe,
    ],
    [
      BranchViewSyncThrottleReason.InFlight,
      BranchViewSyncThrottleReason.InFlight,
    ],
    [
      BranchViewSyncThrottleReason.ProviderRateLimit,
      BranchViewSyncThrottleReason.ProviderRateLimit,
    ],
    ["future_reason", null],
    [undefined, null],
  ])("parses %s retry reasons from sync throttle errors", (reason, expected) => {
    const details: JsonObject =
      reason === undefined
        ? { retryAfterSeconds: 1.2 }
        : { retryAfterSeconds: 1.2, throttleReason: reason };

    expect(
      getBranchSyncRetryState(
        new ApiError("Branch view sync is throttled", 429, {
          code: BranchViewSyncErrorCode.SyncThrottled,
          details,
        })
      )
    ).toEqual({
      retryAfterSeconds: 2,
      throttleReason: expected,
    });
  });

  it("runs one due background branch refresh when enabled", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      synced: true,
      scope: BranchViewSyncScope.Branch,
    });

    renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: true,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            syncState: syncState(),
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Branch }
    );
  });

  it("reschedules the same due background refresh after a canceled timer", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      synced: true,
      scope: BranchViewSyncScope.Branch,
    });
    const data = branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
      syncState: syncState({
        backgroundRefreshAfterAt: "2026-05-27T17:00:10.000Z",
      }),
    });

    const { rerender } = renderHook(
      ({ backgroundEnabled }) =>
        useBranchViewSyncControl({
          backgroundEnabled,
          data,
          externalLinkId: "branch-artifact-1",
        }),
      { initialProps: { backgroundEnabled: true }, wrapper: createWrapper() }
    );

    rerender({ backgroundEnabled: false });
    rerender({ backgroundEnabled: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Branch }
    );
  });

  it("suppresses background refresh while the feature gate is disabled", async () => {
    renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            syncState: syncState(),
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("suppresses background refresh while projected sync state is refreshing", async () => {
    renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: true,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Pending, {
            syncState: syncState({
              backgroundRefreshAfterAt: "2026-05-27T16:59:00.000Z",
              inProgress: true,
              presentation: BranchViewSyncPresentationState.Refreshing,
            }),
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("does not post manual branch refresh while projected sync state is refreshing", () => {
    const { result } = renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Pending, {
            syncState: syncState({
              backgroundRefreshAfterAt: null,
              inProgress: true,
              presentation: BranchViewSyncPresentationState.Refreshing,
            }),
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.refreshBranch();
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("syncs branch status and comments from one manual branch refresh", async () => {
    const branchSync = deferred<{
      synced: true;
      scope: typeof BranchViewSyncScope.Branch;
    }>();
    const commentsSync = deferred<{
      synced: true;
      scope: typeof BranchViewSyncScope.Comments;
    }>();
    mockApiClient.post
      .mockReturnValueOnce(branchSync.promise)
      .mockReturnValueOnce(commentsSync.promise);

    const { result } = renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            currentPullRequest: {
              baseBranch: "main",
              checksStatus: null,
              githubId: "1001",
              headBranch: "feature/branch",
              headSha: "head-sha",
              htmlUrl: "https://github.com/acme/repo/pull/42",
              id: "pr-detail-1",
              isDraft: false,
              number: 42,
              reviewDecision: null,
              state: GitHubPRState.Open,
              title: "Feature branch",
            },
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.refreshBranch();
    });

    await vi.waitFor(() =>
      expect(result.current.isBranchSyncPending).toBe(true)
    );
    expect(result.current.isCommentsSyncPending).toBe(false);

    await act(async () => {
      branchSync.resolve({
        synced: true,
        scope: BranchViewSyncScope.Branch,
      });
      await branchSync.promise;
    });

    await vi.waitFor(() =>
      expect(result.current.isCommentsSyncPending).toBe(true)
    );
    expect(result.current.isBranchSyncPending).toBe(false);
    expect(mockApiClient.post).toHaveBeenCalledTimes(2);

    await act(async () => {
      commentsSync.resolve({
        synced: true,
        scope: BranchViewSyncScope.Comments,
      });
      await commentsSync.promise;
    });

    await vi.waitFor(() => {
      expect(result.current.isBranchSyncPending).toBe(false);
      expect(result.current.isCommentsSyncPending).toBe(false);
    });
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      1,
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Branch }
    );
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      2,
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Comments }
    );
  });

  it("treats branch throttles as terminal for the composite refresh", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError("Branch view sync is throttled", 429, {
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: { retryAfterSeconds: 2 },
      })
    );

    const { result } = renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            currentPullRequest: {
              baseBranch: "main",
              checksStatus: null,
              githubId: "1001",
              headBranch: "feature/branch",
              headSha: "head-sha",
              htmlUrl: "https://github.com/acme/repo/pull/42",
              id: "pr-detail-1",
              isDraft: false,
              number: 42,
              reviewDecision: null,
              state: GitHubPRState.Open,
              title: "Feature branch",
            },
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.refreshBranch();
    });

    await vi.waitFor(() =>
      expect(result.current.syncRetryState).toEqual({
        retryAfterSeconds: 2,
        throttleReason: null,
      })
    );

    await vi.waitFor(() => {
      expect(result.current.isBranchSyncPending).toBe(false);
      expect(result.current.isCommentsSyncPending).toBe(false);
    });
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      1,
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Branch }
    );
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
  });

  it("surfaces comments provider throttles during composite refresh", async () => {
    mockApiClient.post
      .mockResolvedValueOnce({
        synced: true,
        scope: BranchViewSyncScope.Branch,
      })
      .mockRejectedValueOnce(
        new ApiError("Branch view sync is throttled", 429, {
          code: BranchViewSyncErrorCode.SyncThrottled,
          details: {
            retryAfterSeconds: 17,
            throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
          },
        })
      );

    const { result } = renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            currentPullRequest: {
              baseBranch: "main",
              checksStatus: null,
              githubId: "1001",
              headBranch: "feature/branch",
              headSha: "head-sha",
              htmlUrl: "https://github.com/acme/repo/pull/42",
              id: "pr-detail-1",
              isDraft: false,
              number: 42,
              reviewDecision: null,
              state: GitHubPRState.Open,
              title: "Feature branch",
            },
          }),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.refreshBranch();
    });

    await vi.waitFor(() =>
      expect(result.current.syncRetryState).toEqual({
        retryAfterSeconds: 17,
        throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      })
    );
    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      2,
      "/branch-view/branch-artifact-1/sync",
      { scope: BranchViewSyncScope.Comments }
    );
  });

  it("keeps comments pending independent from fresh branch sync projection and clears after comments settle", async () => {
    const branchSync = deferred<{
      synced: true;
      scope: typeof BranchViewSyncScope.Branch;
    }>();
    const commentsSync = deferred<{
      synced: true;
      scope: typeof BranchViewSyncScope.Comments;
    }>();
    mockApiClient.post
      .mockReturnValueOnce(branchSync.promise)
      .mockReturnValueOnce(commentsSync.promise);
    const currentPullRequest = {
      baseBranch: "main",
      checksStatus: null,
      githubId: "1001",
      headBranch: "feature/branch",
      headSha: "head-sha",
      htmlUrl: "https://github.com/acme/repo/pull/42",
      id: "pr-detail-1",
      isDraft: false,
      number: 42,
      reviewDecision: null,
      state: GitHubPRState.Open,
      title: "Feature branch",
    };

    const { rerender, result } = renderHook(
      ({ data }) =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data,
          externalLinkId: "branch-artifact-1",
        }),
      {
        initialProps: {
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
            currentPullRequest,
          }),
        },
        wrapper: createWrapper(),
      }
    );

    act(() => {
      result.current.refreshBranch();
    });

    await act(async () => {
      branchSync.resolve({
        synced: true,
        scope: BranchViewSyncScope.Branch,
      });
      await branchSync.promise;
    });
    await vi.waitFor(() =>
      expect(result.current.isCommentsSyncPending).toBe(true)
    );

    rerender({
      data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle, {
        currentPullRequest,
        syncState: syncState({
          backgroundRefreshAfterAt: null,
          inProgress: false,
          presentation: BranchViewSyncPresentationState.Fresh,
        }),
      }),
    });

    expect(result.current.isBranchSyncPending).toBe(false);
    expect(result.current.isCommentsSyncPending).toBe(true);

    await act(async () => {
      commentsSync.resolve({
        synced: true,
        scope: BranchViewSyncScope.Comments,
      });
      await commentsSync.promise;
    });

    await vi.waitFor(() =>
      expect(result.current.isCommentsSyncPending).toBe(false)
    );
  });

  it("clears branch rate-limit metadata after Retry-After expires", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError("Branch view sync is throttled", 429, {
        code: BranchViewSyncErrorCode.SyncThrottled,
        details: { retryAfterSeconds: 2 },
      })
    );

    const { result } = renderHook(
      () =>
        useBranchViewSyncControl({
          backgroundEnabled: false,
          data: branchViewData(BranchViewPrLifecycleRepairStatus.Idle),
          externalLinkId: "branch-artifact-1",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.refreshBranch();
    });

    await vi.waitFor(() =>
      expect(result.current.syncRetryState).toEqual({
        retryAfterSeconds: 2,
        throttleReason: null,
      })
    );
    expect(result.current.syncRetryState).toEqual({
      retryAfterSeconds: 2,
      throttleReason: null,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await vi.waitFor(() => expect(result.current.syncRetryState).toBeNull());
    expect(result.current.syncRetryState).toBeNull();
  });
});

describe("branch-view conversation comment mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates conversation comments and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useCreateBranchViewConversationComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() => result.current.mutateAsync({ body: "Looks good" }));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/conversation",
      { body: "Looks good" }
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("routes Branch View comment mutation errors through the identity-blocker onError", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.post.mockRejectedValue(
      new ApiError("Connect GitHub", 403, {
        details: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
      })
    );

    const { result } = renderHook(
      () => useCreateBranchViewConversationComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await expect(
      act(() => result.current.mutateAsync({ body: "Looks good" }))
    ).rejects.toThrow("Connect GitHub");

    expect(
      queryClient.getMutationCache().getAll().at(-1)?.options.onError
    ).toBe(branchViewCommentOnError);
  });

  it("returns 202 projection recovery results and still refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const projectionResult = {
      success: false,
      action: BranchViewCommentAction.CreateConversation,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.DirectReprojection,
      github: { commentId: "123" },
    };
    mockApiClient.post.mockResolvedValueOnce(projectionResult);

    const { result } = renderHook(
      () => useCreateBranchViewConversationComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await expect(
      act(() => result.current.mutateAsync({ body: "Looks good" }))
    ).resolves.toEqual(projectionResult);

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("edits conversation comments and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.patch.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useEditBranchViewConversationComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() =>
      result.current.mutateAsync({
        githubCommentId: "123",
        body: "Updated",
      })
    );

    expect(mockApiClient.patch).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/123",
      { body: "Updated" }
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("deletes conversation comments and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.delete.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useDeleteBranchViewConversationComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() => result.current.mutateAsync("123"));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/123"
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("creates inline review comments with the exact current route and body", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useCreateBranchViewInlineComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() =>
      result.current.mutateAsync({
        body: "Inline note",
        expectedHeadSha: "file-cache-head-sha",
        line: 42,
        path: "src/app.tsx",
        side: GitHubDiffSide.Right,
      })
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/inline",
      {
        body: "Inline note",
        expectedHeadSha: "file-cache-head-sha",
        line: 42,
        path: "src/app.tsx",
        side: GitHubDiffSide.Right,
      }
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("returns inline projection recovery results and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const projectionResult = {
      success: false,
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
      github: { commentId: "123" },
    };
    mockApiClient.post.mockResolvedValueOnce(projectionResult);

    const { result } = renderHook(
      () => useCreateBranchViewInlineComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          body: "Inline note",
          expectedHeadSha: "file-cache-head-sha",
          line: 42,
          path: "src/app.tsx",
          side: GitHubDiffSide.Right,
        })
      ).resolves.toEqual(projectionResult);
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("edits review comments through the review route", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.patch.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useEditBranchViewReviewComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() =>
      result.current.mutateAsync({ commentId: "comment-1", body: "Updated" })
    );

    expect(mockApiClient.patch).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/review/comment-1",
      { body: "Updated" }
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("returns review projection recovery results and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const projectionResult = {
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
    };
    mockApiClient.patch.mockResolvedValueOnce(projectionResult);

    const { result } = renderHook(
      () => useEditBranchViewReviewComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          commentId: "comment-1",
          body: "Updated",
        })
      ).resolves.toEqual(projectionResult);
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.detail("branch-artifact-1"),
      })
    );
  });

  it("deletes review comments through the review route without a request body", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.delete.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(
      () => useDeleteBranchViewReviewComment("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() => result.current.mutateAsync("comment-1"));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/review/comment-1"
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: branchViewKeys.detail("branch-artifact-1"),
    });
  });

  it("resolves review threads with an empty body and refreshes branch-view data", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValueOnce({
      success: true,
      action: BranchViewCommentAction.Resolve,
    });

    const { result } = renderHook(
      () => useResolveBranchViewReviewThread("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(() => result.current.mutateAsync("comment-1"));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/review/comment-1/resolve",
      {}
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: branchViewKeys.detail("branch-artifact-1"),
    });
  });

  it("unresolves review threads with an empty body and no retry wrapper", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError(
        "GitHub review thread resolution failed",
        502,
        "GITHUB_WRITE_FAILED",
        {
          success: false,
          action: BranchViewCommentAction.Unresolve,
          code: BranchViewCommentActionResultCode.GithubWriteFailed,
          message: "GitHub review thread resolution failed",
        }
      )
    );

    const { result } = renderHook(
      () => useUnresolveBranchViewReviewThread("branch-artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await expect(
      act(() => result.current.mutateAsync("comment-1"))
    ).rejects.toThrow("GitHub review thread resolution failed");

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/branch-view/branch-artifact-1/comments/review/comment-1/unresolve",
      {}
    );
  });
});

describe("useDeleteBranch", () => {
  it("issues DELETE /branches/:id and invalidates tree, documents, and branch-view caches", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

    const { result } = renderHook(() => useDeleteBranch(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() => result.current.mutateAsync("branch-artifact-1"));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/branches/branch-artifact-1"
    );
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: projectTreeKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: documentKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: branchViewKeys.all,
      });
    });
  });

  it("invalidates resolved artifact-link queries referencing the deleted branch", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

    // The deleted branch's ArtifactLink rows are removed by the DB cascade;
    // a resolved relationship query holding one of those links must go stale
    // so relationship sections stop rendering the dead /build/:id link.
    const referencingFilters = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const unrelatedFilters = {
      artifactId: "feature-2",
      direction: "both",
      resolved: true,
    };
    queryClient.setQueryData(artifactLinkKeys.list(referencingFilters), [
      { id: "link-1", sourceId: "feature-1", targetId: "branch-artifact-1" },
    ]);
    queryClient.setQueryData(artifactLinkKeys.list(unrelatedFilters), [
      { id: "link-2", sourceId: "feature-2", targetId: "other-artifact" },
    ]);

    const { result } = renderHook(() => useDeleteBranch(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    // onSuccess invalidation runs before mutateAsync resolves; assert
    // synchronously so the zero-gcTime test client hasn't collected the
    // observer-less seeded queries yet.
    await act(() => result.current.mutateAsync("branch-artifact-1"));

    expect(
      queryClient.getQueryState(artifactLinkKeys.list(referencingFilters))
        ?.isInvalidated
    ).toBe(true);
    expect(
      queryClient.getQueryState(artifactLinkKeys.list(unrelatedFilters))
        ?.isInvalidated
    ).toBe(false);
  });
});
