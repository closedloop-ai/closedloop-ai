import { describe, expect, it } from "vitest";
import {
  TRACE_COMMENT_MENTIONS_MAX,
  traceCommentDraftSchema,
  traceCommentMentionsSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
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

describe("traceCommentMentionsSchema (FEA-3490)", () => {
  it("de-duplicates while preserving first-seen order", () => {
    const parsed = traceCommentMentionsSchema.parse(["a", "b", "a"]);
    expect(parsed).toEqual(["a", "b"]);
  });

  it("rejects a list longer than the cap", () => {
    const tooMany = Array.from(
      { length: TRACE_COMMENT_MENTIONS_MAX + 1 },
      (_value, index) => `u-${index}`
    );
    expect(traceCommentMentionsSchema.safeParse(tooMany).success).toBe(false);
  });

  it("rejects empty-string ids", () => {
    expect(traceCommentMentionsSchema.safeParse([""]).success).toBe(false);
  });
});

describe("trace comment draft/reply/update schemas accept optional mentions", () => {
  it("parses a draft with mentions", () => {
    const parsed = traceCommentDraftSchema.parse({
      anchor,
      body: "cc @you",
      mentions: ["u-1", "u-1"],
    });
    expect(parsed).toMatchObject({ body: "cc @you", mentions: ["u-1"] });
  });

  it("parses a draft without mentions (backward compatible)", () => {
    const parsed = traceCommentDraftSchema.parse({ anchor, body: "note" });
    expect(parsed.mentions).toBeUndefined();
  });

  it("parses reply and update payloads with mentions", () => {
    expect(
      traceCommentReplyDraftSchema.parse({ body: "r", mentions: ["u-2"] })
    ).toMatchObject({ mentions: ["u-2"] });
    expect(
      traceCommentUpdateSchema.parse({ body: "e", mentions: ["u-3"] })
    ).toMatchObject({ mentions: ["u-3"] });
  });
});
