import type { TraceComment } from "@repo/api/src/types/comment";
import { toast } from "@repo/design-system/components/ui/sonner";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNS_AUTH_REJECTION_META_KEY } from "../../../../shared/query/auth-rejection-store";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import { TRACE_COMMENTS_REFETCH_INTERVAL_MS } from "../trace-comments-poll-cadence";
import {
  traceCommentKeys,
  traceCommentsLiveQueryOptions,
  useTraceComments,
} from "../use-trace-comments";
import {
  createWrapper,
  makeTraceComment,
  makeTraceCommentReply,
} from "./trace-comments-test-helpers";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("trace comments live query options", () => {
  it("keeps Branch detail and timeline collections in separate cache keys", () => {
    const target = { type: "branch", id: "branch-1" } as const;
    const detailKey = traceCommentKeys.target("test", target);
    const timelineKey = traceCommentKeys.target("test", target, {
      surface: "branch_timeline",
    });

    expect(detailKey).toContain("branch_detail");
    expect(timelineKey).toContain("branch_timeline");
    expect(detailKey).not.toEqual(timelineKey);
  });

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

  it("opts the target-scoped comments read out of the shared auth-rejection boundary (FEA-3940)", () => {
    // A 401/403 on `/…/trace-comments` is a per-resource authorization state the
    // detail surface owns inline; it must NOT trip the web shell's global
    // WorkspaceAuthGuard and blank the whole session/branch detail page.
    expect(traceCommentsLiveQueryOptions.meta).toEqual({
      [OWNS_AUTH_REJECTION_META_KEY]: true,
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

  it("keeps a fresher local edit when a staler poll resolves concurrently (AC-9)", async () => {
    vi.useFakeTimers();
    const original = makeTraceComment("Original body", {
      id: "comment-1",
      createdAt: "2026-06-26T15:00:00.000Z",
    });
    const editedComment: TraceComment = {
      ...original,
      body: "Edited body",
      updatedAt: "2026-06-26T15:05:00.000Z",
    };
    // The poll that was already in flight when the edit landed still returns the
    // pre-edit row (staler updatedAt). It must not clobber the fresher edit.
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([original])
      .mockResolvedValue([original]);
    const update = vi
      .fn<TraceCommentsDataSource["update"]>()
      .mockResolvedValue(editedComment);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update,
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
      result.current.updateTraceComment("comment-1", { body: "Edited body" });
    });
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.body).toBe("Edited body")
    );

    // A concurrent poll returning the staler row must not overwrite the edit.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]?.body).toBe("Edited body");
  });

  it("does not resurrect a deleted comment when a poll races the delete (AC-9)", async () => {
    vi.useFakeTimers();
    const comment = makeTraceComment("Doomed comment", { id: "comment-1" });
    // First poll: still present. After the server reflects the delete, empty.
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([comment])
      .mockResolvedValueOnce([comment])
      .mockResolvedValue([]);
    const remove = vi
      .fn<TraceCommentsDataSource["delete"]>()
      .mockResolvedValue({ deleted: true });
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
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

    await vi.waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => {
      result.current.deleteTraceComment("comment-1");
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(result.current.comments).toHaveLength(0));

    // Poll that raced the delete still returns the row: tombstone suppresses it.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments).toHaveLength(0);

    // Once the server reflects the delete the steady state stays empty.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(result.current.comments).toHaveLength(0);
  });

  it("reflects a server-side reply deletion instead of resurrecting the reply (AC-9)", async () => {
    vi.useFakeTimers();
    const withReply = makeTraceComment("Parent comment", {
      id: "comment-1",
      createdAt: "2026-06-26T15:00:00.000Z",
      replies: [makeTraceCommentReply("reply-1", "Reply text")],
    });
    // A later poll returns the parent with a bumped updatedAt and no replies:
    // another surface deleted the reply. The merge must not union the stale
    // cached reply back in.
    const afterServerDelete: TraceComment = {
      ...withReply,
      updatedAt: "2026-06-26T15:10:00.000Z",
      replies: [],
    };
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([withReply])
      .mockResolvedValue([afterServerDelete]);
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

    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(1)
    );

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(0)
    );
  });

  it("keeps a just-created comment when an older in-flight poll omits it (AC-9)", async () => {
    vi.useFakeTimers();
    const createdComment = makeTraceComment("Freshly created", {
      id: "comment-new",
      createdAt: "2026-06-26T15:05:00.000Z",
    });
    // The poll that was already in flight when the create landed still returns
    // the pre-create list (empty). It must not drop the just-created comment.
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([createdComment]);
    const create = vi
      .fn<TraceCommentsDataSource["create"]>()
      .mockResolvedValue(createdComment);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
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

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.submitTraceComment({
        anchor: createdComment.anchor,
        body: createdComment.body,
      });
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(result.current.comments).toHaveLength(1));

    // Poll that raced the create returns the pre-create empty list: the marker
    // preserves the just-created comment instead of dropping it.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]?.id).toBe("comment-new");

    // Once the server list reflects the create the steady state keeps it.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]?.id).toBe("comment-new");
  });

  it("keeps a just-created reply when an older in-flight poll omits it, since a reply write does not bump the root updatedAt (AC-9)", async () => {
    vi.useFakeTimers();
    const parent = makeTraceComment("Parent comment", {
      id: "comment-1",
      createdAt: "2026-06-26T15:00:00.000Z",
    });
    // The server maps TraceComment.updatedAt from the root comment, and a reply
    // write leaves the root untouched — so the reply response and the racing
    // poll carry the SAME root updatedAt. Without reply-aware freshness + a
    // create marker, the tie would let the pre-reply poll win and drop the reply.
    const withReply: TraceComment = {
      ...parent,
      replies: [makeTraceCommentReply("reply-1", "Reply text")],
    };
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([parent])
      .mockResolvedValueOnce([parent])
      .mockResolvedValue([withReply]);
    const reply = vi
      .fn<TraceCommentsDataSource["reply"]>()
      .mockResolvedValue(withReply);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
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

    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(0)
    );

    act(() => {
      result.current.replyToTraceComment("comment-1", { body: "Reply text" });
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.replies).toHaveLength(1)
    );

    // Poll that raced the reply create still returns the pre-reply thread (same
    // root updatedAt). The just-created reply must survive the merge.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments[0]?.replies).toHaveLength(1);
    expect(result.current.comments[0]?.replies[0]?.id).toBe("reply-1");

    // Once the server list reflects the reply the steady state keeps it.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(result.current.comments[0]?.replies).toHaveLength(1);
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

describe("hasLoadedComments settled-empty latch (FEA-4233)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("only reports loaded once this mount's own read has settled", async () => {
    const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
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

    // Before the discovery read settles, the rail cannot know the count.
    expect(result.current.hasLoadedComments).toBe(false);
    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    // Settled empty: no comments, but the read completed for this mount.
    expect(result.current.comments).toHaveLength(0);
  });

  it("stays latched loaded across a later poll failure", async () => {
    vi.useFakeTimers();
    // First read settles empty; the next interval poll rejects. A transient
    // refetch error must not un-settle a rail that already loaded (else it would
    // flicker back to the loading handle and re-open on recovery).
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("network blip"));
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

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));

    // The interval poll fires and rejects; the latch holds.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.hasLoadedComments).toBe(true);
  });
});
