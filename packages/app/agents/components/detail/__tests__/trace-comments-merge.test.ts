import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markCreatedIds,
  mergeTraceCommentList,
  mergeTraceComments,
  pruneTombstonedComments,
  reconcileCreateMarkers,
  reconcileDeleteTombstones,
  removeTraceCommentOrReply,
  TRACE_COMMENT_CREATE_MARKER_TTL_MS,
} from "../trace-comments-merge";
import {
  makeTraceComment,
  makeTraceCommentReply,
} from "./trace-comments-test-helpers";

/**
 * Direct coverage for the merge algebra extracted from `use-trace-comments.ts`
 * (ISS-5022). It arbitrates the constant race between a poll that was already in
 * flight and a local mutation, so its rules are asserted here on their own rather
 * than only incidentally through the hook.
 *
 * Tombstone and create-marker expiry is clock-boundary behavior, so the clock is
 * pinned rather than read live: on a paused or slow worker a wall-clock offset
 * could drift across the boundary between constructing the fixture and asserting
 * on it.
 */

const FIXED_NOW = new Date("2026-08-04T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pruneTombstonedComments", () => {
  it("drops a comment whose delete tombstone is still active", () => {
    const tombstones = new Map([["comment-1", Date.now() + 5000]]);
    const survivors = pruneTombstonedComments(
      [makeTraceComment("deleted", { id: "comment-1" })],
      tombstones
    );
    expect(survivors).toHaveLength(0);
  });

  it("drops a tombstoned REPLY without dropping its parent", () => {
    const comment = makeTraceComment("parent", {
      replies: [makeTraceCommentReply("reply-1", "gone")],
    });
    const tombstones = new Map([["reply-1", Date.now() + 5000]]);
    const survivors = pruneTombstonedComments([comment], tombstones);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.replies).toHaveLength(0);
  });

  it("lets a row through once its tombstone has expired", () => {
    const tombstones = new Map([["comment-1", Date.now() - 1]]);
    const survivors = pruneTombstonedComments(
      [makeTraceComment("back", { id: "comment-1" })],
      tombstones
    );
    expect(survivors).toHaveLength(1);
  });
});

describe("reconcileDeleteTombstones", () => {
  it("clears a tombstone once the server list no longer returns the id", () => {
    const tombstones = new Map([["comment-1", Date.now() + 5000]]);
    reconcileDeleteTombstones([], tombstones);
    expect(tombstones.has("comment-1")).toBe(false);
  });

  it("keeps a tombstone while the server still returns the id", () => {
    const tombstones = new Map([["comment-1", Date.now() + 5000]]);
    reconcileDeleteTombstones(
      [makeTraceComment("still here", { id: "comment-1" })],
      tombstones
    );
    expect(tombstones.has("comment-1")).toBe(true);
  });
});

describe("mergeTraceCommentList", () => {
  it("keeps the fresher version of a comment present in both lists", () => {
    const cached = makeTraceComment("stale body", {
      createdAt: "2026-08-04T10:00:00.000Z",
    });
    const incoming = makeTraceComment("fresh body", {
      createdAt: "2026-08-04T11:00:00.000Z",
    });
    const merged = mergeTraceCommentList([cached], [incoming]);
    expect(merged[0]?.body).toBe("fresh body");
  });

  it("drops a cached comment the server no longer returns", () => {
    const cached = makeTraceComment("removed elsewhere");
    expect(mergeTraceCommentList([cached], [])).toHaveLength(0);
  });

  it("preserves a locally-created comment a raced poll has not seen yet", () => {
    // The poll's list predates the create; without the marker the just-created
    // comment would flicker away until the next poll.
    const created = makeTraceComment("just created", { id: "comment-new" });
    const markers = new Map([
      ["comment-new", Date.now() + TRACE_COMMENT_CREATE_MARKER_TTL_MS],
    ]);
    const merged = mergeTraceCommentList([created], [], markers);
    expect(merged.map((comment) => comment.id)).toContain("comment-new");
  });

  it("stops preserving a locally-created comment once its marker expires", () => {
    const created = makeTraceComment("stale create", { id: "comment-new" });
    const markers = new Map([["comment-new", Date.now() - 1]]);
    expect(mergeTraceCommentList([created], [], markers)).toHaveLength(0);
  });

  it("re-attaches a locally-created REPLY that a raced poll omitted", () => {
    // A reply write does not bump the root's updatedAt server-side, so the
    // pre-reply thread ties on freshness and would otherwise win and drop it.
    const cached = makeTraceComment("thread", {
      replies: [makeTraceCommentReply("reply-new", "just replied")],
    });
    const incoming = makeTraceComment("thread");
    const markers = new Map([
      ["reply-new", Date.now() + TRACE_COMMENT_CREATE_MARKER_TTL_MS],
    ]);
    const merged = mergeTraceCommentList([cached], [incoming], markers);
    expect(merged[0]?.replies?.map((reply) => reply.id)).toContain("reply-new");
  });

  it("leaves a reply the fresher version legitimately dropped dropped", () => {
    const cached = makeTraceComment("thread", {
      replies: [makeTraceCommentReply("reply-1", "deleted elsewhere")],
    });
    const incoming = makeTraceComment("thread", {
      createdAt: "2026-08-04T12:00:00.000Z",
    });
    const merged = mergeTraceCommentList([cached], [incoming]);
    expect(merged[0]?.replies).toHaveLength(0);
  });
});

describe("create markers", () => {
  it("clears a marker once the server list contains the id", () => {
    const markers = new Map<string, number>();
    markCreatedIds(markers, ["comment-1"]);
    reconcileCreateMarkers(
      [makeTraceComment("now on server", { id: "comment-1" })],
      markers
    );
    expect(markers.has("comment-1")).toBe(false);
  });

  it("keeps a marker while the server list still omits the id", () => {
    const markers = new Map<string, number>();
    markCreatedIds(markers, ["comment-1"]);
    reconcileCreateMarkers([], markers);
    expect(markers.has("comment-1")).toBe(true);
  });
});

describe("mergeTraceComments", () => {
  it("adds a new comment without duplicating an existing one", () => {
    const existing = makeTraceComment("first", { id: "comment-1" });
    const incoming = makeTraceComment("second", { id: "comment-2" });
    const merged = mergeTraceComments([existing], incoming);
    expect(merged.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
  });

  it("replaces an existing comment rather than appending a duplicate", () => {
    const existing = makeTraceComment("before", { id: "comment-1" });
    const incoming = makeTraceComment("after", {
      id: "comment-1",
      createdAt: "2026-08-04T12:00:00.000Z",
    });
    const merged = mergeTraceComments([existing], incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toBe("after");
  });
});

describe("removeTraceCommentOrReply", () => {
  it("removes a root comment", () => {
    const comment = makeTraceComment("root", { id: "comment-1" });
    expect(removeTraceCommentOrReply([comment], "comment-1")).toHaveLength(0);
  });

  it("removes a reply without removing its parent", () => {
    const comment = makeTraceComment("root", {
      replies: [makeTraceCommentReply("reply-1", "gone")],
    });
    const remaining = removeTraceCommentOrReply([comment], "reply-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.replies).toHaveLength(0);
  });
});
