import type {
  TraceComment,
  TraceCommentReply,
  TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { toast } from "@repo/design-system/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiAdapterProvider } from "../../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../../shared/auth/static-auth-adapter";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import { TraceCommentsDataSourceProvider } from "../../../data-source/trace-comments-provider";
import {
  TRACE_COMMENTS_REFETCH_INTERVAL_MS,
  traceCommentsLiveQueryOptions,
  useTraceComments,
} from "../use-trace-comments";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("trace comments live query options", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("polls cross-surface comments without requiring a page refresh", () => {
    expect(traceCommentsLiveQueryOptions).toMatchObject({
      staleTime: 0,
      refetchOnReconnect: "always",
      refetchOnWindowFocus: "always",
    });
  });

  it("uses a short shared interval for the lightweight trace-comments endpoint", () => {
    expect(TRACE_COMMENTS_REFETCH_INTERVAL_MS).toBe(2000);
  });

  it("refetches while mounted so another surface can appear without a refresh", async () => {
    vi.useFakeTimers();
    const initialComments: TraceComment[] = [];
    const syncedComment = makeTraceComment("Comment from another surface");
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce(initialComments)
      .mockResolvedValueOnce([syncedComment]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]?.body).toBe(syncedComment.body);
  });

  it("normalizes legacy trace comments that omit replies", async () => {
    const { replies: _replies, ...legacyComment } = makeTraceComment(
      "Legacy comment without replies"
    );
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list: vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValue([legacyComment]),
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0]?.replies).toEqual([]);
  });

  it("submits replies through the data source and merges the returned thread", async () => {
    const updatedComment = makeTraceComment("Parent comment", {
      replies: [makeTraceCommentReply("reply-1", "Reply text")],
    });
    const reply = vi
      .fn<TraceCommentsDataSource["reply"]>()
      .mockResolvedValue(updatedComment);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list: vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([makeTraceComment("Parent comment")])
        .mockResolvedValue([updatedComment]),
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply,
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => {
      result.current.replyToTraceComment("comment-1", { body: "Reply text" });
    });

    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        { type: "session", id: "session-1" },
        "comment-1",
        { body: "Reply text" }
      )
    );
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(1)
    );
    expect(result.current.comments[0]?.replies[0]?.body).toBe("Reply text");
  });

  it("merges a second comment when the API client revives createdAt as Date objects", async () => {
    const existingComment = makeTraceComment("First comment", {
      createdAt: new Date("2026-06-26T15:00:00.000Z"),
      id: "comment-1",
    });
    const createdComment = makeTraceComment("Second comment", {
      createdAt: new Date("2026-06-26T15:01:00.000Z"),
      id: "comment-2",
    });
    const create = vi
      .fn<TraceCommentsDataSource["create"]>()
      .mockResolvedValue(createdComment);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list: vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValue([existingComment]),
      create,
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => {
      result.current.submitTraceComment({
        anchor: createdComment.anchor,
        body: createdComment.body,
      });
    });

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(result.current.comments).toHaveLength(2));
    expect(result.current.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(result.current.activeAnchor).toBe(createdComment.anchor);
  });

  it("clears pending selection state and notifies the user when create fails", async () => {
    const create = vi
      .fn<TraceCommentsDataSource["create"]>()
      .mockRejectedValue(new Error("network unavailable"));
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list: vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]),
      create,
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };
    const draft = makeTraceComment("Unsaved comment");

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(result.current.comments).toHaveLength(0));

    act(() => {
      result.current.submitTraceComment({
        anchor: draft.anchor,
        body: draft.body,
      });
    });

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(result.current.activeAnchor).toBeNull();
    expect(result.current.comments).toHaveLength(0);
  });

  it("removes deleted nested replies from cached trace comments", async () => {
    const initialComment = makeTraceComment("Parent comment", {
      replies: [makeTraceCommentReply("reply-1", "Reply text")],
    });
    const afterDelete = makeTraceComment("Parent comment");
    const remove = vi
      .fn<TraceCommentsDataSource["delete"]>()
      .mockResolvedValue({ deleted: true });
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list: vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([initialComment])
        .mockResolvedValue([afterDelete]),
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: remove,
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(1)
    );

    act(() => {
      result.current.deleteTraceComment("reply-1");
    });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith(
        { type: "session", id: "session-1" },
        "reply-1"
      )
    );
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(0)
    );
  });
});

function createWrapper(dataSource: TraceCommentsDataSource) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    const apiAdapter = { resolveApiOrigin: () => "http://api.test" };
    return createElement(
      AuthAdapterProvider,
      { adapter: createStaticAuthAdapter() },
      createElement(
        ApiAdapterProvider,
        { adapter: apiAdapter },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            TraceCommentsDataSourceProvider,
            { dataSource },
            children
          )
        )
      )
    );
  };
}

function makeTraceComment(
  body: string,
  options: {
    anchor?: Partial<TraceTextAnchor>;
    createdAt?: Date | string;
    id?: string;
    replies?: TraceCommentReply[];
  } = {}
): TraceComment {
  const createdAt = options.createdAt ?? "2026-06-26T15:00:00.000Z";
  return {
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected text",
      sourceText: "source selected text",
      startOffset: 7,
      endOffset: 20,
      sessionId: "session-1",
      actor: null,
      ...options.anchor,
    },
    artifactId: "session-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body,
    createdAt: createdAt as string,
    editedAt: null,
    id: options.id ?? "comment-1",
    status: "OPEN",
    surface: "session_detail",
    target: { type: "session", id: "session-1" },
    threadId: "thread-1",
    updatedAt: createdAt as string,
    canEdit: true,
    canDelete: true,
    replies: options.replies ?? [],
  };
}

function makeTraceCommentReply(id: string, body: string): TraceCommentReply {
  return {
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body,
    canDelete: true,
    canEdit: true,
    createdAt: "2026-06-26T15:01:00.000Z",
    editedAt: null,
    id,
    threadId: "thread-1",
    updatedAt: "2026-06-26T15:01:00.000Z",
  };
}
