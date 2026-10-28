import type {
  JudgePromptVersion,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JudgeRadarChart } from "../radar-chart";

/**
 * Covers what the sibling `radar-chart.test.tsx` does not: the hovered-axis
 * tooltip (`RadarAxisTooltip`), the version-compare checklist's toggle
 * handler, and the per-version overlay it drives. The sibling file only ever
 * renders with `promptVersions={[]}` and never hovers, so none of that is
 * reachable from it.
 *
 * Recharts schedules its own hit-testing off `event.currentTarget.offsetWidth`
 * / `offsetHeight` (see `getChartPointer` in recharts' `mouseEventsMiddleware`),
 * which jsdom always reports as 0 — real layout never runs. Left unstubbed, a
 * simulated mouse move always resolves to `(0, 0)`, computes no active axis,
 * and the tooltip never activates. Stubbing `offsetWidth`/`offsetHeight`
 * alongside `getBoundingClientRect` (the sibling file's existing stub) lets a
 * `mouseMove` at a known pixel resolve to a real axis, the same way the
 * sibling's resize stub lets the chart lay out at all.
 */

const AXES: RadarAxes = {
  stubbornness: 0.6,
  optimism: 0.4,
  polarity: 0.5,
  certainty: 0.7,
};

const CHART_WIDTH_PX = 480;
const CHART_HEIGHT_PX = 256;

// Pixel coordinates of the four polar-axis vertices for a 480x256 chart laid
// out by ChartContainer's fixed aspect box, confirmed against the rendered
// `<PolarGrid>` line endpoints — PolarAngleAxis starts at the top and runs
// clockwise, so these follow AXIS_LABELS_ORDERED (Stubbornness, Optimism,
// Polarity, Certainty).
const TOP_VERTEX = { clientX: 240, clientY: 30 };
const LEFT_VERTEX = { clientX: 142, clientY: 128 };

const VERSION_1_CHECKBOX_NAME = /v1 \(5 scores\)/i;
const VERSION_2_CHECKBOX_NAME = /v2 \(1 scores\)/i;
const VERSION_3_CHECKBOX_NAME = /v3 \(5 scores\)/i;

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

let currentBox = { width: 0, height: 0 };

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
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return currentBox.width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return currentBox.height;
    },
  });
});

afterEach(() => {
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  vi.restoreAllMocks();
});

async function renderAndLayOut(promptVersions: JudgePromptVersion[]) {
  const view = render(
    <JudgeRadarChart promptVersions={promptVersions} radarAxes={AXES} />
  );
  flushResize(CHART_WIDTH_PX, CHART_HEIGHT_PX);
  await waitFor(() => {
    expect(
      view.container.querySelector(".recharts-radar-polygon")
    ).toBeTruthy();
  });
  return view;
}

async function hover(
  wrapper: HTMLElement,
  point: { clientX: number; clientY: number }
) {
  fireEvent.mouseMove(wrapper, { ...point, bubbles: true });
  // Recharts' mouse-move middleware schedules the hit-test via
  // requestAnimationFrame; two nested rAFs let both the scheduled frame and
  // React's resulting re-render commit before we read the DOM.
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function tooltipWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(
    ".recharts-tooltip-wrapper"
  );
  if (!wrapper) {
    throw new Error("expected a tooltip wrapper to be rendered");
  }
  return wrapper;
}

const PROMPT_VERSION_WITH_DATA: JudgePromptVersion = {
  promptId: "prompt-1",
  version: 1,
  scoreCount: 5,
  mean: 0.8,
  stdDev: 0.1,
  min: 0.5,
  max: 0.95,
  createdAt: "2026-01-01T00:00:00.000Z",
  radarAxes: {
    stubbornness: 0.9,
    optimism: 0.3,
    polarity: 0.2,
    certainty: 0.6,
  },
};

const PROMPT_VERSION_WITHOUT_DATA: JudgePromptVersion = {
  promptId: "prompt-2",
  version: 2,
  scoreCount: 1,
  mean: 0.5,
  stdDev: 0,
  min: 0.5,
  max: 0.5,
  createdAt: "2026-01-02T00:00:00.000Z",
  radarAxes: null,
};

