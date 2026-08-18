import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
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
  type: TraceCommentTargetType.Branch,
} as const;
const TIMELINE_QUERY = {
  surface: TraceCommentSurface.BranchTimeline,
} as const;

describe("trace-comments collection boundary", () => {
  it("filters target and surface mismatches and reports the rejected count", async () => {
    const source = makeSource({
      list: vi.fn().mockResolvedValue([
        makeComment(),
        makeComment({
          id: "wrong-surface",
          surface: TraceCommentSurface.BranchDetail,
        }),
        makeComment({
          id: "wrong-target",
          target: { id: "branch-2", type: TraceCommentTargetType.Branch },
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
        makeComment({ surface: TraceCommentSurface.BranchDetail }),
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
    surface: TraceCommentSurface.BranchTimeline,
    target: BRANCH_TARGET,
    threadId: "thread-1",
    updatedAt: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}
