import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TRACE_COMMENT_INCLUDE_THREAD_PARAM,
  type TraceComment,
  TraceCommentKind,
  traceCommentRetrySyncPath,
  traceCommentSyncAbandonedPath,
} from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";
import {
  assertTraceCommentMutationResult,
  assertTraceCommentWriteSupported,
  createHttpTraceCommentsDataSource,
  readTraceCommentCollection,
  TraceCommentCapabilityError,
  TraceCommentCollectionMismatchError,
  type TraceCommentsDataSource,
} from "../trace-comments-data-source";

const BRANCH_TARGET = {
  id: "branch-1",
  type: CommentTargetType.Branch,
} as const;
const TIMELINE_QUERY = {
  surface: CommentSurface.BranchTimeline,
} as const;

describe("trace-comments collection boundary", () => {
  it("filters target and surface mismatches and reports the rejected count", async () => {
    const source = makeSource({
      list: vi.fn().mockResolvedValue([
        makeComment(),
        makeComment({
          id: "wrong-surface",
          surface: CommentSurface.BranchDetail,
        }),
        makeComment({
          id: "wrong-target",
          target: { id: "branch-2", type: CommentTargetType.Branch },
        }),
      ]),
    });

    const result = await readTraceCommentCollection(
      source,
      BRANCH_TARGET,
      TIMELINE_QUERY
    );

    expect(result.comments.map((comment) => comment.id)).toEqual(["comment-1"]);
    expect(result.rejectedCount).toBe(2);
  });

  it("treats a missing surface from an older producer as a mismatch", async () => {
    const legacy = makeComment();
    Reflect.deleteProperty(legacy, "surface");
    const source = makeSource({ list: vi.fn().mockResolvedValue([legacy]) });

    const result = await readTraceCommentCollection(
      source,
      BRANCH_TARGET,
      TIMELINE_QUERY
    );

    expect(result).toEqual({ comments: [], rejectedCount: 1 });
  });

  it("blocks Branch-timeline writes when an older source omits capability", () => {
    const source = makeSource();

    expect(() =>
      assertTraceCommentWriteSupported(source, BRANCH_TARGET, TIMELINE_QUERY)
    ).toThrow(TraceCommentCapabilityError);
    expect(source.create).not.toHaveBeenCalled();
  });

  it("allows declared Branch-timeline writes and rejects a mismatched result", () => {
    const source = makeSource({
      capabilities: { branchTimelineWrites: true },
    });
    assertTraceCommentWriteSupported(source, BRANCH_TARGET, TIMELINE_QUERY);

    expect(() =>
      assertTraceCommentMutationResult(
        makeComment({ surface: CommentSurface.BranchDetail }),
        BRANCH_TARGET,
        TIMELINE_QUERY
      )
    ).toThrow(TraceCommentCollectionMismatchError);
  });

  it("rejects a Branch-timeline mutation response from an older HTTP producer", async () => {
    const legacy = makeComment();
    Reflect.deleteProperty(legacy, "surface");
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn().mockResolvedValue(legacy),
    });

    assertTraceCommentWriteSupported(source, BRANCH_TARGET, TIMELINE_QUERY);
    const result = await source.create(
      BRANCH_TARGET,
      {
        anchor: {
          actor: null,
          endOffset: 4,
          row: 1,
          selectedText: "text",
          sourceText: "text",
          startOffset: 0,
          traceId: "trace-1",
          turnId: "turn-1",
        },
        body: "New comment",
      },
      TIMELINE_QUERY
    );

    expect(() =>
      assertTraceCommentMutationResult(result, BRANCH_TARGET, TIMELINE_QUERY)
    ).toThrow(TraceCommentCollectionMismatchError);
  });
});

describe("trace-comments read cancellation (ISS-5110)", () => {
  it("forwards the caller's signal and read deadline to the HTTP transport", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get,
      patch: vi.fn(),
      post: vi.fn(),
    });
    const controller = new AbortController();

    await readTraceCommentCollection(source, BRANCH_TARGET, TIMELINE_QUERY, {
      signal: controller.signal,
      timeoutMs: 4000,
    });

    expect(get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cache: "no-store",
        signal: controller.signal,
        timeoutMs: 4000,
      })
    );
  });

  it("rejects a hung HTTP read as soon as the caller aborts", async () => {
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get: vi.fn(
        (_path: string, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(makeAbortError()),
              { once: true }
            );
          })
      ),
      patch: vi.fn(),
      post: vi.fn(),
    });
    const controller = new AbortController();

    const read = readTraceCommentCollection(
      source,
      BRANCH_TARGET,
      TIMELINE_QUERY,
      { signal: controller.signal }
    );
    controller.abort();

    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
});

function makeAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function makeSource(
  overrides: Partial<TraceCommentsDataSource> = {}
): TraceCommentsDataSource {
  return {
    scope: "test",
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    reply: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function makeComment(overrides: Partial<TraceComment> = {}): TraceComment {
  return {
    anchor: {
      actor: null,
      endOffset: 4,
      row: 1,
      selectedText: "text",
      sourceText: "text",
      startOffset: 0,
      traceId: "trace-1",
      turnId: "turn-1",
    },
    artifactId: "branch-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "User",
    body: "Comment",
    canDelete: true,
    canEdit: true,
    createdAt: "2026-08-07T12:00:00.000Z",
    editedAt: null,
    id: "comment-1",
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.BranchTimeline,
    target: BRANCH_TARGET,
    threadId: "thread-1",
    updatedAt: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("the HTTP source's recovery door (ISS-10382)", () => {
  const SESSION_TARGET = {
    id: "session-1",
    type: CommentTargetType.Session,
  } as const;

  it("pins the producer path against the route directory that serves it", () => {
    // `traceCommentSyncAbandonedPath` has no caller yet — the desktop producer
    // is ISS-10827 — so nothing else would notice this string drifting away from
    // `apps/api/app/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned/`.
    // Spelled out rather than rebuilt from the helper, for the same reason the
    // retry path below is.
    expect(traceCommentSyncAbandonedPath(SESSION_TARGET, "comment-1")).toBe(
      "/agent-sessions/session-1/trace-comments/comment-1/sync-abandoned"
    );
    expect(traceCommentRetrySyncPath(SESSION_TARGET, "comment-1")).toBe(
      "/agent-sessions/session-1/trace-comments/comment-1/retry-sync"
    );
  });

  it("POSTs the comment's retry-sync path and returns the refreshed list", async () => {
    // The path is spelled out rather than imported from the helper that builds
    // it: a constant shared with the source would follow the source if the route
    // silently moved, and the API route directory is the other half of this
    // contract.
    const post = vi.fn().mockResolvedValue([makeComment()]);
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      post,
    });

    const refreshed = await source.retrySync?.(SESSION_TARGET, "comment-1");

    expect(post).toHaveBeenCalledWith(
      "/agent-sessions/session-1/trace-comments/comment-1/retry-sync",
      {}
    );
    expect(refreshed?.map((comment) => comment.id)).toEqual(["comment-1"]);
  });

  it("normalizes kind on the retry response exactly as list does", async () => {
    // A caller must not get an un-normalized `kind` only on this path; an
    // unknown/absent value degrades to Comment through the same SSOT.
    const unknownKind = makeComment();
    Reflect.set(unknownKind, "kind", "future_kind_this_client_predates");
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn().mockResolvedValue([unknownKind]),
    });

    const refreshed = await source.retrySync?.(SESSION_TARGET, "comment-1");

    expect(refreshed?.[0]?.kind).toBe(TraceCommentKind.Comment);
  });

  it("carries the collection query so a Branch-timeline retry stays on its surface", async () => {
    const post = vi.fn().mockResolvedValue([makeComment()]);
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      post,
    });

    await source.retrySync?.(BRANCH_TARGET, "comment-1", TIMELINE_QUERY);

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining(
        "/branches/branch-1/trace-comments/comment-1/retry-sync"
      ),
      {}
    );
    expect(post.mock.calls[0]?.[0]).toContain(
      `surface=${CommentSurface.BranchTimeline}`
    );
  });
});

/**
 * ISS-11004: an Activity link names one thread, and the read asks for it by
 * name so a thread past the collection cap still reaches the rail.
 */
describe("the HTTP source's addressed-thread read", () => {
  const THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

  function sourceWithGet() {
    const get = vi.fn().mockResolvedValue([]);
    const source = createHttpTraceCommentsDataSource({
      delete: vi.fn(),
      get,
      patch: vi.fn(),
      post: vi.fn(),
    });
    return { get, source };
  }

  it("names the addressed thread on a Session read", async () => {
    const { get, source } = sourceWithGet();

    await source.list(
      { type: CommentTargetType.Session, id: "session-1" },
      undefined,
      { includeThreadId: THREAD_ID, timeoutMs: 1000 }
    );

    expect(get).toHaveBeenCalledWith(
      `/agent-sessions/session-1/trace-comments?${TRACE_COMMENT_INCLUDE_THREAD_PARAM}=${THREAD_ID}`,
      { cache: "no-store", timeoutMs: 1000 }
    );
  });

  it("keeps the Branch collection's surface beside the addressed thread", async () => {
    const { get, source } = sourceWithGet();

    await source.list(BRANCH_TARGET, TIMELINE_QUERY, {
      includeThreadId: THREAD_ID,
    });

    expect(get.mock.calls[0]?.[0]).toBe(
      `/branches/branch-1/trace-comments?surface=${CommentSurface.BranchTimeline}&${TRACE_COMMENT_INCLUDE_THREAD_PARAM}=${THREAD_ID}`
    );
  });
});

describe("ISS-12282 branch Session batch transport", () => {
  it("uses one branch request and preserves anchors, replies and optional fields", async () => {
    const comment = makeComment({ syncAbandoned: true });
    const get = vi.fn().mockResolvedValue([comment]);
    const source = createHttpTraceCommentsDataSource({
      get,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    });
    const controller = new AbortController();
    const result = await source.listBranchSessions?.(BRANCH_TARGET.id, {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "/branches/branch-1/trace-comments?surface=branch_timeline&includeSessions=true",
      { cache: "no-store", signal: controller.signal, timeoutMs: 5000 }
    );
    expect(result).toEqual([comment]);
  });

  it("signals unsupported on an older API's unknown-parameter response", async () => {
    const get = vi.fn().mockRejectedValue({ status: 400 });
    const source = createHttpTraceCommentsDataSource({
      get,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    });
    await expect(
      source.listBranchSessions?.(BRANCH_TARGET.id)
    ).resolves.toBeNull();
  });

  it("does not turn a failed or malformed batch into an empty collection", async () => {
    const get = vi.fn().mockRejectedValue({ status: 503 });
    const source = createHttpTraceCommentsDataSource({
      get,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    });
    await expect(source.listBranchSessions?.(BRANCH_TARGET.id)).rejects.toEqual(
      { status: 503 }
    );
    get.mockResolvedValue([{ target: BRANCH_TARGET }]);
    await expect(
      source.listBranchSessions?.(BRANCH_TARGET.id)
    ).rejects.toThrow();
  });
});