describe("the hovered-axis tooltip", () => {
  test("shows the Latest series value for the hovered axis", async () => {
    const { container } = await renderAndLayOut([]);
    const wrapper = container.querySelector(".recharts-wrapper") as HTMLElement;

    await hover(wrapper, TOP_VERTEX);

    const tooltip = tooltipWrapper(container);
    expect(tooltip.textContent).toContain("Stubbornness");
    expect(tooltip.textContent).toContain("60%");
  });

  test("adds a selected version's row alongside Latest", async () => {
    const { container } = await renderAndLayOut([PROMPT_VERSION_WITH_DATA]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: VERSION_1_CHECKBOX_NAME })
    );
    const wrapper = container.querySelector(".recharts-wrapper") as HTMLElement;

    await hover(wrapper, TOP_VERTEX);

    const tooltip = tooltipWrapper(container);
    expect(tooltip.textContent).toContain("Latest");
    expect(tooltip.textContent).toContain("60%");
    expect(tooltip.textContent).toContain("v1");
    // PROMPT_VERSION_WITH_DATA.radarAxes.stubbornness === 0.9
    expect(tooltip.textContent).toContain("90%");
  });

  test("omits a selected version's row when it has no radar data yet", async () => {
    const { container } = await renderAndLayOut([PROMPT_VERSION_WITHOUT_DATA]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: VERSION_2_CHECKBOX_NAME })
    );
    const wrapper = container.querySelector(".recharts-wrapper") as HTMLElement;

    await hover(wrapper, TOP_VERTEX);

    const tooltip = tooltipWrapper(container);
    expect(tooltip.textContent).toContain("Latest");
    // A version with no radar data contributes no `v2` chart-data key at all,
    // so the tooltip's per-version row is skipped rather than showing a
    // fabricated 0%.
    expect(tooltip.textContent).not.toContain("v2");
  });

  test("removes a version's row again once its checkbox is unchecked", async () => {
    const { container } = await renderAndLayOut([PROMPT_VERSION_WITH_DATA]);
    const checkbox = screen.getByRole("checkbox", {
      name: VERSION_1_CHECKBOX_NAME,
    });
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    const wrapper = container.querySelector(".recharts-wrapper") as HTMLElement;

    await hover(wrapper, TOP_VERTEX);

    const tooltip = tooltipWrapper(container);
    expect(tooltip.textContent).toContain("Latest");
    expect(tooltip.textContent).not.toContain("v1");
    // Only the "Latest" series overlay remains once the version is deselected.
    expect(container.querySelectorAll(".recharts-radar-polygon")).toHaveLength(
      1
    );
  });

  // Pins current behavior, and it looks wrong: `RadarAxes` types every axis
  // as a required `number`, so `axes[key] ?? 0` at `chartData` construction
  // can never fall back to 0 through a type-checked call site. But
  // `promptVersions` is API-fetched data crossing a process boundary — the
  // type does not survive the wire — and the repo's cross-repo compatibility
  // rule treats an incomplete payload there as reachable, not hypothetical.
  // This constructs exactly that: a version-skewed `radarAxes` missing one
  // key, verifying it degrades to a plotted (and tooltip-rendered) 0% for
  // that axis alone, rather than `undefined` or a dropped row.
  test("degrades a version-skewed axis missing from radarAxes to 0%, not a dropped row", async () => {
    const skewedRadarAxes = {
      stubbornness: 0.9,
      optimism: 0.3,
      polarity: 0.2,
      // `certainty` omitted — simulates an older/partial payload shape.
    } as unknown as RadarAxes;
    const skewedVersion: JudgePromptVersion = {
      ...PROMPT_VERSION_WITH_DATA,
      promptId: "prompt-3",
      version: 3,
      radarAxes: skewedRadarAxes,
    };
    const { container } = await renderAndLayOut([skewedVersion]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: VERSION_3_CHECKBOX_NAME })
    );
    const wrapper = container.querySelector(".recharts-wrapper") as HTMLElement;

    await hover(wrapper, LEFT_VERTEX);

    const tooltip = tooltipWrapper(container);
    expect(tooltip.textContent).toContain("Certainty");
    expect(tooltip.textContent).toContain("v3");
    expect(tooltip.textContent).toContain("0%");
  });
});
