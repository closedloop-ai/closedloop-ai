import { describe, expect, it } from "vitest";
import { parseNumericGithubCommentId } from "./branch-view.ts";

describe("parseNumericGithubCommentId", () => {
  it("parses a trimmed positive safe integer", () => {
    expect(parseNumericGithubCommentId(" 42 ")).toBe(42);
  });

  it.each([
    "not-a-number",
    "0",
    "-1",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects invalid GitHub comment id %s", (value) => {
    expect(parseNumericGithubCommentId(value)).toBeNull();
  });
});
