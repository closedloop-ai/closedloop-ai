import { formatMetricValue } from "@closedloop-ai/design-system/components/ui/primitives/format-metric-value";
import {
  dispatchGraphReset,
  GRAPH_RESET_EVENT,
} from "@closedloop-ai/design-system/components/ui/primitives/graph-events";
import { useCopyToClipboard } from "@closedloop-ai/design-system/hooks/use-copy-to-clipboard";
import {
  useMediaQuery,
  useViewportWidth,
} from "@closedloop-ai/design-system/hooks/use-media-query";
import { activateOnEnterOrSpace } from "@closedloop-ai/design-system/lib/keyboard-activation";
import { capitalize, cn } from "@closedloop-ai/design-system/lib/utils";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-7349. The package's smallest shared primitives, each of which is imported
 * by many components and therefore fails everywhere at once. Every one of them
 * has a guard arm no story reaches: a clipboard write that rejects (an insecure
 * context or a denied permission), a host with no `matchMedia`, a keydown that
 * bubbled up from a nested control, an SSR pass with no `document`.
 *
 * Grouped into one file because they are one concern — the leaf utilities the
 * component tree stands on — rather than starting six near-empty suites.
 */

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy entries", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("lets a later Tailwind class win over an earlier conflicting one", () => {
    // The whole reason this is twMerge and not clsx alone.
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("returns an empty string for no inputs", () => {
    expect(cn()).toBe("");
  });
});

