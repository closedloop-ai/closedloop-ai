import {
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  GitHubDiffSide,
  PRReviewCommentState,
} from "@repo/api/src/types/branch-view";
import { ThreadStatus } from "@repo/api/src/types/comment";
import { GitHubLegacyCommentState } from "@repo/database";
import type { GitHubPullRequestReviewComment } from "@repo/github/comment-payloads";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const withDbMock = vi.fn();
  return {
    commentFindFirst: vi.fn(),
    commentThreadUpdate: vi.fn(),
    threadProjectionUpdate: vi.fn(),
    getGitHubWriteIdentityStatus: vi.fn(),
    requireGitHubWriteIdentity: vi.fn(),
    resolveExternalGitHubAuthorInTransaction: vi.fn(),
    resolvePullRequestReviewThreadWithUserToken: vi.fn(),
    unresolvePullRequestReviewThreadWithUserToken: vi.fn(),
    updatePullRequestReviewCommentWithUserToken: vi.fn(),
    upsertGitHubReviewCommentThread: vi.fn(),
    withDb: Object.assign(withDbMock, { tx: vi.fn() }),
  };
});

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});

vi.mock("@repo/github", () => ({
  createPullRequestReviewCommentWithUserToken: vi.fn(),
  createReplyForReviewCommentWithUserToken: vi.fn(),
  deletePullRequestReviewCommentWithUserToken: vi.fn(),
  resolvePullRequestReviewThreadWithUserToken:
    mocks.resolvePullRequestReviewThreadWithUserToken,
  unresolvePullRequestReviewThreadWithUserToken:
    mocks.unresolvePullRequestReviewThreadWithUserToken,
  updatePullRequestReviewCommentWithUserToken:
    mocks.updatePullRequestReviewCommentWithUserToken,
}));

vi.mock("@/app/comments/external-authors", () => ({
  resolveExternalGitHubAuthorInTransaction:
    mocks.resolveExternalGitHubAuthorInTransaction,
}));

vi.mock("@/app/comments/github-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/comments/github-identity")>();
  return {
    ...actual,
    getGitHubWriteIdentityStatus: mocks.getGitHubWriteIdentityStatus,
    requireGitHubWriteIdentity: mocks.requireGitHubWriteIdentity,
  };
});

vi.mock("@/app/comments/github-projection", () => ({
  upsertGitHubReviewCommentThread: mocks.upsertGitHubReviewCommentThread,
}));

import type { ReviewTargetRowInput } from "@/__tests__/support/branch-view/direct-write.test-fixtures";
import {
  authContext,
  isProjectedCommentLookup,
  prContext,
  projectedCommentRow,
  providerComment,
  reviewTargetRow,
  testUser,
  WRITE_OCTOKIT,
  writeIdentity,
  writeIdentityStatus,
} from "@/__tests__/support/branch-view/direct-write.test-fixtures";
import {
  editReviewComment,
  resolveReviewThread,
  unresolveReviewThread,
} from "./direct-write-service";

/** The projection transaction the edit path writes through. */
function installProjectionTx() {
  mocks.resolveExternalGitHubAuthorInTransaction.mockResolvedValue({
    externalAuthor: { id: "external-author-1" },
    identity: {
      providerLogin: "author",
      avatarUrl: "https://avatars.example.test/author.png",
    },
    user: { id: "user-1" },
  });
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ comment: { findFirst: mocks.commentFindFirst } })
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ comment: { findFirst: mocks.commentFindFirst } })
  );
  mocks.upsertGitHubReviewCommentThread.mockImplementation(
    (
      _tx: unknown,
      input: { comments: Array<{ githubCommentId: string | number }> }
    ) =>
      Promise.resolve({
        threadId: "thread-1",
        commentIds: input.comments.map(
          (comment) => `comment-${comment.githubCommentId}`
        ),
        createdGithubCommentIds: input.comments.map((comment) =>
          String(comment.githubCommentId)
        ),
      })
  );
  installCommentFindFirst();
}

/**
 * What the reconciling transaction actually WROTE, carried into the re-read the
 * same transaction performs.
 *
 * A constant re-read row reports Open/Pending back to the caller no matter what
 * the write put on the thread, so `result.comment` could contradict the write
 * with a green suite.
 */
