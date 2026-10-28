import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../mock-detail";
import { SessionTimeline } from "../session-timeline";
import {
  buildMarker,
  buildTestSessionDetail,
  buildTurn,
} from "./support/session-detail-builders";
import {
  axisLabels,
  bucketAt,
  cursorLeft,
  measurePlot as measurePlotWidth,
  plotElement,
  stubLayoutRect,
} from "./support/timeline-queries";

const PLOT_WIDTH_PX = 240;

const tracedDetail = buildTestSessionDetail({
  trace: [
    buildTurn({ id: "a", timeLabel: "0:00" }),
    buildTurn({ id: "b", timeLabel: "0:20" }),
    buildTurn({ id: "c", timeLabel: "0:40" }),
  ],
});

function measurePlot(): HTMLElement {
  return measurePlotWidth(PLOT_WIDTH_PX);
}

function axisStart(): string {
  return axisLabels()[0] ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderTimeline(detail: SessionDetail, activeMinutes: number) {
  const onJump = vi.fn();
  const view = render(
    <SessionTimeline
      activeMinutes={activeMinutes}
      detail={detail}
      onJump={onJump}
    />
  );
  const renderAt = (nextMinutes: number) =>
    view.rerender(
      <SessionTimeline
        activeMinutes={nextMinutes}
        detail={detail}
        onJump={onJump}
      />
    );
  return { onJump, renderAt };
}

describe("SessionTimeline chart navigation", () => {
  it("jumps to the trace row nearest the clicked minute and pins the cursor there", () => {
    stubLayoutRect(250);
    const { onJump } = renderTimeline(tracedDetail, 0);
    expect(cursorLeft()).toBe("0%");

    fireEvent.click(bucketAt(2), { clientX: 125 });

    expect(onJump.mock.calls).toEqual([[1, 12.5]]);
    expect(cursorLeft()).toBe("50%");
  });

  it("keeps the cursor pinned until playback settles on the target, then releases it", () => {
    stubLayoutRect(250);
    const { renderAt } = renderTimeline(tracedDetail, 0);
    fireEvent.click(bucketAt(2), { clientX: 125 });

    renderAt(30);
    expect(cursorLeft()).toBe("50%");
    renderAt(12.5);
    expect(cursorLeft()).toBe("50%");
    renderAt(30);
    expect(cursorLeft()).toBe("25%");
  });

  it("releases the pinned cursor when the scale changes", async () => {
    stubLayoutRect(250);
    const user = userEvent.setup();
    const { renderAt } = renderTimeline(tracedDetail, 0);
    fireEvent.click(bucketAt(2), { clientX: 125 });
    renderAt(36);
    expect(cursorLeft()).toBe("50%");

    await user.click(screen.getByRole("radio", { name: "15m timeline scale" }));

    expect(cursorLeft()).toBe("10%");
  });

  it("moves the cursor without jumping when the trace is empty", () => {
    stubLayoutRect(250);
    const { onJump } = renderTimeline(buildTestSessionDetail(), 0);

    fireEvent.click(bucketAt(2), { clientX: 125 });

    expect(onJump).not.toHaveBeenCalled();
    expect(cursorLeft()).toBe("50%");
  });

  it("places the cursor by minute when the plot has no measured width", () => {
    const { onJump } = renderTimeline(tracedDetail, 0);

    fireEvent.click(bucketAt(3), { clientX: 125 });

    expect(onJump).toHaveBeenCalledWith(1, 17.5);
    expect(cursorLeft()).toBe("14.583333333333334%");
  });

  it("holds the clock window still while playback catches up to a chart click", async () => {
    const user = userEvent.setup();
    const detail = buildTestSessionDetail({ durationMinutes: 300 });
    const { renderAt } = renderTimeline(detail, 150);
    await user.click(screen.getByRole("radio", { name: "5m timeline scale" }));
    expect(axisStart()).toBe("10:30 AM");

    fireEvent.click(bucketAt(0));
    renderAt(200);
    expect(axisStart()).toBe("10:30 AM");

    renderAt(92.5);
    renderAt(200);
    expect(axisStart()).toBe("11:20 AM");
  });

  it("clamps the playback cursor to the session bounds", () => {
    const { renderAt } = renderTimeline(tracedDetail, 90);
    expect(cursorLeft()).toBe("50%");

    renderAt(-10);
    expect(cursorLeft()).toBe("0%");
  });

  it("hides the cursor when a marker target falls past the last full column", () => {
    const { onJump } = renderTimeline(
      buildTestSessionDetail({
        durationMinutes: 120,
        timelineMarkers: [buildMarker({ atMinutes: 120, traceRow: 4 })],
        timelineStartMinutes: 9 * 60 + 3,
      }),
      0
    );
    expect(cursorLeft()).toBe("2.5%");

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to Commits & PRs" })
    );

    expect(onJump).toHaveBeenCalledWith(4, 120, undefined);
    expect(cursorLeft()).toBeNull();
  });
});

