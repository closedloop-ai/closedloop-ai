/**
 * ISS-6383 regression guard for the RUM view-storm defect.
 *
 * `DatadogAppRouter` starts a RUM view from its render body behind a `useRef`.
 * A ref is per-instance, so a remount — or a render React begins and discards —
 * resets the guard and starts a SECOND view for the same pathname. Production
 * emitted 13,918 duplicate `/[orgSlug]/branches` views in 28 seconds that way.
 *
 * These two cover the REMOUNT trigger, as a pair: the first alone would also
 * pass for a tracker that never started a view again after the first one, which
 * would silently stop all route tracking, and the second forbids that.
 *
 * What they do NOT cover, stated rather than implied: the discarded-render
 * trigger. React gives no supported way to make it start and abandon a specific
 * render, so the one window the fix cannot be tested through is the single
 * render in which the vendor transitions to mounted. The mock below counts
 * RENDER-BODY executions rather than commits so that it at least measures the
 * same thing the real vendor does — a mock reporting from `useEffect` could not
 * observe an uncommitted render even in principle.
 */

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/[orgSlug]/branches",
  viewStarted: vi.fn(),
}));

// Mirrors the vendor: it emits from the render body, not from an effect.
vi.mock("@datadog/browser-rum-nextjs", () => ({
  DatadogAppRouter: () => {
    state.viewStarted();
    return null;
  },
}));

vi.mock("@/lib/navigation/next-adapter", () => ({
  usePathValue: () => state.pathname,
}));

function loadTracker() {
  return import("@/lib/datadog-rum/route-view-tracker");
}

beforeEach(() => {
  state.pathname = "/[orgSlug]/branches";
  state.viewStarted.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("DatadogRouteViewTracker", () => {
  it("starts one view when the tracker remounts on an unchanged pathname", async () => {
    const { DatadogRouteViewTracker } = await loadTracker();

    const first = render(<DatadogRouteViewTracker />);
    expect(state.viewStarted).toHaveBeenCalledTimes(1);

    // A fresh component instance is exactly what a remount hands the vendor:
    // its own ref guard is back to null.
    first.unmount();
    render(<DatadogRouteViewTracker />);

    expect(state.viewStarted).toHaveBeenCalledTimes(1);
  });

  it("starts a new view when the pathname actually changes", async () => {
    const { DatadogRouteViewTracker } = await loadTracker();

    const { rerender } = render(<DatadogRouteViewTracker />);
    expect(state.viewStarted).toHaveBeenCalledTimes(1);

    state.pathname = "/[orgSlug]/sessions";
    rerender(<DatadogRouteViewTracker />);

    expect(state.viewStarted).toHaveBeenCalledTimes(2);
  });
});