const reconciledWrites: {
  status?: ThreadStatus;
  legacyState?: PRReviewCommentState;
} = {};

/**
 * Route the two `comment.findFirst` shapes the write path issues: the review
 * target it mutates, and the post-write re-read that becomes the returned
 * comment.
 */
function installCommentFindFirst(input?: {
  target?: Partial<ReviewTargetRowInput>;
  rereadMissing?: boolean;
}) {
  mocks.commentFindFirst.mockImplementation((query: unknown) => {
    if (isProjectedCommentLookup(query)) {
      return Promise.resolve(
        input?.rereadMissing
          ? null
          : projectedCommentRow(query, reconciledWrites)
      );
    }
    return Promise.resolve(
      reviewTargetRow({
        deletedAt: null,
        githubDeletedAt: null,
        ...input?.target,
      })
    );
  });
}

/**
 * ISS-5291: the local reconciliation that runs AFTER GitHub accepts a thread
 * resolve/unresolve.
 *
 * `reconcileReviewThreadResolution` had no test calls. It is the half of the
 * write that decides what this product shows once the provider has already
 * changed: the local thread status, the resolved-by attribution, and the legacy
 * projection state. Getting it wrong means the UI disagrees with GitHub about a
 * thread that was resolved successfully — the worst kind of drift, because the
 * write did work and nothing errored.
 *
 * The provider's answer is authoritative here, not the button the user pressed;
 * that distinction is the first thing pinned below.
 */
