import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProductNarrowGridview } from "../use-responsive-narrow-gridview";

const flagState = vi.hoisted(() => ({ enabled: true }));

vi.mock("../use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => flagState.enabled,
}));

const originalVisualViewport = Object.getOwnPropertyDescriptor(
  globalThis.window,
  "visualViewport"
);

afterEach(() => {
  flagState.enabled = true;
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

describe("useProductNarrowGridview browser zoom", () => {
  it("reacts to the scaled visual viewport while the layout viewport stays wide", () => {
    const visualViewport = createVisualViewport(1280);
    Object.defineProperty(globalThis.window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    const { result } = renderHook(() => useProductNarrowGridview());

    expect(result.current).toBe(false);
    act(() => {
      visualViewport.width = 640;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);
  });

  it("keeps the scaled viewport inert while the rollout is closed", () => {
    flagState.enabled = false;
    Object.defineProperty(globalThis.window, "visualViewport", {
      configurable: true,
      value: createVisualViewport(640),
    });

    const { result } = renderHook(() => useProductNarrowGridview());

    expect(result.current).toBe(false);
  });

  it("removes the visual viewport listener on unmount", () => {
    const visualViewport = createVisualViewport(1280);
    const removeListener = vi.spyOn(visualViewport, "removeEventListener");
    Object.defineProperty(globalThis.window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    const { unmount } = renderHook(() => useProductNarrowGridview());
    unmount();

    expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});

function createVisualViewport(width: number) {
  const viewport = new EventTarget();
  return Object.assign(viewport, { width });
}
