/**
 * ISS-8734: the `offset` ceiling. The assertion is the Zod issue PATH, not
 * `success === false` — a schema that rejected for any other reason would
 * satisfy the weaker shape (ISS-7545).
 */
import { TRACE_COMMENT_LIST_MAX_OFFSET } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import { traceCommentListQuerySchema } from "./validators";

describe("traceCommentListQuerySchema offset and cursor ceiling (ISS-8734)", () => {
  it("rejects an offset past the ceiling at the offset key", () => {
    const result = traceCommentListQuerySchema.safeParse({
      offset: String(TRACE_COMMENT_LIST_MAX_OFFSET + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["offset"],
    ]);
  });

  it("accepts an offset exactly on the ceiling", () => {
    const result = traceCommentListQuerySchema.safeParse({
      offset: String(TRACE_COMMENT_LIST_MAX_OFFSET),
    });

    expect(result.success).toBe(true);
    expect(result.data?.offset).toBe(TRACE_COMMENT_LIST_MAX_OFFSET);
  });

  it("accepts an offset of 0", () => {
    const result = traceCommentListQuerySchema.safeParse({ offset: "0" });

    expect(result.success).toBe(true);
    expect(result.data?.offset).toBe(0);
  });

  it("rejects a cursor past the ceiling at the cursor key", () => {
    const result = traceCommentListQuerySchema.safeParse({
      cursor: String(TRACE_COMMENT_LIST_MAX_OFFSET + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["cursor"],
    ]);
  });

  it("accepts a cursor exactly on the ceiling", () => {
    const result = traceCommentListQuerySchema.safeParse({
      cursor: String(TRACE_COMMENT_LIST_MAX_OFFSET),
    });

    expect(result.success).toBe(true);
    expect(result.data?.cursor).toBe(TRACE_COMMENT_LIST_MAX_OFFSET);
  });
});