describe("review thread resolution — reconciling the local projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
    mocks.getGitHubWriteIdentityStatus.mockResolvedValue(writeIdentityStatus());
    installResolutionTx();
  });

  it("writes RESOLVED, the resolver, and the ADDRESSED projection on a resolve", async () => {
    mocks.resolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: true,
    });

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result.success).toBe(true);
    expect(mocks.commentThreadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread-1" },
        data: expect.objectContaining({
          status: ThreadStatus.Resolved,
          // A resolved thread is stamped with WHEN it was resolved, not just by
          // whom — leaving this null would make every resolve look unresolved
          // to anything reading the timestamp.
          resolvedAt: expect.any(Date),
          resolvedById: "user-1",
        }),
      })
    );
    expect(mocks.threadProjectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.ADDRESSED,
        }),
      })
    );
    // The response is re-read from what the same transaction just wrote, so it
    // must agree with it. Asserting only the writes would let the returned
    // comment keep reporting an unresolved thread after a successful resolve.
    expect(result).toMatchObject({
      success: true,
      comment: { resolved: true, state: PRReviewCommentState.Addressed },
    });
  });

  it("clears the resolver and reopens the thread on an unresolve", async () => {
    mocks.unresolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: false,
    });
    installResolutionTx({ status: ThreadStatus.Resolved });

    const result = await unresolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result.success).toBe(true);
    // `resolvedAt`/`resolvedById` must be NULLED, not left pointing at whoever
    // resolved it last — a reopened thread has no resolver.
    expect(mocks.commentThreadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
        }),
      })
    );
    expect(mocks.threadProjectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.PENDING,
        }),
      })
    );
    expect(result).toMatchObject({
      success: true,
      comment: { resolved: false, state: PRReviewCommentState.Pending },
    });
  });

  it("follows the PROVIDER's state, not the action the user requested", async () => {
    // GitHub accepted the call but reports the thread is still open — a
    // concurrent reopen, or a thread the mutation could not actually close.
    mocks.resolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: false,
    });

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    // Writing RESOLVED here because the user pressed Resolve would make this
    // product assert something GitHub just denied.
    expect(mocks.commentThreadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
        }),
      })
    );
    // The legacy projection follows the SAME provider signal. Pinning only
    // `commentThread` would let this state be derived from the requested
    // action instead, and the two halves would disagree on this exact case.
    expect(mocks.threadProjectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.PENDING,
        }),
      })
    );
    expect(result).toMatchObject({
      success: true,
      comment: { resolved: false, state: PRReviewCommentState.Pending },
    });
  });

  it("reports a projection failure when the reconciled comment cannot be re-read", async () => {
    mocks.resolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: true,
    });
    installCommentFindFirst({ rereadMissing: true });

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    // The provider mutation SUCCEEDED, so this is not a write failure — it is a
    // "we changed GitHub but cannot show you the result" outcome, and the codes
    // are deliberately different so the client does not offer a retry that
    // would double-apply.
    expect(result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      // The recovery hint is the actionable half: re-sync the branch view
      // rather than retrying a provider write that already landed.
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
    });
  });

  it("reports a projection failure when the reconciling transaction throws", async () => {
    mocks.resolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: true,
    });
    mocks.withDb.tx.mockRejectedValue(new Error("deadlock detected"));

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
    });
  });

  it("reports a GitHub write failure without touching local state", async () => {
    mocks.resolvePullRequestReviewThreadWithUserToken.mockRejectedValue(
      new Error("GraphQL: Resource not accessible")
    );

    const result = await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    // Local projection is reconciled only AFTER the provider confirms, so a
    // failed provider call must leave the thread exactly as it was.
    expect(result).toMatchObject({
      success: false,
      code: BranchViewCommentActionResultCode.GithubWriteFailed,
    });
    expect(mocks.commentThreadUpdate).not.toHaveBeenCalled();
    expect(mocks.threadProjectionUpdate).not.toHaveBeenCalled();
  });

  it("routes a resolve to the resolve mutation and not the unresolve one", async () => {
    mocks.resolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: true,
    });

    await resolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(
      mocks.resolvePullRequestReviewThreadWithUserToken
    ).toHaveBeenCalledWith(WRITE_OCTOKIT, "review-thread-1");
    expect(
      mocks.unresolvePullRequestReviewThreadWithUserToken
    ).not.toHaveBeenCalled();
  });

  /**
   * The symmetric half. Without it the unresolve direction is pinned only by the
   * `isResolved` value the reconciliation writes, which a routing swap can still
   * satisfy whenever a stale provider mock answers — `vi.clearAllMocks()` resets
   * call records but PRESERVES implementations, so the resolve mock installed by
   * an earlier test survives into this one. Asserting the mutation that was
   * actually invoked is order-independent; asserting only the outcome is not.
   */
  it("routes an unresolve to the unresolve mutation and not the resolve one", async () => {
    mocks.unresolvePullRequestReviewThreadWithUserToken.mockResolvedValue({
      isResolved: false,
    });
    // An unresolve is only permitted against a thread that is actually
    // resolved; on the default Open target the permission check rejects before
    // any provider mutation runs, and both assertions below would pass for the
    // wrong reason.
    installResolutionTx({ status: ThreadStatus.Resolved });

    await unresolveReviewThread({
      auth: authContext(),
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });

    expect(
      mocks.unresolvePullRequestReviewThreadWithUserToken
    ).toHaveBeenCalledWith(WRITE_OCTOKIT, "review-thread-1");
    expect(
      mocks.resolvePullRequestReviewThreadWithUserToken
    ).not.toHaveBeenCalled();
  });
});

/**
 * ISS-5291: the anchor fallback chain in `projectProviderComment`.
 *
 * GitHub's edit response does not always echo the inline anchor — `line`,
 * `side`, `start_line`, `start_side`, `commit_id` and the thread ids can all
 * come back absent. Every one of them is written as
 * `providerValue ?? storedThreadValue ?? null`, and the middle term is the whole
 * point: without it an edit silently RE-ANCHORS the comment to nothing, and a
 * review comment pinned to `src/runtime.ts:10` becomes a floating comment on the
 * next render.
 *
 * Each field is driven on its own. A single sparse-response test would pass
 * while any one `?? fallbackThread` term was deleted, because the others still
 * supply their values.
 *
 * `path` and `html_url` are NOT in the table. The canonical
 * `GitHubPullRequestReviewComment` declares both non-nullable and
 * `mapPullRequestReviewComment` passes them straight through, so their
 * `?? fallbackThread` terms cannot fire and a case for them would only exercise
 * an input the types forbid. Whether the canonical type is too strict or those
 * two fallbacks are dead is a production question, deliberately left to its own
 * change rather than settled inside a coverage PR.
 */
