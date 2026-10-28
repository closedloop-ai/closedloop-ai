import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAnchorRevealWhenEditorReady } from "../use-anchor-reveal-when-editor-ready";

const scrollToAnchor = vi.hoisted(() => vi.fn());
vi.mock("@repo/collaboration/client/scroll-to-anchor", () => ({
  scrollToAnchor,
}));

describe("useAnchorRevealWhenEditorReady", () => {
  beforeEach(() => {
    scrollToAnchor.mockClear();
  });

  it("scrolls at once when the editor already has content", () => {
    const { result } = renderHook(() => useAnchorRevealWhenEditorReady(true));

    result.current("thread-1");

    expect(scrollToAnchor).toHaveBeenCalledExactlyOnceWith("thread-1");
  });

  it("holds a reveal until the editor has content, then scrolls once", () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useAnchorRevealWhenEditorReady(ready),
      { initialProps: { ready: false } }
    );

    result.current("thread-1");
    expect(scrollToAnchor).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(scrollToAnchor).toHaveBeenCalledExactlyOnceWith("thread-1");

    rerender({ ready: false });
    rerender({ ready: true });
    expect(scrollToAnchor).toHaveBeenCalledTimes(1);
  });

  it("reveals only the latest thread requested while waiting", () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useAnchorRevealWhenEditorReady(ready),
      { initialProps: { ready: false } }
    );

    result.current("thread-1");
    result.current("thread-2");
    rerender({ ready: true });

    expect(scrollToAnchor).toHaveBeenCalledExactlyOnceWith("thread-2");
  });
});
