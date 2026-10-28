import { describe, expect, it } from "vitest";
import {
  TRACE_COMMENT_CREATE_MARKER_TTL_MS,
  TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS,
} from "../trace-comments-merge";
import { TRACE_COMMENTS_READ_TIMEOUT_MS } from "../trace-comments-poll-cadence";

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
});
