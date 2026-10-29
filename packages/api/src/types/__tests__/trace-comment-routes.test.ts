import { describe, expect, it } from "vitest";
import {
  CommentTargetType,
  hasTraceCommentRoutes,
  traceCommentsPath,
} from "../comment";

describe("legacy trace-comment routes", () => {
  it("serve sessions and branches only", () => {
    expect(
      Object.values(CommentTargetType).filter(hasTraceCommentRoutes)
    ).toEqual([CommentTargetType.Session, CommentTargetType.Branch]);
  });

  it("build no path for a document target", () => {
    expect(() =>
      traceCommentsPath({ type: CommentTargetType.Document, id: "doc-1" })
    ).toThrow();
    expect(
      traceCommentsPath({ type: CommentTargetType.Branch, id: "b/1" })
    ).toBe("/branches/b%2F1/trace-comments");
  });
});
