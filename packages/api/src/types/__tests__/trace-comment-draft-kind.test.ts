import { describe, expect, it } from "vitest";
import {
  TraceCommentKind,
  traceCommentDraftKindSchema,
  traceCommentDraftSchema,
} from "../comment.js";

const anchor = {
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "quote",
  sourceText: "a quote row",
  startOffset: 2,
  endOffset: 7,
};

describe("traceCommentDraftKindSchema degrades unknown kinds (FEA-4171)", () => {
  it("passes a recognized parsing_bug through unchanged", () => {
    expect(traceCommentDraftKindSchema.parse(TraceCommentKind.ParsingBug)).toBe(
      TraceCommentKind.ParsingBug
    );
  });

  it("passes a recognized comment through unchanged", () => {
    expect(traceCommentDraftKindSchema.parse(TraceCommentKind.Comment)).toBe(
      TraceCommentKind.Comment
    );
  });

  it("degrades an unknown future kind to Comment instead of rejecting", () => {
    // A newer client sends a kind this API predates. It must NOT be rejected —
    // that would 400 the whole POST on a classification-only version skew.
    const result = traceCommentDraftKindSchema.safeParse("triage_needed");
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe(TraceCommentKind.Comment);
  });

  it("degrades a non-string value to Comment", () => {
    expect(traceCommentDraftKindSchema.parse(42)).toBe(
      TraceCommentKind.Comment
    );
  });
});

describe("traceCommentDraftSchema tolerates a version-skewed kind (FEA-4171)", () => {
  it("accepts the draft and degrades an unknown kind, never rejecting creation", () => {
    const parsed = traceCommentDraftSchema.parse({
      anchor,
      body: "The parser dropped a tool call.",
      kind: "some_future_kind",
    });
    expect(parsed.kind).toBe(TraceCommentKind.Comment);
  });

  it("preserves a known parsing_bug classification", () => {
    const parsed = traceCommentDraftSchema.parse({
      anchor,
      body: "The tool output was parsed as raw text; expected JSON.",
      kind: TraceCommentKind.ParsingBug,
    });
    expect(parsed.kind).toBe(TraceCommentKind.ParsingBug);
  });

  it("leaves an absent kind absent (defaulted downstream)", () => {
    const parsed = traceCommentDraftSchema.parse({ anchor, body: "plain" });
    expect(parsed.kind).toBeUndefined();
  });
});
