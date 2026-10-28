import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentsRailState } from "../use-comments-rail-state";

/**
 * ISS-11004: the rail-state half of the Activity tab's comment links.
 *
 * FEA-4233 folds the rail to its slim handle until comments are confirmed, and
 * FEA-2479 honours the reader's saved collapse. Both would swallow a
 * `?comment=` link, so an address reveals the rail — transiently, the same way
 * a submitted comment does, so following a link never rewrites the preference.
 */
const { useTraceCommentsMock } = vi.hoisted(() => ({
  useTraceCommentsMock: vi.fn(),
}));

vi.mock("../use-trace-comments", () => ({
  useTraceComments: (options: unknown) => useTraceCommentsMock(options),
}));

const COMMENT = { id: "c-1" };
const THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

beforeEach(() => {
  useTraceCommentsMock.mockReset();
  useTraceCommentsMock.mockReturnValue({
    comments: [COMMENT],
    hasLoadedComments: true,
    submitTraceComment: vi.fn(),
  });
});

function renderRailState(
  selectedThreadId: string | null,
  onCommentsCollapsedChange = vi.fn()
) {
  const view = renderHook(
    (props: { selectedThreadId: string | null }) =>
      useCommentsRailState({
        commentsCollapsed: true,
        commentsRailOpen: true,
        jumpToRow: vi.fn(),
        onCommentsCollapsedChange,
        selectedThreadId: props.selectedThreadId,
        sessionId: "session-1",
      }),
    { initialProps: { selectedThreadId } }
  );
  return { onCommentsCollapsedChange, view };
}

