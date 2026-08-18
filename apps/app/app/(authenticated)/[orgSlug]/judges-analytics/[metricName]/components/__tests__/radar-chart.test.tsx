import type { RadarAxes } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JudgeRadarChart } from "../radar-chart";

// FEA-4149 (FEA-3961 pattern): the radar chart hosts Recharts through the shared
// `ChartContainer`, whose `min-h-40` floor (on the laid-out box and its inner
// ResponsiveContainer) keeps a non-zero size to measure even when the parent
// momentarily resolves to 0 (a tab/panel reveal before layout settles). Recharts
// 3.x measures through a ResizeObserver, so these tests stub one, drive a
// 0 → positive resize, and assert the radar SVG actually mounts — the assertion
// only passes when the container had real pixels to measure. When radarAxes is
// null the component renders nothing (its parent owns the single "Insufficient
// data" Alert), rather than a fake all-zero radar under a duplicate scrim.

const AXES: RadarAxes = {
  stubbornness: 0.6,
  optimism: 0.4,
  polarity: 0.5,
  certainty: 0.7,
};

const CHART_WIDTH_PX = 480;
const CHART_HEIGHT_PX = 256;

type ResizeCallback = (entries: ResizeObserverEntry[]) => void;

const observers: {
  callback: ResizeCallback;
  targets: Set<Element>;
}[] = [];

class MockResizeObserver {
  callback: ResizeCallback;
  targets = new Set<Element>();

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

// The size every element currently "measures". Recharts reads this via
// getBoundingClientRect; it starts at 0 (the collapsed parent) and only becomes
// positive once a resize is driven through the stubbed observer, so the radar
// SVG genuinely depends on the measurement path rather than a fixed stub.
let currentBox = { width: 0, height: 0 };

// Simulate a layout pass: update the measured box, then notify every observer so
// Recharts' ResponsiveContainer transitions from its initial 0 to a real size.
function flushResize(width: number, height: number) {
  currentBox = { width, height };
  for (const observer of observers) {
    const entries = [...observer.targets].map(
      (target) =>
        ({
          target,
          contentRect: { width, height } as DOMRectReadOnly,
        }) as ResizeObserverEntry
    );
    if (entries.length > 0) {
      observer.callback(entries);
    }
  }
}

describe("JudgeRadarChart (FEA-4149)", () => {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    observers.length = 0;
    currentBox = { width: 0, height: 0 };
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;
    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const { width, height } = currentBox;
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  afterEach(() => {
    cleanup();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    vi.restoreAllMocks();
  });

  test("floors the chart box so a collapsed host still lays out (min-h-40)", () => {
    const { container } = render(
      <JudgeRadarChart promptVersions={[]} radarAxes={AXES} />
    );
    // The ChartContainer box carries the size floor that keeps the host from
    // collapsing to 0×0 (the FEA-3961 fix); without it the raw ResponsiveContainer
    // measured 0 and rendered an invisible chart.
    const chartBox = container.querySelector<HTMLElement>(
      '[data-slot="chart"]'
    );
    expect(chartBox).toBeTruthy();
    expect(chartBox?.className).toContain("min-h-40");
  });

  test("mounts the radar SVG only once the container measures a positive size", async () => {
    const { container } = render(
      <JudgeRadarChart promptVersions={[]} radarAxes={AXES} />
    );

    // While the host measures 0 (a tab/panel reveal before layout settles),
    // Recharts holds at its initial 0×0 and mounts no radar.
    flushResize(0, 0);
    expect(container.querySelector(".recharts-radar-polygon")).toBeNull();

    // Once the box resolves to a positive size, the radar lays out and mounts.
    flushResize(CHART_WIDTH_PX, CHART_HEIGHT_PX);
    await waitFor(() => {
      expect(container.querySelector(".recharts-radar-polygon")).toBeTruthy();
    });
  });

  test("renders nothing when there is no data (parent owns the Alert)", () => {
    const { container } = render(
      <JudgeRadarChart promptVersions={[]} radarAxes={null} />
    );
    // No duplicate "Insufficient data" scrim and no fake all-zero radar.
    expect(container.querySelector(".recharts-radar-polygon")).toBeNull();
    expect(container.textContent).not.toContain("Insufficient data");
  });
});
