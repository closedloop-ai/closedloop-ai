import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../mock-detail";
import {
  SessionTimeline,
  type SessionTimelineGrouping,
  type TimelineJumpHandler,
} from "../session-timeline";
import {
  buildCostEvent,
  buildMarker,
  buildTestSessionDetail,
  buildTurn,
} from "./support/session-detail-builders";
import {
  axisLabels,
  barGrid,
  bucketAt,
  cursorLeft,
  markerGrid,
  measurePlot,
  stubLayoutRect,
} from "./support/timeline-queries";

const PLOT_WIDTH_PX = 240;
const FIVE_MINUTE_SCALE = "5m timeline scale";
const GRID_COLUMNS = "repeat(25, minmax(0, 1fr))";

const tracedDetail = buildTestSessionDetail({
  trace: [
    buildTurn({ id: "a", timeLabel: "0:00" }),
    buildTurn({ id: "b", timeLabel: "0:20" }),
    buildTurn({ id: "c", timeLabel: "0:40" }),
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderTimeline(
  detail: SessionDetail,
  activeMinutes: number,
  defaultGrouping?: SessionTimelineGrouping
) {
  const onJump = vi.fn<TimelineJumpHandler>();
  const view = render(
    <SessionTimeline
      activeMinutes={activeMinutes}
      defaultGrouping={defaultGrouping}
      detail={detail}
      onJump={onJump}
    />
  );
  const renderAt = (nextMinutes: number, nextOnJump = onJump) =>
    view.rerender(
      <SessionTimeline
        activeMinutes={nextMinutes}
        detail={detail}
        onJump={nextOnJump}
      />
    );
  return { onJump, renderAt };
}

async function switchToFiveMinutes() {
  await userEvent
    .setup()
    .click(screen.getByRole("radio", { name: FIVE_MINUTE_SCALE }));
}

function legendSwatches(name: string): string[] {
  return within(screen.getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((item) => {
      const swatch = item.firstElementChild;
      return swatch instanceof HTMLElement ? swatch.style.background : "";
    });
}

function clickAndPin() {
  stubLayoutRect(250);
  const view = renderTimeline(tracedDetail, 0);
  fireEvent.click(bucketAt(2), { clientX: 125 });
  return view;
}

describe("SessionTimeline scrolled window", () => {
  const scrolledDetail = buildTestSessionDetail({
    costEvents: [buildCostEvent({ atMinutes: 92, cIn: 1 })],
    durationMinutes: 300,
    timelineMarkers: [buildMarker({ atMinutes: 92, kind: "prompt" })],
    trace: [
      buildTurn({
        blocks: [
          { rows: [{ label: "Read" }], summary: "1 tool", type: "tools" },
          { spans: ["one"], type: "p" },
          { spans: ["two"], type: "p" },
        ],
        timeLabel: "1:32",
      }),
    ],
  });

  it("places costs, turns, markers and the cursor relative to the window start", async () => {
    renderTimeline(scrolledDetail, 152.5);
    await switchToFiveMinutes();

    expect(bucketAt(0)).toHaveAccessibleName(
      "Jump to timeline bucket 10:30 AM–10:35 AM, $1.00"
    );
    fireEvent.focus(bucketAt(0));
    const tooltip = await screen.findByRole("tooltip");
    expect(
      within(tooltip).getByText(
        "1 events · 1 tool calls · Click anywhere in this interval to navigate"
      )
    ).toBeInTheDocument();
    expect(
      markerGrid().firstElementChild?.querySelector(
        "[data-event-group='human']"
      )
    ).not.toBeNull();
    expect(cursorLeft()).toBe("50%");
  });

  it("slides both strips by the fractional window offset", async () => {
    renderTimeline(scrolledDetail, 152.5);
    await switchToFiveMinutes();

    for (const strip of [barGrid(), markerGrid()]) {
      expect(strip.style.transform).toBe("translate3d(-2%, 0, 0)");
      expect(strip.style.width).toBe("104.16666666666667%");
      expect(strip.style.gridTemplateColumns).toBe(GRID_COLUMNS);
    }
  });

  it("keeps three slots in every marker cell, empty or not", async () => {
    renderTimeline(scrolledDetail, 152.5);
    await switchToFiveMinutes();

    const cells = [...markerGrid().children];
    expect(cells).toHaveLength(25);
    expect(cells.every((cell) => cell.childElementCount === 3)).toBe(true);
    expect(cells[1]?.querySelectorAll("[aria-hidden='true']")).toHaveLength(3);
  });

  it("measures day context by the visible span, not the window position", async () => {
    renderTimeline(
      buildTestSessionDetail({
        durationMinutes: 1000,
        timelineStartMinutes: 0,
      }),
      900
    );
    await switchToFiveMinutes();

    expect(axisLabels()).toEqual(["2:00 PM", "4:00 PM"]);
  });
});

describe("SessionTimeline cost scale", () => {
  it("sums every token type per bucket for the peak and scales bars to it", () => {
    renderTimeline(
      buildTestSessionDetail({
        costEvents: [
          buildCostEvent({ atMinutes: 1, cCache: 3, cIn: 1, cOut: 2 }),
          buildCostEvent({ atMinutes: 3, cIn: 1 }),
        ],
      }),
      0
    );

    expect(
      screen.getByRole("button", { name: "Peak 5m bucket $7.00" })
    ).toBeInTheDocument();
    const bar = bucketAt(0).children[1];
    expect(bar instanceof HTMLElement ? bar.style.height : "").toBe("100%");
  });
});

describe("SessionTimeline legend colors", () => {
  it("colors the token-type legend cache, output, input", () => {
    renderTimeline(tracedDetail, 0);

    expect(legendSwatches("Token Type legend")).toEqual([
      "var(--chart-3)",
      "var(--chart-2)",
      "var(--chart-1)",
    ]);
  });

  it("colors each activity phase", () => {
    renderTimeline(
      buildTestSessionDetail({
        costEvents: [
          buildCostEvent({ phase: "Verification" }),
          buildCostEvent({ phase: "Implementation" }),
          buildCostEvent({ phase: "Research" }),
          buildCostEvent({ phase: "Planning" }),
        ],
      }),
      0,
      "activity-phase"
    );

    expect(legendSwatches("Activity phase legend")).toEqual([
      "var(--chart-4)",
      "var(--chart-2)",
      "var(--chart-1)",
      "var(--chart-3)",
    ]);
  });
});

describe("SessionTimeline axis date parsing", () => {
  it.each(["2026-09-30T00:00", "x2026-09-30"])(
    "falls back to day numbers for the non-ISO date %s",
    (timelineStartDate) => {
      renderTimeline(
        buildTestSessionDetail({
          timelineStartDate,
          timelineStartMinutes: 23 * 60 + 30,
        }),
        0
      );

      expect(axisLabels()).toEqual(["Day 1 · 11:30 PM", "Day 2 · 1:30 AM"]);
    }
  );
});

describe("SessionTimeline cursor boundaries", () => {
  it("shows the cursor on the last column edge", () => {
    renderTimeline(buildTestSessionDetail({ durationMinutes: 120 }), 120);

    expect(cursorLeft()).toBe("100%");
  });

  it("settles a chart click once playback is within half a minute", () => {
    const { renderAt } = clickAndPin();

    renderAt(13);
    renderAt(30);

    expect(cursorLeft()).toBe("25%");
  });

  it("keeps a settled click pinned until playback moves more than a minute away", () => {
    const { renderAt } = clickAndPin();
    renderAt(12.5);

    renderAt(13.5);

    expect(cursorLeft()).toBe("50%");
  });

  it("measures the cursor from the plot's left edge", () => {
    stubLayoutRect(250, 50);
    const { onJump } = renderTimeline(tracedDetail, 0);

    fireEvent.click(bucketAt(2), { clientX: 175 });

    expect(onJump).toHaveBeenCalledWith(1, 12.5);
    expect(cursorLeft()).toBe("50%");
  });

  it("places a marker jump by minute even when the plot is measured", () => {
    stubLayoutRect(250, 50);
    renderTimeline(
      buildTestSessionDetail({
        timelineMarkers: [buildMarker({ atMinutes: 15 })],
      }),
      0
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to Commits & PRs" })
    );

    expect(cursorLeft()).toBe("12.5%");
  });
});

describe("SessionTimeline wheel boundaries", () => {
  it("keeps the earlier trace row when a wheel lands halfway between two", () => {
    const { onJump } = renderTimeline(
      buildTestSessionDetail({
        trace: [
          buildTurn({ id: "a", timeLabel: "0:10" }),
          buildTurn({ id: "b", timeLabel: "0:20" }),
        ],
      }),
      10
    );

    fireEvent.wheel(measurePlot(PLOT_WIDTH_PX), { deltaX: 10 });

    expect(onJump).toHaveBeenCalledWith(0, 15, "instant");
  });

  it("reads a shifted wheel of equal axes from the horizontal delta", () => {
    const { onJump } = renderTimeline(tracedDetail, 10);

    fireEvent.wheel(measurePlot(PLOT_WIDTH_PX), {
      deltaX: 24,
      deltaY: -24,
      shiftKey: true,
    });

    expect(onJump.mock.calls).toEqual([[1, 22, "instant"]]);
  });

  it("treats an unshifted wheel of equal axes as vertical", () => {
    const { onJump } = renderTimeline(tracedDetail, 10);

    expect(
      fireEvent.wheel(measurePlot(PLOT_WIDTH_PX), { deltaX: 24, deltaY: 24 })
    ).toBe(true);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("routes wheels to the latest jump handler only", () => {
    const { onJump, renderAt } = renderTimeline(tracedDetail, 10);
    const nextOnJump = vi.fn<TimelineJumpHandler>();
    renderAt(10, nextOnJump);

    fireEvent.wheel(measurePlot(PLOT_WIDTH_PX), { deltaX: 24 });

    expect(onJump).not.toHaveBeenCalled();
    expect(nextOnJump.mock.calls).toEqual([[1, 22, "instant"]]);
  });
});