describe("SessionTimeline wheel scrubbing", () => {
  it("ignores vertical wheels, empty horizontal wheels and an unmeasured plot", () => {
    const { onJump } = renderTimeline(tracedDetail, 10);
    const plot = plotElement();

    expect(fireEvent.wheel(plot, { deltaX: 24 })).toBe(true);
    measurePlot();
    expect(fireEvent.wheel(plot, { deltaY: 100 })).toBe(true);
    expect(fireEvent.wheel(plot, { deltaX: 10, deltaY: 50 })).toBe(true);
    expect(fireEvent.wheel(plot, { shiftKey: true })).toBe(true);

    expect(onJump).not.toHaveBeenCalled();
  });

  it.each([
    ["pixel", { deltaX: 24 }],
    ["line", { deltaMode: 1, deltaX: 1.5 }],
    ["page", { deltaMode: 2, deltaX: 0.1 }],
    ["shifted vertical", { deltaY: 24, shiftKey: true }],
    ["shifted horizontal", { deltaX: 24, deltaY: 5, shiftKey: true }],
  ])("scrubs a %s wheel by the plot width's share of the window", (_, init) => {
    const { onJump } = renderTimeline(tracedDetail, 10);
    const plot = measurePlot();

    expect(fireEvent.wheel(plot, init)).toBe(false);

    expect(onJump.mock.calls).toEqual([[1, 22, "instant"]]);
  });

  it("accumulates wheel deltas and restarts from a new playback position", () => {
    const { onJump, renderAt } = renderTimeline(tracedDetail, 10);
    const plot = measurePlot();

    fireEvent.wheel(plot, { deltaX: 24 });
    fireEvent.wheel(plot, { deltaX: 24 });
    renderAt(40);
    fireEvent.wheel(plot, { deltaX: 24 });

    expect(onJump.mock.calls).toEqual([
      [1, 22, "instant"],
      [2, 34, "instant"],
      [2, 52, "instant"],
    ]);
  });

  it("clamps at both ends of the session and stops jumping at the edge", () => {
    const { onJump, renderAt } = renderTimeline(tracedDetail, 10);
    const plot = measurePlot();

    expect(fireEvent.wheel(plot, { deltaX: 100_000 })).toBe(false);
    expect(fireEvent.wheel(plot, { deltaX: 24 })).toBe(false);
    renderAt(0);
    expect(fireEvent.wheel(plot, { deltaX: -24 })).toBe(false);

    expect(onJump.mock.calls).toEqual([[2, 60, "instant"]]);
  });

  it("consumes the wheel without jumping when the trace is empty", () => {
    const { onJump } = renderTimeline(buildTestSessionDetail(), 10);

    expect(fireEvent.wheel(measurePlot(), { deltaX: 24 })).toBe(false);

    expect(onJump).not.toHaveBeenCalled();
  });

  it("releases a pinned chart click back to playback", () => {
    stubLayoutRect(250);
    const { renderAt } = renderTimeline(tracedDetail, 0);
    fireEvent.click(bucketAt(2), { clientX: 125 });
    renderAt(30);
    expect(cursorLeft()).toBe("50%");

    fireEvent.wheel(measurePlot(), { deltaX: 24 });

    expect(cursorLeft()).toBe("25%");
  });
});
