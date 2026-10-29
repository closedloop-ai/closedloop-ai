import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { describe, expect, it } from "vitest";
import { validateCommentAnchor } from "./comment-anchor-validation";

const traceAnchor = {
  kind: CommentAnchorKind.Trace,
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "quote",
  sourceText: "a quote",
  startOffset: 2,
  endOffset: 7,
};

const codeAnchor = {
  kind: CommentAnchorKind.Code,
  repository: "acme/repo",
  commitSha: "a".repeat(40),
  path: "src/index.ts",
  side: "right",
  endLine: 12,
};

describe("validateCommentAnchor", () => {
  it("accepts a trace anchor on a native Session", () => {
    expect(
      validateCommentAnchor(CommentPolicyKey.NativeSession, traceAnchor)
    ).toEqual({ ok: true, value: traceAnchor });
  });

  it("rejects an anchor the contract does not parse", () => {
    expect(
      validateCommentAnchor(CommentPolicyKey.NativeSession, {
        ...traceAnchor,
        endOffset: 1,
      })
    ).toEqual({ ok: false, error: CommentErrorCode.AnchorInvalid });
  });

  it("rejects a valid anchor of a kind the source does not allow", () => {
    expect(
      validateCommentAnchor(CommentPolicyKey.NativeBranch, codeAnchor)
    ).toEqual({ ok: false, error: CommentErrorCode.AnchorKindNotAllowed });
    expect(
      validateCommentAnchor(CommentPolicyKey.GithubBranch, codeAnchor)
    ).toEqual({ ok: true, value: codeAnchor });
  });
});
