import { useIsMobile } from "@closedloop-ai/design-system/hooks/use-mobile";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mirrors the private MOBILE_BREAKPOINT in the hook source.
const MOBILE_BREAKPOINT = 768;

function stubViewport(widthPx: number, addEventListener = vi.fn()) {
  vi.stubGlobal("innerWidth", widthPx);
  const matchMedia = vi.fn(() => ({
    addEventListener,
    matches: widthPx < MOBILE_BREAKPOINT,
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
  it("reports true when the viewport is narrower than the breakpoint", () => {
    stubViewport(MOBILE_BREAKPOINT - 1);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
  });

  it("reports false when the viewport is exactly at the breakpoint", () => {
    stubViewport(MOBILE_BREAKPOINT);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it("reports false when the viewport is wider than the breakpoint", () => {
    stubViewport(1024);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it("queries matchMedia with the breakpoint-derived query string", () => {
    const matchMedia = stubViewport(1024);

    renderHook(() => useIsMobile());

    expect(matchMedia).toHaveBeenCalledWith(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
    );
  });

  it("updates when the change listener fires and the viewport crosses the breakpoint", () => {
    let onChange: () => void = () => undefined;
    const addEventListener = vi.fn((_event: string, callback: () => void) => {
      onChange = callback;
    });
    stubViewport(1024, addEventListener);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      vi.stubGlobal("innerWidth", 375);
      onChange();
    });

    expect(result.current).toBe(true);
  });

  it("removes its change listener on unmount", () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener,
      }))
    );

    const { unmount } = renderHook(() => useIsMobile());
    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});
