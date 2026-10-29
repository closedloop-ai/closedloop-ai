// @vitest-environment jsdom

import {
  BranchCommentsState,
  type BranchPageDetail,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  type TraceCommentReply,
} from "@repo/api/src/types/comment";
import { traceCommentKeys } from "@repo/app/shared/trace-comments/trace-comment-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS,
  BRANCH_COMMENTS_READ_TIMEOUT_MS,
  type BranchCommentCollectionResult,
} from "../branch-comments-collection-reader";
import { BranchCommentsTab } from "../branch-comments-model";

type CapturedQueryOptions = {
  queryFn?: (context: { signal: AbortSignal }) => Promise<unknown>;
  refetchInterval?: (query: {
    state: { status: string };
  }) => number | false | undefined;
  refetchOnReconnect?: boolean;
  refetchOnWindowFocus?: boolean;
  staleTime?: number;
};

const mocks = vi.hoisted(() => ({
  capabilities: undefined as { branchTimelineWrites: true } | undefined,
  invalidateQueries: vi.fn(),
  isError: false,
  list: vi.fn(),
  nativeResults: [] as unknown[],
  queryOptions: undefined as CapturedQueryOptions | undefined,
  retrySync: undefined as ReturnType<typeof vi.fn> | undefined,
  toastError: vi.fn(),
  workspaceProps: undefined as Record<string, unknown> | undefined,
}));

/*
 * ISS-10383: `retrySync` is spread in rather than always defined, because the
 * port's contract is "present means supported" — a source that merely defines a
 * method which throws is what the Sessions rail and the Desktop adapter both
 * refuse to build, since it renders a retry door that fails on click.
 */
vi.mock("@repo/app/shared/trace-comments/trace-comments-provider", () => ({
  useTraceCommentsDataSource: () => ({
    scope: "test",
    list: mocks.list,
    ...(mocks.capabilities ? { capabilities: mocks.capabilities } : {}),
    ...(mocks.retrySync ? { retrySync: mocks.retrySync } : {}),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: CapturedQueryOptions) => {
    mocks.queryOptions = options;
    return {
      data: mocks.nativeResults,
      isError: mocks.isError,
      isLoading: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("../branch-comments-workspace", () => ({
  BranchCommentsWorkspace: (props: Record<string, unknown>) => {
    mocks.workspaceProps = props;
    return null;
  },
}));

import { BranchCommentsController } from "../branch-comments-controller";

describe("BranchCommentsController provider production wiring", () => {
  beforeEach(() => {
    mocks.capabilities = undefined;
    mocks.isError = false;
    mocks.nativeResults = [];
    mocks.retrySync = undefined;
    mocks.list.mockReset();
    mocks.invalidateQueries.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The native rail is the other half of the same comment list as the provider
   * rail, so it has to stay wired to the shared label helper rather than carry
   * its own copy. Both the readable and the unparseable case are asserted
   * through the production mapper, on the root and on a reply: swapping
   * `formatBranchCommentTime` back out for a private formatter here fails on
   * the fallback wording rather than passing silently.
   */
  it("labels native comment and reply timestamps through the shared branch formatter", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    mocks.nativeResults = [
      nativeCollectionResult(
        nativeComment({
          createdAt: "2026-01-15T11:55:00.000Z",
          replies: [nativeReply({ createdAt: "not-a-timestamp" })],
        })
      ),
    ];

    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({
        createdAtLabel: "5 min ago",
        replies: [expect.objectContaining({ createdAtLabel: "Unknown time" })],
      }),
    ]);
  });

  it("passes the selected response's root, reply, and availability evidence to the workspace", () => {
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Details}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        providerComments={providerResponse()}
        renderedSessionIds={[]}
        returnFocusRef={{ current: null }}
        selectedPullRequestKey="closedloop-ai/closedloop-ai#42"
      />
    );

    expect(mocks.workspaceProps?.providerAvailability).toMatchObject({
      bodyTruncatedCount: 2,
      mixedProjection: true,
      omittedComments: 3,
      providerTruncated: true,
      responseTruncated: true,
      stale: true,
    });
    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({
          kind: BranchPrCommentKind.Review,
          login: "root-reviewer",
          stale: true,
        }),
        replies: [
          expect.objectContaining({
            provider: expect.objectContaining({
              kind: BranchPrCommentKind.ReviewReply,
              providerUrl: expect.stringContaining("discussion_r2"),
            }),
          }),
        ],
      }),
    ]);
  });

  it("does not pass provider evidence into Sessions", () => {
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Sessions}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        providerComments={providerResponse()}
        renderedSessionIds={[]}
        returnFocusRef={{ current: null }}
        selectedPullRequestKey="closedloop-ai/closedloop-ai#42"
      />
    );

    expect(mocks.workspaceProps?.providerAvailability).toBeUndefined();
    expect(mocks.workspaceProps?.comments).toEqual([]);
  });

  it("issues its native reads with the query's signal and the read deadline (ISS-5110)", async () => {
    mocks.list.mockResolvedValue([]);
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Sessions}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        renderedSessionIds={["session-1"]}
        returnFocusRef={{ current: null }}
      />
    );
    const controller = new AbortController();

    await mocks.queryOptions?.queryFn?.({ signal: controller.signal });

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      undefined,
      { signal: controller.signal, timeoutMs: BRANCH_COMMENTS_READ_TIMEOUT_MS }
    );
  });

  it("fails the query when no native collection could be read (ISS-5110)", async () => {
    mocks.list.mockRejectedValue(new Error("comments unavailable"));
    renderSessionsWorkspace();

    await expect(
      mocks.queryOptions?.queryFn?.({ signal: new AbortController().signal })
    ).rejects.toThrow("comments unavailable");
  });

  it("keeps a partly-failed read successful so peers survive", async () => {
    mocks.list.mockImplementation((target: { id: string }) => {
      if (target.id === "session-1") {
        return Promise.reject(new Error("comments unavailable"));
      }
      return Promise.resolve([]);
    });
    renderSessionsWorkspace();

    const results = await mocks.queryOptions?.queryFn?.({
      signal: new AbortController().signal,
    });

    expect(results).toHaveLength(2);
  });

  it("re-attempts only while the read is errored", () => {
    renderSessionsWorkspace();

    expect(
      mocks.queryOptions?.refetchInterval?.({ state: { status: "error" } })
    ).toBe(BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS);
    expect(
      mocks.queryOptions?.refetchInterval?.({ state: { status: "success" } })
    ).toBe(false);
  });

  it("opts out of the shared client's focus and reconnect refetch defaults (ISS-5976)", () => {
    // This read is `staleTime: 0`, so it is ALWAYS stale and the shared client's
    // `staleTime` bound cannot apply to it: inheriting the ON defaults would
    // re-run the whole per-collection fan-out on every focus and every reconnect,
    // not once a minute. The opt-out is declared at this construction site, which
    // is where that policy requires an exception to be argued.
    renderSessionsWorkspace();

    expect(mocks.queryOptions?.staleTime).toBe(0);
    expect(mocks.queryOptions?.refetchOnWindowFocus).toBe(false);
    expect(mocks.queryOptions?.refetchOnReconnect).toBe(false);
  });

  it("states that comments are unavailable rather than rendering a failed read as empty", () => {
    mocks.isError = true;
    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.hasError).toBe(true);
    expect(mocks.workspaceProps?.readFailed).toBe(true);
    expect(mocks.workspaceProps?.coverageNote).toContain("aren't available");
  });

  it("does not report a partial read failure as an outright one (ISS-12597)", () => {
    mocks.nativeResults = [
      {
        ...nativeCollectionResult(),
        error: new Error("one collection timed out"),
      },
    ];
    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.hasError).toBe(true);
    expect(mocks.workspaceProps?.readFailed).toBe(false);
  });
});