describe("editReviewComment — preserving the anchor when GitHub omits it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installProjectionTx();
    mocks.requireGitHubWriteIdentity.mockResolvedValue(writeIdentity());
    mocks.getGitHubWriteIdentityStatus.mockResolvedValue(writeIdentityStatus());
  });

  async function editWithProviderResponse(
    overrides: Partial<GitHubPullRequestReviewComment>,
    target?: Partial<ReviewTargetRowInput>
  ) {
    if (target) {
      installCommentFindFirst({ target });
    }
    mocks.updatePullRequestReviewCommentWithUserToken.mockResolvedValue({
      ...providerComment({ id: 123_456 }),
      ...overrides,
    });
    await editReviewComment({
      auth: authContext(),
      body: "edited body",
      commentId: "comment-1",
      ctx: prContext(),
      user: testUser(),
    });
    return mocks.upsertGitHubReviewCommentThread.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
  }

  it.each([
    {
      field: "line",
      override: { line: null },
      projectedKey: "line",
      expected: 10,
    },
    {
      field: "side",
      override: { side: null },
      projectedKey: "side",
      expected: GitHubDiffSide.Right,
    },
    // The multi-line anchor. The stored value has to be driven in here: a
    // single-line thread stores `startLine`/`startSide` as null, so a case
    // built on the default target would pass with the fallback term deleted.
    {
      field: "start_line",
      override: { start_line: null },
      projectedKey: "startLine",
      expected: 7,
      target: { startLine: 7 },
    },
    {
      field: "start_side",
      override: { start_side: null },
      projectedKey: "startSide",
      expected: GitHubDiffSide.Left,
      target: { startSide: GitHubDiffSide.Left },
    },
    {
      field: "commit_id",
      override: { commit_id: null },
      projectedKey: "commitSha",
      expected: "head-sha",
    },
    {
      field: "review_thread_node_id",
      override: { review_thread_node_id: null },
      projectedKey: "reviewThreadId",
      expected: "review-thread-1",
    },
    {
      field: "pull_request_review_id",
      override: { pull_request_review_id: null },
      projectedKey: "reviewId",
      expected: "review-1",
    },
  ])("falls back to the stored thread when the response omits $field", async ({
    override,
    projectedKey,
    expected,
    target,
  }) => {
    const projected = await editWithProviderResponse(override, target);

    expect(projected[projectedKey]).toBe(expected);
  });

  it("prefers the provider value over the stored one when both are present", async () => {
    const projected = await editWithProviderResponse({
      path: "src/moved.ts",
      line: 42,
    });

    // The provider is authoritative when it answers: an edit that genuinely
    // re-anchored the comment must not be overwritten by stale local state.
    expect(projected.path).toBe("src/moved.ts");
    expect(projected.line).toBe(42);
  });

  it("writes null only when neither the provider nor the thread has a value", async () => {
    const projected = await editWithProviderResponse(
      { line: null },
      { line: null }
    );

    // `null` is the honest answer once both sources are empty — the fallback
    // must not invent an anchor either.
    expect(projected.line).toBeNull();
  });
});

/**
 * Install the transaction double the resolution path uses: a thread update, a
 * projection update, and the re-read that produces the returned comment.
 */
function installResolutionTx(target?: Partial<ReviewTargetRowInput>) {
  Reflect.deleteProperty(reconciledWrites, "status");
  Reflect.deleteProperty(reconciledWrites, "legacyState");
  mocks.commentThreadUpdate.mockImplementation(
    (args: { data: { status: ThreadStatus } }) => {
      reconciledWrites.status = args.data.status;
      return Promise.resolve({});
    }
  );
  mocks.threadProjectionUpdate.mockImplementation(
    (args: { data: { legacyState: PRReviewCommentState } }) => {
      reconciledWrites.legacyState = args.data.legacyState;
      return Promise.resolve({});
    }
  );
  installCommentFindFirst({ target });
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ comment: { findFirst: mocks.commentFindFirst } })
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      comment: { findFirst: mocks.commentFindFirst },
      commentThread: { update: mocks.commentThreadUpdate },
      gitHubCommentThreadProjection: { update: mocks.threadProjectionUpdate },
    })
  );
}
