import {
  normalizeTraceCommentKind,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";

// parseTraceCommentMetadata normalizes a `Prisma.JsonNull` sentinel to null; the
// sentinel identity is all that matters, so a lightweight stub keeps the test
// hermetic (no generated client / DB import).
vi.mock("@repo/database", () => ({ Prisma: { JsonNull: Symbol("JsonNull") } }));

import { parseTraceCommentMetadata } from "./trace-comment-metadata";

const baseMetadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: TraceCommentTargetType.Session,
  surface: TraceCommentSurface.SessionDetail,
  anchor: {
    traceId: "trace:session-1:0",
    turnId: "turn:session-1:0",
    row: 0,
    selectedText: "quote target",
    sourceText: "A trace quote target row",
    startOffset: 8,
    endOffset: 20,
    sessionId: "session-1",
    actor: { name: "codex", human: null },
  },
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
      targetType: TraceCommentTargetType.Branch,
      surface: TraceCommentSurface.BranchTimeline,
    });

    expect(parsed?.surface).toBe(TraceCommentSurface.BranchTimeline);
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
