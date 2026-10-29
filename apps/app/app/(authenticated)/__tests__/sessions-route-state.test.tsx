import {
  clampScrollRestoreTarget,
  computeMaxScrollTop,
  hasStoredScrollPosition,
  runSessionsScrollContractConformance,
} from "@repo/app/shared/lib/sessions-scroll-contract";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasWebStoredScrollPosition,
  MAX_SCROLL_RESTORE_ATTEMPTS,
  readSessionsPageIndex,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  useSessionsUrlPageIndex,
} from "../sessions-route-state";

describe("sessions route page state", () => {
  it("falls back to the browser page query when the navigation snapshot is empty", () => {
    globalThis.history.replaceState(null, "", "/sessions?page=4");

    expect(readSessionsPageIndex(new URLSearchParams(), "/sessions")).toBe(3);
  });

  // ISS-8187: Branches names its page param `page` too, so an unscoped browser
  // read seeded the Sessions list's FIRST request from the Branches page index
  // left in the address bar mid-transition. Sibling of the case above: same
  // empty snapshot, same populated address bar, different route.
  it("ignores a browser page query that belongs to another surface", () => {
    globalThis.history.replaceState(null, "", "/acme/branches?page=5");

    expect(readSessionsPageIndex(new URLSearchParams(), "/acme/sessions")).toBe(
      0
    );
  });

  // FEA-3664: an absent `page` param means page 1. Post-mount the reactive
  // snapshot is authoritative, so the browser URL must NOT be consulted —
  // otherwise returning to page 1 sticks on the previous page.
  it("resolves an absent page param to page 1 when the browser fallback is off, ignoring a stale browser URL", () => {
    globalThis.history.replaceState(null, "", "/sessions?page=4");

    expect(
      readSessionsPageIndex(new URLSearchParams(), "/sessions", {
        allowBrowserFallback: false,
      })
    ).toBe(0);
  });

  it("useSessionsUrlPageIndex resolves an absent page param to page 1 after mount, ignoring a stale browser URL (FEA-3664)", () => {
    globalThis.history.replaceState(null, "", "/sessions?page=4");

    const { result } = renderHook(() =>
      useSessionsUrlPageIndex(new URLSearchParams(), "/sessions")
    );

    expect(result.current).toBe(0);
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

  // FEA-3655: the Owner-filter pagination bug. A stale-page clamp seeds an
  // override, then the user clicks Next/a page before the clamp's URL round-trip
  // settles — the URL lands on a value OTHER than the pending target. The
  // override must be dropped so the effective page follows the new navigation;
  // previously it stayed pinned and every subsequent click was a no-op.
  it("drops a page override when a newer navigation supersedes it", () => {
    const { result, rerender } = renderHook(
      ({ urlPageIndex }) => useSessionsPageReset({ urlPageIndex }),
      { initialProps: { urlPageIndex: 5 } }
    );

    act(() => {
      result.current.markPageOverride(1);
    });
    expect(result.current.effectivePageIndex).toBe(1);

    // User navigates to page index 3 before the URL reaches the clamp target (1).
    rerender({ urlPageIndex: 3 });
    expect(result.current.effectivePageIndex).toBe(3);
    expect(result.current.pendingReset).toBe(false);
  });

  it("drops a page reset when the user paginates before the reset settles", () => {
    const { result, rerender } = renderHook(
      ({ urlPageIndex }) => useSessionsPageReset({ urlPageIndex }),
      { initialProps: { urlPageIndex: 5 } }
    );

    act(() => {
      result.current.markPageReset();
    });
    expect(result.current.effectivePageIndex).toBe(0);

    // User clicks to page index 2 before the URL reaches the reset target (0).
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
    vi.useRealTimers();
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

  it("writes on the leading edge and coalesces the rest of a burst into one trailing write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
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

    // Leading edge captures a position immediately, so navigating away right
    // after a single scroll still restores.
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(globalThis.history.state).toMatchObject({
      __symphonySessionsScroll: {
        "sessions:page:1": 10,
      },
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    // The rest of the burst settles into exactly one trailing write.
    expect(replaceStateSpy).toHaveBeenCalledTimes(2);
    expect(globalThis.history.state).toMatchObject({
      __symphonySessionsScroll: {
        "sessions:page:1": 30,
      },
    });
  });

  it("stays under the browser replaceState rate limit while scrolling (ISS-7493)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");
    const container = createScrollableElement({ scrollTop: 0 });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:1",
        container,
        restoreWhen: false,
      })
    );

    // Ten seconds of continuous scrolling at ~60fps. The previous
    // per-animation-frame save wrote once per tick (600 calls), which is what
    // tripped the browser cap and produced the production error.
    act(() => {
      for (let tick = 0; tick < 600; tick++) {
        container.scrollTop = tick;
        container.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(1000 / 60);
      }
    });

    expect(replaceStateSpy.mock.calls.length).toBeLessThan(100);
    // The final position is still persisted, so restoration is unaffected.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(globalThis.history.state).toMatchObject({
      __symphonySessionsScroll: {
        "sessions:page:1": 599,
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

  it("does not restore a remembered position of exactly 0", () => {
    globalThis.history.replaceState(
      {
        __symphonySessionsScroll: {
          "sessions:page:9": 0,
        },
      },
      "",
      "/sessions?page=10"
    );
    const container = createScrollableElement({
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 42,
    });

    renderHook(() =>
      useSessionsHistoryScroll({
        scrollKey: "sessions:page:9",
        container,
        restoreWhen: true,
      })
    );

    expect(container.scrollTop).toBe(42);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
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

// PLN-1950 slice 5: pins web's own bindings against the shared contract --
// MAX_SCROLL_RESTORE_ATTEMPTS and hasWebStoredScrollPosition are this host's
// real exports from `sessions-route-state.ts` (not hand-copied duplicates).
// The shared factory only exercises undefined/null/120, so this pins that
// web's gate rejects an absent value exactly like the shared contract does --
// it does NOT exercise web's extra `> 0` narrowing (a remembered 0 also
// counts as nothing to restore on web, unlike the shared gate, which accepts
// 0); that clause is pinned separately by the hook-driven "does not restore a
// remembered position of exactly 0" case above. computeMaxScrollTop and
// clampScrollRestoreTarget are the shared module's own exports, forwarded
// here unwrapped exactly as web's retry loop calls them -- this only checks
// that the shared clamp math is internally consistent, not that web's retry
// loop actually calls it; that wiring is covered by the other hook-driven
// cases earlier in this file, which drive useSessionsHistoryScroll end to
// end and assert container.scrollTop.
describe("sessions scroll contract conformance (PLN-1950 slice 5)", () => {
  it("passes the shared gate, retry-bound and clamp contract", () => {
    runSessionsScrollContractConformance({
      hostLabel: "web sessions history scroll",
      maxRestoreAttempts: MAX_SCROLL_RESTORE_ATTEMPTS,
      computeMaxScrollTop,
      clampScrollRestoreTarget,
      hasStoredScrollPosition: hasWebStoredScrollPosition,
    });
  });

  // Nothing else pins that web's gate is a strict REFINEMENT of the shared
  // one, not an independent, possibly-incompatible check: the shared gate
  // accepts a remembered 0 (desktop restores it); web's own gate rejects it
  // (see hasWebStoredScrollPosition's docstring in sessions-route-state.ts
  // and the shared module's header for why). Pin the divergence itself so a
  // change to either boundary is caught here rather than only surfacing as a
  // behavior mismatch between hosts.
  it("pins that web's gate rejects a remembered 0 where the shared gate accepts it", () => {
    expect(hasStoredScrollPosition(0)).toBe(true);
    expect(hasWebStoredScrollPosition(0)).toBe(false);
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