/**
 * ISS-10383: the branch surface's half of the dead-letter recovery door — the
 * read that carries the terminal state onto the thread, the write that moves it,
 * and the per-ROW decision about whether a door can honestly be offered. The
 * render half lives in `branch-comments-sync-abandoned.test.tsx`.
 */
describe("BranchCommentsController sync_abandoned wiring (ISS-10383)", () => {
  beforeEach(() => {
    mocks.capabilities = undefined;
    mocks.isError = false;
    mocks.nativeResults = [];
    mocks.retrySync = undefined;
    mocks.list.mockReset();
    mocks.invalidateQueries.mockReset();
    mocks.toastError.mockReset();
  });

  it("carries the terminal delivery state onto the thread and withholds the door from a source that cannot re-pend", () => {
    // Both halves of the shipped cloud state in one case: without the first the
    // badge cannot render at any flag setting, which is the defect; without the
    // second a source that never dead-letters would still offer a retry.
    mocks.nativeResults = [
      nativeCollectionResult(nativeComment({ syncAbandoned: true })),
    ];

    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({
        canRetrySync: false,
        id: "native-1",
        syncAbandoned: true,
      }),
    ]);
    expect(mocks.workspaceProps?.onRetrySync).toBeUndefined();
  });

  it("leaves the field ABSENT on a row the source said nothing about", () => {
    // Not `false`. `packages/api/src/types/comment.ts` requires both to render as
    // "not abandoned", so this is invisible on screen — it is the mapper being
    // held to reshaping nothing the port said. `objectContaining` cannot express
    // an absence, which is why this asserts the key itself.
    mocks.nativeResults = [nativeCollectionResult(nativeComment({}))];

    renderSessionsWorkspace();

    const comments = (mocks.workspaceProps?.comments ?? []) as Record<
      string,
      unknown
    >[];
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toHaveProperty("syncAbandoned");
  });

  it("re-pends a session row with the collection OMITTED, then refreshes the list", async () => {
    mocks.retrySync = vi.fn().mockResolvedValue([]);
    renderSessionsWorkspace();

    await retrySyncHandler()("native-1", {
      id: "session-1",
      type: CommentTargetType.Session,
    });

    // Two arguments, not three. A source may distinguish "no collection" from
    // "an undefined collection", so the omission is the contract rather than a
    // stylistic choice.
    expect(mocks.retrySync).toHaveBeenCalledWith(
      { id: "session-1", type: CommentTargetType.Session },
      "native-1"
    );
    // The badge reads the refreshed list, so a retry that never invalidates
    // leaves a re-pended comment wearing its failure until the next mount.
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: traceCommentKeys.all,
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("re-pends a Branch-timeline row WITH its collection when the source can address it", async () => {
    // The other half of the pair above, and the only permutation that exercises
    // the collection-carrying call at all: outer capability ON, so the write is
    // allowed and must arrive addressed to the timeline collection rather than
    // silently landing in Branch/details.
    mocks.capabilities = { branchTimelineWrites: true };
    mocks.retrySync = vi.fn().mockResolvedValue([]);
    renderSessionsWorkspace();

    await retrySyncHandler()(
      "native-1",
      { id: "branch-1", type: CommentTargetType.Branch },
      { surface: CommentSurface.BranchTimeline }
    );

    expect(mocks.retrySync).toHaveBeenCalledWith(
      { id: "branch-1", type: CommentTargetType.Branch },
      "native-1",
      { surface: CommentSurface.BranchTimeline }
    );
  });

  it("marks a Branch-timeline row un-retryable while its session peers stay retryable", () => {
    // The version-skewed desktop shell, and the reason the decision is per ROW:
    // `retrySync` and `branchTimelineWrites` are independent bridge fields, so a
    // source can re-pend a session row in the same list it must refuse a timeline
    // row in. One list, two answers, resolved where the source is.
    mocks.retrySync = vi.fn();
    mocks.nativeResults = [
      nativeCollectionResult(nativeComment({ syncAbandoned: true })),
      sessionCollectionResult(
        nativeComment({
          id: "native-2",
          surface: CommentSurface.SessionDetail,
          syncAbandoned: true,
          target: { type: CommentTargetType.Session, id: "session-1" },
        })
      ),
    ];

    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({ canRetrySync: false, id: "native-1" }),
      expect.objectContaining({ canRetrySync: true, id: "native-2" }),
    ]);
  });

  it("shows a non-author the failure but no door", () => {
    // ISS-10382: the cloud serves `syncAbandoned` to every viewer of the thread,
    // so the desktop queue's implicit "these are my own rows" no longer holds and
    // authorship has to be asked explicitly. The Sessions twin has this
    // counterfactual; without it here, deleting `comment.canEdit` from
    // `canRetrySyncFor` leaves the whole branches suite green.
    mocks.retrySync = vi.fn();
    mocks.nativeResults = [
      sessionCollectionResult(
        nativeComment({
          canEdit: false,
          id: "native-2",
          surface: CommentSurface.SessionDetail,
          syncAbandoned: true,
          target: { type: CommentTargetType.Session, id: "session-1" },
        })
      ),
    ];

    renderSessionsWorkspace();

    // The badge still renders — the state is true and the reader is told. Only
    // the affordance is withheld, which is what the server would 403 anyway.
    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({
        canRetrySync: false,
        id: "native-2",
        syncAbandoned: true,
      }),
    ]);
  });

  it("tells the author when a retry fails instead of leaving the badge unexplained", async () => {
    // A rejected re-pend changes NOTHING on screen: the badge stays, the list is
    // unchanged. Without this the refusal, the failure and a success are one
    // picture, and the rejection escapes the card unhandled. Same wording the
    // Sessions rail uses, so one failure reads the same on both surfaces.
    mocks.retrySync = vi.fn().mockRejectedValue(new Error("bridge is gone"));
    renderSessionsWorkspace();

    await expect(
      retrySyncHandler()("native-1", {
        id: "session-1",
        type: CommentTargetType.Session,
      })
    ).resolves.toBeUndefined();

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Could not retry this comment. Please try again."
    );
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it("stays quiet when the re-pend landed and only the refetch threw", async () => {
    // The row IS back in the queue, so "could not retry" would send the author
    // to click it a second time on work already done (marisolashgrove review). The
    // rejection still must not escape the card, which floats this promise — so
    // it is swallowed here, and the stale list is what the next refetch fixes.
    mocks.retrySync = vi.fn().mockResolvedValue(undefined);
    mocks.invalidateQueries = vi
      .fn()
      .mockRejectedValue(new Error("refetch is gone"));
    renderSessionsWorkspace();

    await expect(
      retrySyncHandler()("native-1", {
        id: "session-1",
        type: CommentTargetType.Session,
      })
    ).resolves.toBeUndefined();

    expect(mocks.retrySync).toHaveBeenCalledOnce();
    expect(mocks.invalidateQueries).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

function retrySyncHandler() {
  const handler = mocks.workspaceProps?.onRetrySync as
    | ((
        threadId: string,
        target: unknown,
        collectionQuery?: unknown
      ) => Promise<void>)
    | undefined;
  if (!handler) {
    throw new Error("the controller handed the workspace no retry handler");
  }
  return handler;
}
function renderSessionsWorkspace() {
  render(
    <BranchCommentsController
      activeTab={BranchCommentsTab.Sessions}
      detail={{ id: "branch-1" } as BranchPageDetail}
      onClose={vi.fn()}
      onJump={vi.fn()}
      open
      renderedSessionIds={["session-1"]}
      returnFocusRef={{ current: null }}
    />
  );
}

function providerResponse(): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    budget: {
      bodyTruncatedCount: 2,
      maxBodyBytes: 16_384,
      maxComments: 100,
      maxResponseBytes: 524_288,
      omittedComments: 3,
      pageSize: 50,
      providerTruncated: true,
      responseTruncated: true,
    },
    comments: [
      providerComment(),
      providerComment({
        author: {
          avatarUrl: null,
          displayName: null,
          login: "reply-reviewer",
          profileUrl: null,
        },
        id: "reply-1",
        inReplyToId: "root-1",
        kind: BranchPrCommentKind.ReviewReply,
        providerUrl:
          "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r2",
      }),
    ],
    mixedProjection: true,
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    providerProofedAt: "2026-08-10T10:00:00.000Z",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    stale: true,
    state: BranchCommentsState.StaleMixed,
  };
}

function providerComment(
  overrides: Partial<BranchPrComment> = {}
): BranchPrComment {
  return {
    author: {
      avatarUrl: "https://avatars.example/root.png",
      displayName: "Root Reviewer",
      login: "root-reviewer",
      profileUrl: null,
    },
    body: "Provider body",
    bodyTruncated: true,
    createdAt: "2026-08-10T09:00:00.000Z",
    id: "root-1",
    inReplyToId: null,
    kind: BranchPrCommentKind.Review,
    line: 42,
    path: "packages/app/root.tsx",
    providerCommentId: "1",
    providerNodeId: "node-1",
    providerUrl:
      "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r1",
    resolved: false,
    stale: true,
    threadId: "thread-1",
    updatedAt: null,
    ...overrides,
  };
}

function nativeCollectionResult(
  ...comments: readonly TraceComment[]
): BranchCommentCollectionResult {
  return {
    collection: {
      target: { type: CommentTargetType.Branch, id: "branch-1" },
      collectionQuery: { surface: CommentSurface.BranchTimeline },
    },
    error: null,
    read: { comments: [...comments], rejectedCount: 0 },
  };
}

function sessionCollectionResult(
  ...comments: readonly TraceComment[]
): BranchCommentCollectionResult {
  return {
    collection: {
      target: { type: CommentTargetType.Session, id: "session-1" },
      collectionQuery: undefined,
    },
    error: null,
    read: { comments: [...comments], rejectedCount: 0 },
  };
}

function nativeComment(overrides: Partial<TraceComment> = {}): TraceComment {
  return {
    anchor: {
      endOffset: 12,
      row: 3,
      selectedText: "selected",
      sourceText: "the selected line",
      startOffset: 4,
      traceId: "trace-1",
      turnId: "turn-1",
    },
    artifactId: "branch-1",
    authorAvatarUrl: null,
    authorId: "author-1",
    authorName: "Native Author",
    body: "Native body",
    canDelete: false,
    canEdit: true,
    createdAt: "2026-01-15T11:55:00.000Z",
    editedAt: null,
    id: "native-1",
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.BranchTimeline,
    target: { type: CommentTargetType.Branch, id: "branch-1" },
    threadId: "native-thread-1",
    updatedAt: "2026-01-15T11:55:00.000Z",
    ...overrides,
  };
}

function nativeReply(
  overrides: Partial<TraceCommentReply> = {}
): TraceCommentReply {
  return {
    authorAvatarUrl: null,
    authorId: "author-2",
    authorName: "Native Replier",
    body: "Native reply",
    canDelete: false,
    canEdit: true,
    createdAt: "2026-01-15T11:58:00.000Z",
    editedAt: null,
    id: "native-reply-1",
    threadId: "native-thread-1",
    updatedAt: "2026-01-15T11:58:00.000Z",
    ...overrides,
  };
}
