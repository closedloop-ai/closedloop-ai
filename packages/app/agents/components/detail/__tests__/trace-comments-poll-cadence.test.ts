import type {
  TraceComment,
  TraceCommentReply,
} from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import {
  TRACE_COMMENT_CREATE_MARKER_TTL_MS,
  TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS,
} from "../trace-comments-merge";
import {
  resolveTraceCommentsPollDelayMs,
  TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS,
  TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF,
  TRACE_COMMENTS_READ_TIMEOUT_MS,
  TRACE_COMMENTS_REFETCH_INTERVAL_MS,
  traceCommentListSignature,
} from "../trace-comments-poll-cadence";
import {
  makeTraceComment,
  makeTraceCommentReply,
} from "./trace-comments-test-helpers";

describe("resolveTraceCommentsPollDelayMs", () => {
  it("uses the base interval for a live thread", () => {
    expect(resolveTraceCommentsPollDelayMs({ idleStreak: 0 })).toBe(
      TRACE_COMMENTS_REFETCH_INTERVAL_MS
    );
  });

  it("backs off once the thread has been unchanged for the idle threshold", () => {
    expect(
      resolveTraceCommentsPollDelayMs({
        idleStreak: TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF,
      })
    ).toBe(TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS);
  });

  it("holds the base interval right up to the idle threshold", () => {
    expect(
      resolveTraceCommentsPollDelayMs({
        idleStreak: TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF - 1,
      })
    ).toBe(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
  });

  it("never widens past the single ceiling however long the thread stays idle", () => {
    expect(
      resolveTraceCommentsPollDelayMs({
        idleStreak: TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF * 10,
      })
    ).toBe(TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS);
  });
});

describe("traceCommentListSignature", () => {
  it("is stable across two reads of an unchanged list", () => {
    const list = [makeComment()];
    expect(traceCommentListSignature(list)).toBe(
      traceCommentListSignature([makeComment()])
    );
  });

  it("changes when a comment is added", () => {
    const before = traceCommentListSignature([makeComment()]);
    const after = traceCommentListSignature([
      makeComment(),
      makeComment({ id: "cmt-2" }),
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a comment is removed", () => {
    const before = traceCommentListSignature([
      makeComment(),
      makeComment({ id: "cmt-2" }),
    ]);
    expect(traceCommentListSignature([makeComment()])).not.toBe(before);
  });

  it("changes when a comment is edited (updatedAt moves)", () => {
    const before = traceCommentListSignature([makeComment()]);
    const after = traceCommentListSignature([
      makeComment({ updatedAt: "2026-08-04T10:05:00.000Z" }),
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a reply is added, even though a reply does not bump the root updatedAt", () => {
    // A reply is a sibling row server-side: the root comment's `updatedAt` is
    // untouched. A root-only signature would read this as "no change" and let the
    // cadence back off through an active conversation.
    const before = traceCommentListSignature([makeComment()]);
    const after = traceCommentListSignature([
      makeComment({ replies: [makeReply()] }),
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when an existing reply is edited", () => {
    const before = traceCommentListSignature([
      makeComment({ replies: [makeReply()] }),
    ]);
    const after = traceCommentListSignature([
      makeComment({
        replies: [makeReply({ updatedAt: "2026-08-04T11:00:00.000Z" })],
      }),
    ]);
    expect(after).not.toBe(before);
  });

  it("falls back to createdAt when updatedAt is absent, on roots and replies", () => {
    // Mirrors `traceCommentThreadFreshnessMs`. Reading bare `updatedAt` would
    // collapse both of these to `undefined` and miss the change entirely.
    const before = traceCommentListSignature([
      makeComment({
        updatedAt: undefined,
        createdAt: "2026-08-04T10:00:00.000Z",
      }),
    ]);
    const after = traceCommentListSignature([
      makeComment({
        updatedAt: undefined,
        createdAt: "2026-08-04T10:30:00.000Z",
      }),
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a thread is resolved, which does not move any comment timestamp", () => {
    // The API maps `status`/`resolvedAt` off the THREAD row while `updatedAt`
    // comes off the root COMMENT row, so a resolve from another surface would
    // otherwise read as "no change" and let the cadence back off through it.
    const before = traceCommentListSignature([makeComment()]);
    const after = traceCommentListSignature([
      makeComment({
        status: "RESOLVED",
        resolvedAt: "2026-08-04T12:00:00.000Z",
      }),
    ]);
    expect(after).not.toBe(before);
  });

  it("returns a stable value for an empty list", () => {
    expect(traceCommentListSignature([])).toBe(traceCommentListSignature([]));
  });
});

describe("TRACE_COMMENTS_READ_TIMEOUT_MS (ISS-5110)", () => {
  it("expires a read before its own create marker and delete tombstone do", () => {
    // The bound exists so a read cannot land after the markers protecting a
    // local mutation from it have expired — a late answer could then resurrect a
    // just-deleted comment or drop a just-created one.
    expect(TRACE_COMMENTS_READ_TIMEOUT_MS).toBeLessThan(
      TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS
    );
    expect(TRACE_COMMENTS_READ_TIMEOUT_MS).toBeLessThan(
      TRACE_COMMENT_CREATE_MARKER_TTL_MS
    );
  });

  it("leaves a slow but useful read more than one poll cycle to answer", () => {
    expect(TRACE_COMMENTS_READ_TIMEOUT_MS).toBeGreaterThan(
      TRACE_COMMENTS_REFETCH_INTERVAL_MS
    );
  });
});

function makeComment(overrides?: Partial<TraceComment>): TraceComment {
  return { ...makeTraceComment("hello"), ...overrides };
}

function makeReply(overrides?: Partial<TraceCommentReply>): TraceCommentReply {
  return { ...makeTraceCommentReply("rep-1", "reply"), ...overrides };
}
