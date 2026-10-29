import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { describe, expect, it, vi } from "vitest";
import {
  githubThread,
  makeThread,
  traceAnchor,
} from "../../components/comments/comments-pane.fixtures";
import {
  createArtifactAnchorAdapter,
  createCodeAnchorAdapter,
  createCommentAnchorRegistry,
  createTraceAnchorAdapter,
} from "../comment-anchor-adapters";

const CODE_LOCATION = /comments-pane\.tsx:\d+$/;

function sessionRegistry() {
  const jumpToRow = vi.fn();
  const selection = traceAnchor("selected words", { row: 12 });
  const { kind: _kind, ...traceText } = selection;
  const captureSelection = vi.fn(() => traceText);
  const registry = createCommentAnchorRegistry([
    createArtifactAnchorAdapter(),
    createTraceAnchorAdapter({ captureSelection, jumpToRow }),
  ]);
  return { registry, jumpToRow, captureSelection, selection };
}

describe("comment anchor registry (PLN-2162 M2.5)", () => {
  it("declares as revealable only the kinds whose adapter can reveal", () => {
    expect(sessionRegistry().registry.revealableAnchorKinds).toEqual([
      CommentAnchorKind.Trace,
    ]);
  });

  it("captures a trace selection as a trace anchor, and the whole artifact as itself", () => {
    const { registry, selection } = sessionRegistry();

    expect(registry.capture(CommentAnchorKind.Trace)).toEqual(selection);
    expect(registry.capture(CommentAnchorKind.Artifact)).toEqual({
      kind: CommentAnchorKind.Artifact,
    });
    expect(registry.capture(CommentAnchorKind.Code)).toBeNull();
  });

  it("reveals a trace thread by jumping to its row", () => {
    const { registry, jumpToRow } = sessionRegistry();
    const thread = makeThread({
      id: "t",
      anchor: traceAnchor("x", { row: 40 }),
    });

    expect(registry.reveal(thread)).toBe(true);
    // The whole anchor rides along for a host that reveals a placement (M6).
    expect(jumpToRow).toHaveBeenCalledWith(40, thread.anchor);
  });

  it("does not reveal a placement the server no longer holds, or a kind it has no adapter for", () => {
    const { registry, jumpToRow } = sessionRegistry();
    const orphaned = makeThread({
      id: "t",
      anchorState: CommentAnchorState.Orphaned,
    });

    expect(registry.reveal(orphaned)).toBe(false);
    expect(registry.reveal(githubThread("g"))).toBe(false);
    expect(registry.resolve(githubThread("g"))).toBeNull();
    expect(jumpToRow).not.toHaveBeenCalled();
  });

  it("resolves a GitHub thread to its path:line and link-out, and never reveals it in-app", () => {
    const registry = createCommentAnchorRegistry([createCodeAnchorAdapter()]);
    const thread = githubThread("g", {
      provider: { linkOut: "https://github.com/o/r/pull/1#c1" },
    });

    expect(registry.revealableAnchorKinds).toEqual([]);
    expect(registry.resolve(thread)).toEqual({
      label: expect.stringMatching(CODE_LOCATION),
      linkOut: "https://github.com/o/r/pull/1#c1",
    });
    expect(registry.reveal(thread)).toBe(false);
  });
});
