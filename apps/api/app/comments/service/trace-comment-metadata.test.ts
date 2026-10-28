import {
  CommentSurface,
  CommentTargetType,
  normalizeTraceCommentKind,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";

// parseTraceCommentMetadata normalizes a `Prisma.JsonNull` sentinel to null; the
// sentinel identity is all that matters, so a lightweight stub keeps the test
// hermetic (no generated client / DB import).
vi.mock("@repo/database", () => ({ Prisma: { JsonNull: Symbol("JsonNull") } }));

import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { parseTraceCommentMetadata } from "./trace-comment-metadata";
import { traceCommentSyncAbandonedField } from "./trace-comment-sync-state";

const baseMetadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: CommentTargetType.Session,
  surface: CommentSurface.SessionDetail,
};

describe("parseTraceCommentMetadata — commentKind read tolerance (FEA-4281)", () => {
  it("parses metadata whose commentKind is an unknown/future value (thread stays valid)", () => {
    // A strict validator would fail the whole parse here and drop the comment.
    const parsed = parseTraceCommentMetadata({
      ...baseMetadata,
      commentKind: "future_kind_this_server_predates",
    });
    expect(parsed).not.toBeNull();
    // The classification degrades to Comment via the SSOT (never surfaces the
    // unknown value as a spurious parsing-bug candidate).
    expect(normalizeTraceCommentKind(parsed?.commentKind)).toBe(
      TraceCommentKind.Comment
    );
  });

  it("parses metadata with an absent commentKind (older row) → Comment", () => {
    const parsed = parseTraceCommentMetadata(baseMetadata);
    expect(parsed).not.toBeNull();
    expect(normalizeTraceCommentKind(parsed?.commentKind)).toBe(
      TraceCommentKind.Comment
    );
  });

  it("passes a known ParsingBug classification through", () => {
    const parsed = parseTraceCommentMetadata({
      ...baseMetadata,
      commentKind: TraceCommentKind.ParsingBug,
    });
    expect(parsed).not.toBeNull();
    expect(normalizeTraceCommentKind(parsed?.commentKind)).toBe(
      TraceCommentKind.ParsingBug
    );
  });

  it("parses persisted Branch timeline metadata without changing older surfaces", () => {
    const parsed = parseTraceCommentMetadata({
      ...baseMetadata,
      targetType: CommentTargetType.Branch,
      surface: CommentSurface.BranchTimeline,
    });

    expect(parsed?.surface).toBe(CommentSurface.BranchTimeline);
  });

  it("rejects a non-trace-comment thread (wrong discriminator)", () => {
    expect(parseTraceCommentMetadata({ kind: "document_comment" })).toBeNull();
  });

  it("rejects a malformed metadata blob", () => {
    expect(parseTraceCommentMetadata("nope")).toBeNull();
    expect(parseTraceCommentMetadata(null)).toBeNull();
    // Missing required fields (only the discriminator) still fails.
    expect(parseTraceCommentMetadata({ kind: "trace_comment" })).toBeNull();
  });
});

describe("traceCommentSyncAbandonedField reads CommentSyncState (ISS-11212)", () => {
  it("reports a dead letter stored in the sync-state row", () => {
    expect(
      traceCommentSyncAbandonedField([{ state: CommentSyncStatus.Abandoned }])
    ).toEqual({ syncAbandoned: true });
  });

  it("treats absence as not-abandoned and emits no key at all", () => {
    // Absence must never read as "unknown" — `packages/api/src/types/comment.ts`
    // forbids that third reading, and the rail keys its badge on `=== true`.
    expect(traceCommentSyncAbandonedField([])).toEqual({});
    expect("syncAbandoned" in traceCommentSyncAbandonedField([])).toBe(false);
  });

  it("emits no key for a SYNCED row", () => {
    expect(
      traceCommentSyncAbandonedField([{ state: CommentSyncStatus.Synced }])
    ).toEqual({});
  });
});