describe("useCommentsRailState addressed comment", () => {
  it("opens a collapsed rail for an addressed comment", () => {
    const { view } = renderRailState("c-1");

    expect(view.result.current.commentsRailCollapsed).toBe(false);
  });

  /**
   * The counterfactual for the case above: with no address, the reader's saved
   * collapse still folds the rail. Without it, a hook that simply never
   * collapsed would pass.
   */
  it("leaves a collapsed rail folded when no comment is addressed", () => {
    const { view } = renderRailState(null);

    expect(view.result.current.commentsRailCollapsed).toBe(true);
  });

  it("never rewrites the saved collapse preference", () => {
    const { onCommentsCollapsedChange } = renderRailState("c-1");

    expect(onCommentsCollapsedChange).not.toHaveBeenCalled();
  });

  it("stops fighting a reader who re-collapses the rail after following a link", () => {
    const { view } = renderRailState("c-1");
    expect(view.result.current.commentsRailCollapsed).toBe(false);

    view.result.current.collapseCommentsRail();
    view.rerender({ selectedThreadId: "c-1" });

    expect(view.result.current.commentsRailCollapsed).toBe(true);
  });

  it("opens again when a different comment is addressed", () => {
    const { view } = renderRailState("c-1");
    view.result.current.collapseCommentsRail();
    view.rerender({ selectedThreadId: "c-1" });
    expect(view.result.current.commentsRailCollapsed).toBe(true);

    view.rerender({ selectedThreadId: "c-2" });

    expect(view.result.current.commentsRailCollapsed).toBe(false);
  });

  /**
   * The host-shell half (PR #8562, whitlockk): leaving the rail's tab clears the
   * address it forwards, and that clear is what lets the same link reveal
   * again on re-entry.
   */
  it("reveals the same thread again once the address was cleared", () => {
    const { view } = renderRailState(THREAD_ID);
    view.result.current.collapseCommentsRail();
    view.rerender({ selectedThreadId: THREAD_ID });
    expect(view.result.current.commentsRailCollapsed).toBe(true);

    view.rerender({ selectedThreadId: null });
    view.rerender({ selectedThreadId: THREAD_ID });

    expect(view.result.current.commentsRailCollapsed).toBe(false);
  });

  /**
   * tamsinb, PR #8562: the header toggle hides the rail outright, so an
   * address asks the host to re-open it — and the re-open stays transient.
   */
  it("asks the host to re-open a rail its header toggle hid, without rewriting the saved collapse", () => {
    const onCommentsCollapsedChange = vi.fn();
    const onRevealCommentsRail = vi.fn();
    const view = renderHook(
      (props: { commentsRailOpen: boolean }) =>
        useCommentsRailState({
          commentsCollapsed: true,
          commentsRailOpen: props.commentsRailOpen,
          jumpToRow: vi.fn(),
          onCommentsCollapsedChange,
          onRevealCommentsRail,
          selectedThreadId: THREAD_ID,
          sessionId: "session-1",
        }),
      { initialProps: { commentsRailOpen: false } }
    );
    expect(onRevealCommentsRail).toHaveBeenCalledOnce();

    view.rerender({ commentsRailOpen: true });

    expect(view.result.current.commentsRailCollapsed).toBe(false);
    expect(onCommentsCollapsedChange).not.toHaveBeenCalled();
  });

  /**
   * PLN-2162 M6: in the Session shell the unified pane hosts the comments and
   * owns the address, so the disabled legacy rail must not also re-open it.
   */
  it("leaves an address to the pane that hosts the comments when disabled", () => {
    const onRevealCommentsRail = vi.fn();
    renderHook(() =>
      useCommentsRailState({
        commentsCollapsed: true,
        commentsRailOpen: false,
        enabled: false,
        jumpToRow: vi.fn(),
        onCommentsCollapsedChange: vi.fn(),
        onRevealCommentsRail,
        selectedThreadId: THREAD_ID,
        sessionId: "session-1",
      })
    );

    expect(onRevealCommentsRail).not.toHaveBeenCalled();
  });

  /**
   * The pane's address reveal re-opens the header toggle; the disabled rail
   * sees that edge too and must leave the saved collapse alone (ISS-11004).
   */
  it("leaves the saved collapse alone on a header re-open when disabled", () => {
    const onCommentsCollapsedChange = vi.fn();
    const view = renderHook(
      (props: { commentsRailOpen: boolean }) =>
        useCommentsRailState({
          commentsCollapsed: true,
          commentsRailOpen: props.commentsRailOpen,
          enabled: false,
          jumpToRow: vi.fn(),
          onCommentsCollapsedChange,
          onRevealCommentsRail: vi.fn(),
          selectedThreadId: THREAD_ID,
          sessionId: "session-1",
        }),
      { initialProps: { commentsRailOpen: false } }
    );

    view.rerender({ commentsRailOpen: true });

    expect(onCommentsCollapsedChange).not.toHaveBeenCalled();
  });

  /**
   * The counterfactual for the case above: the header toggle's own false→true
   * edge still clears a stale saved collapse (FEA-2479).
   */
  it("still clears the saved collapse when the reader re-opens the header toggle", () => {
    const onCommentsCollapsedChange = vi.fn();
    const view = renderHook(
      (props: { commentsRailOpen: boolean }) =>
        useCommentsRailState({
          commentsCollapsed: true,
          commentsRailOpen: props.commentsRailOpen,
          jumpToRow: vi.fn(),
          onCommentsCollapsedChange,
          onRevealCommentsRail: vi.fn(),
          selectedThreadId: null,
          sessionId: "session-1",
        }),
      { initialProps: { commentsRailOpen: false } }
    );

    view.rerender({ commentsRailOpen: true });

    expect(onCommentsCollapsedChange).toHaveBeenCalledWith(false);
  });

  /** whitlockk, PR #8562: the read asks for the addressed thread by name. */
  it("asks the read for the addressed thread", () => {
    renderRailState(THREAD_ID);

    expect(useTraceCommentsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeThreadId: THREAD_ID })
    );
  });

  it("does not forward an address that is not a thread id", () => {
    renderRailState("not-a-thread");

    expect(useTraceCommentsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeThreadId: undefined })
    );
  });
});