describe("capitalize", () => {
  it("upper-cases the first character", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("leaves the rest of the string untouched", () => {
    expect(capitalize("hELLO")).toBe("HELLO");
  });

  it("returns an empty string unchanged", () => {
    expect(capitalize("")).toBe("");
  });

  it("passes a non-letter first character through", () => {
    expect(capitalize("1st")).toBe("1st");
  });
});

describe("formatMetricValue", () => {
  it("groups thousands in a numeric value", () => {
    expect(formatMetricValue(1_234_567)).toBe("1,234,567");
  });

  it("passes a string value through verbatim", () => {
    // A caller that has already formatted its value must not be re-formatted.
    expect(formatMetricValue("1.2k")).toBe("1.2k");
  });

  it("renders a zero rather than an empty string", () => {
    expect(formatMetricValue(0)).toBe("0");
  });
});

describe("activateOnEnterOrSpace", () => {
  /**
   * The handler is invoked directly rather than through a rendered element: it
   * reads only `currentTarget`, `target`, and `key`, and mounting a host to
   * deliver those would mean either a native <button> (whose own Enter/Space
   * activation is what the assertion would really be measuring) or a div
   * carrying the interaction lint this helper exists to let a caller take on
   * deliberately. Calling it directly also lets `preventDefault` be asserted,
   * which is half the contract — without it the key ALSO scrolls the container.
   */
  const host = { name: "host" };

  function keyEvent(key: string, target: unknown = host) {
    return {
      currentTarget: host,
      key,
      preventDefault: vi.fn(),
      target,
    } as unknown as React.KeyboardEvent<Element> & {
      preventDefault: ReturnType<typeof vi.fn>;
    };
  }

  it.each([["Enter"], [" "]])("activates on %s", (key) => {
    const onActivate = vi.fn();
    const event = keyEvent(key);

    activateOnEnterOrSpace(onActivate)(event);

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it.each([["Enter"], [" "]])(
    "suppresses the browser default on %s so the key does not also scroll",
    (key) => {
      const event = keyEvent(key);

      activateOnEnterOrSpace(vi.fn())(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  );

  it("ignores an unrelated key", () => {
    const onActivate = vi.fn();
    const event = keyEvent("a");

    activateOnEnterOrSpace(onActivate)(event);

    expect(onActivate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores a keydown that bubbled up from a nested control", () => {
    // A nested link or button keeps its own Enter behavior instead of also
    // firing the row's activation.
    const onActivate = vi.fn();
    const event = keyEvent("Enter", { name: "nested" });

    activateOnEnterOrSpace(onActivate)(event);

    expect(onActivate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("dispatchGraphReset", () => {
  it("dispatches the namespaced reset event to every listener", () => {
    const listener = vi.fn();
    globalThis.document.addEventListener(GRAPH_RESET_EVENT, listener);

    dispatchGraphReset();

    expect(listener).toHaveBeenCalledTimes(1);
    globalThis.document.removeEventListener(GRAPH_RESET_EVENT, listener);
  });

  it("is safe to call with no document", () => {
    // The SSR guard: a widget open/close transition must not throw on the
    // server just because no Graph can be mounted there.
    vi.stubGlobal("document", undefined);

    expect(() => dispatchGraphReset()).not.toThrow();

    vi.unstubAllGlobals();
  });
});

describe("useMediaQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the query's current match state", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      }))
    );

    const { result } = renderHook(() => useMediaQuery("(min-width: 100px)"));

    expect(result.current).toBe(true);
  });

  it("re-renders when the query's match state changes", () => {
    let notify: () => void = () => undefined;
    let matches = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: (_event: string, callback: () => void) => {
          notify = callback;
        },
        get matches() {
          return matches;
        },
        removeEventListener: vi.fn(),
      }))
    );

    const { result } = renderHook(() => useMediaQuery("(min-width: 100px)"));
    expect(result.current).toBe(false);

    act(() => {
      matches = true;
      notify();
    });

    expect(result.current).toBe(true);
  });

  it("reports false on a host with no matchMedia", () => {
    // SSR and any non-browser host — must degrade, not throw.
    vi.stubGlobal("matchMedia", undefined);

    const { result } = renderHook(() => useMediaQuery("(min-width: 100px)"));

    expect(result.current).toBe(false);
  });

  it("unsubscribes cleanly on a host with no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);

    const { unmount } = renderHook(() => useMediaQuery("(min-width: 100px)"));

    expect(() => unmount()).not.toThrow();
  });

  it("passes the query string through to matchMedia", () => {
    const matchMedia = vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    renderHook(() => useMediaQuery("(max-width: 639px)"));

    expect(matchMedia).toHaveBeenCalledWith("(max-width: 639px)");
  });

  it("resubscribes against the new query when the query changes", () => {
    // The old listener must come OFF: leaving it attached would keep
    // re-rendering the caller on a breakpoint it no longer asked about.
    const removeEventListener = vi.fn();
    const addEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener,
        matches: false,
        removeEventListener,
      }))
    );

    const { rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: "(min-width: 100px)" },
    });
    expect(addEventListener).toHaveBeenCalledTimes(1);

    rerender({ query: "(min-width: 200px)" });

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(2);
  });

  it("removes its listener on unmount", () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener,
      }))
    );

    const { unmount } = renderHook(() => useMediaQuery("(min-width: 100px)"));
    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("useViewportWidth", () => {
  const originalVisualViewport = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "visualViewport"
  );

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalVisualViewport) {
      Object.defineProperty(
        globalThis.window,
        "visualViewport",
        originalVisualViewport
      );
      return;
    }
    Reflect.deleteProperty(globalThis.window, "visualViewport");
  });

  it("tracks visual viewport resize events produced by browser zoom", () => {
    const viewport = Object.assign(new EventTarget(), { width: 1280 });
    Object.defineProperty(globalThis.window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const { result } = renderHook(() => useViewportWidth());

    expect(result.current).toBe(1280);
    act(() => {
      viewport.width = 640;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toBe(640);
  });

  it("falls back to the layout viewport when visualViewport is absent", () => {
    Reflect.deleteProperty(globalThis.window, "visualViewport");

    const { result } = renderHook(() => useViewportWidth());

    expect(result.current).toBe(globalThis.window.innerWidth);
  });

  it("removes window and visual viewport resize subscriptions on unmount", () => {
    const viewport = Object.assign(new EventTarget(), { width: 1280 });
    const removeVisualListener = vi.spyOn(viewport, "removeEventListener");
    const removeWindowListener = vi.spyOn(
      globalThis.window,
      "removeEventListener"
    );
    Object.defineProperty(globalThis.window, "visualViewport", {
      configurable: true,
      value: viewport,
    });

    const { unmount } = renderHook(() => useViewportWidth());
    unmount();

    expect(removeVisualListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
  });
});

describe("useCopyToClipboard", () => {
  const DEFAULT_RESET_DELAY_MS = 2000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubClipboard(writeText: () => Promise<void>) {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  }

  it("writes the value and reports success", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current[1]("secret");
    });

    expect(outcome).toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret");
    expect(result.current[0]).toBe(true);
  });

  it("clears the copied flag after the reset delay", async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard(500));
    await act(async () => {
      await result.current[1]("secret");
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current[0]).toBe(false);
  });

  it("restarts the window when a second copy lands mid-wait", async () => {
    // The superseded timer must be cleared, or the first one fires and flips
    // the confirmation off while the second copy is still fresh.
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard(500));
    await act(async () => {
      await result.current[1]("first");
    });

    act(() => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      await result.current[1]("second");
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current[0]).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("reports failure without writing for %s", async (_label, value) => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current[1](value);
    });

    expect(outcome).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports failure when the clipboard write rejects", async () => {
    // Insecure context or a denied permission — the caller must be able to tell
    // rather than showing a copied confirmation for a copy that never happened.
    stubClipboard(() => Promise.reject(new Error("denied")));
    const { result } = renderHook(() => useCopyToClipboard());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current[1]("secret");
    });

    expect(outcome).toBe(false);
    expect(result.current[0]).toBe(false);
  });

  it("clears its pending timer on unmount", async () => {
    stubClipboard(() => Promise.resolve());
    const { result, unmount } = renderHook(() => useCopyToClipboard(500));
    await act(async () => {
      await result.current[1]("secret");
    });

    // The reset timer is armed by the successful copy above.
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    // Assert the timer is GONE, not that advancing it fails to throw —
    // advancing a live timer whose hook has unmounted throws nothing either, so
    // the negative form stayed green with the cleanup deleted.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the copied flag after the DEFAULT reset delay", async () => {
    // The cases above all pass an explicit delay, so none of them pins the
    // default parameter — it could be any value and they would still pass.
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard());
    await act(async () => {
      await result.current[1]("secret");
    });
    expect(result.current[0]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DEFAULT_RESET_DELAY_MS - 1);
    });
    expect(result.current[0]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current[0]).toBe(false);
  });

  it("unmounts cleanly when no copy ever armed a timer", () => {
    // The cleanup's no-timer arm: every other unmount case here reaches it with
    // a timer to clear, so this is the only one that runs the guard's false leg.
    const { unmount } = renderHook(() => useCopyToClipboard());
    expect(vi.getTimerCount()).toBe(0);

    expect(() => unmount()).not.toThrow();
  });
});
