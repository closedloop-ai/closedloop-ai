import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampSessionsPageIndex,
  parseSessionsPageIndex,
  readSessionsPageIndex,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  writeSessionsPageParam,
} from "../sessions-route-state";

describe("sessions route page state", () => {
  it.each([
    [null, 0],
    ["", 0],
    ["0", 0],
    ["-1", 0],
    ["1.5", 0],
    ["Infinity", 0],
    ["abc", 0],
    ["1", 0],
    ["2", 1],
    ["12", 11],
  ])("parses %s to page index %s", (value, expected) => {
    expect(parseSessionsPageIndex(value)).toBe(expected);
  });

  it("writes canonical page params while preserving unrelated params", () => {
    const params = new URLSearchParams("userId=user-123&page=3");

    writeSessionsPageParam(params, 0);
    expect(params.toString()).toBe("userId=user-123");

    writeSessionsPageParam(params, 2);
    expect(params.toString()).toBe("userId=user-123&page=3");
  });

  it.each([
    [{ pageIndex: 3, pageSize: 25, total: 0 }, 0],
    [{ pageIndex: 3, pageSize: 25, total: 10 }, 0],
    [{ pageIndex: 3, pageSize: 25, total: 51 }, 2],
    [{ pageIndex: 1, pageSize: 25, total: 51 }, 1],
  ])("clamps page indexes from list totals", (input, expected) => {
    expect(clampSessionsPageIndex(input)).toBe(expected);
  });

  it("falls back to the browser page query when the navigation snapshot is empty", () => {
    globalThis.history.replaceState(null, "", "/sessions?page=4");

    expect(readSessionsPageIndex(new URLSearchParams())).toBe(3);
  });

  it("forces effective page 1 while reset search params are reconciling", () => {
    const { result, rerender } = renderHook(
      ({ urlPageIndex }) => useSessionsPageReset({ urlPageIndex }),
      { initialProps: { urlPageIndex: 1 } }
    );

    expect(result.current.effectivePageIndex).toBe(1);

    act(() => {
      result.current.markPageReset();
    });

    expect(result.current.effectivePageIndex).toBe(0);

    rerender({ urlPageIndex: 1 });
    expect(result.current.effectivePageIndex).toBe(0);

    rerender({ urlPageIndex: 0 });
    expect(result.current.effectivePageIndex).toBe(0);
    expect(result.current.pendingReset).toBe(false);
  });

  it("forces an arbitrary effective page while repaired search params are reconciling", () => {
    const { result, rerender } = renderHook(
      ({ urlPageIndex }) => useSessionsPageReset({ urlPageIndex }),
      { initialProps: { urlPageIndex: 5 } }
    );

    act(() => {
      result.current.markPageOverride(2);
    });

    expect(result.current.effectivePageIndex).toBe(2);

    rerender({ urlPageIndex: 5 });
    expect(result.current.effectivePageIndex).toBe(2);

    rerender({ urlPageIndex: 2 });
    expect(result.current.effectivePageIndex).toBe(2);
    expect(result.current.pendingReset).toBe(false);
  });
});

describe("sessions history scroll state", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    globalThis.history.replaceState({ preserved: true }, "", "/sessions");
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
    globalThis.history.replaceState(null, "", "/sessions");
  });

  it("saves finite nonnegative scroll top while preserving existing history state", () => {
    const container = createScrollableElement({ scrollTop: 42 });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:1",
        container,
        restoreWhen: false,
      })
    );

    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });

    expect(globalThis.history.state).toMatchObject({
      preserved: true,
      __symphonySessionsScroll: {
        "sessions:page:1": 42,
      },
    });
  });

  it("coalesces multiple scroll events into one history write per frame", () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      })
    );
    const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");
    const container = createScrollableElement({ scrollTop: 10 });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:1",
        container,
        restoreWhen: false,
      })
    );

    act(() => {
      container.dispatchEvent(new Event("scroll"));
      container.scrollTop = 20;
      container.dispatchEvent(new Event("scroll"));
      container.scrollTop = 30;
      container.dispatchEvent(new Event("scroll"));
    });

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      frameCallback?.(0);
    });

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(globalThis.history.state).toMatchObject({
      __symphonySessionsScroll: {
        "sessions:page:1": 30,
      },
    });
  });

  it("restores saved scroll only after readiness is true", () => {
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:2": 80,
        },
      },
      "",
      "/sessions?page=3"
    );
    const container = createScrollableElement({
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 0,
    });

    const { rerender } = renderHook(
      ({ restoreWhen }) =>
        useSessionsHistoryScroll({
          scrollKey: "sessions:page:2",
          container,
          restoreWhen,
        }),
      { initialProps: { restoreWhen: false } }
    );

    expect(container.scrollTop).toBe(0);

    rerender({ restoreWhen: true });

    expect(container.scrollTop).toBe(80);
  });

  it("clamps saved scroll to the container maximum", () => {
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:4": 500,
        },
      },
      "",
      "/sessions?page=5"
    );
    const container = createScrollableElement({
      clientHeight: 100,
      scrollHeight: 260,
      scrollTop: 0,
    });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:4",
        container,
        restoreWhen: true,
      })
    );

    expect(container.scrollTop).toBe(160);
  });

  it("ignores saved scroll when content stays non-scrollable after bounded retries", () => {
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:7": 80,
        },
      },
      "",
      "/sessions?page=8"
    );
    const container = createScrollableElement({
      clientHeight: 100,
      scrollHeight: 100,
      scrollTop: 17,
    });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:7",
        container,
        restoreWhen: true,
      })
    );

    expect(container.scrollTop).toBe(17);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(30);
  });

  it("ignores malformed or missing saved state", () => {
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:1": "bad",
        },
      },
      "",
      "/sessions?page=2"
    );
    const container = createScrollableElement({
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 7,
    });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:1",
        container,
        restoreWhen: true,
      })
    );

    expect(container.scrollTop).toBe(7);
  });

  it("removes listeners and cancels pending frames on cleanup", () => {
    const frameCallback = vi.fn();
    const requestAnimationFrameMock = vi.fn(() => 9);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", frameCallback);
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:5": 50,
        },
      },
      "",
      "/sessions?page=6"
    );
    const container = createScrollableElement();
    const removeEventListenerSpy = vi.spyOn(container, "removeEventListener");

    const { unmount } = renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:5",
        container,
        restoreWhen: true,
      })
    );

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function)
    );
    expect(frameCallback).toHaveBeenCalledWith(9);
  });
});

function createScrollableElement({
  clientHeight = 100,
  scrollHeight = 300,
  scrollTop = 0,
}: {
  clientHeight?: number;
  scrollHeight?: number;
  scrollTop?: number;
} = {}) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  container.scrollTop = scrollTop;
  return container;
}
