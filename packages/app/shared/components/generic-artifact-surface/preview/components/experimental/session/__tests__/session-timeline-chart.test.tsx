import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../mock-detail";
import {
  SessionTimeline,
  type SessionTimelineGrouping,
} from "../session-timeline";
import { TimelineScale } from "../timeline-model";
import {
  buildCostEvent,
  buildMarker,
  buildTestSessionDetail,
  buildTurn,
  TEST_OWNER_NAME,
} from "./support/session-detail-builders";
import {
  axisLabels,
  bucketAt,
  bucketButtons,
  elementAt,
} from "./support/timeline-queries";

const TOKEN_TYPE_LEGEND = "Token Type legend";
const DOT_NAME = /^Jump to (first of \d+ )?(Human|Commits|Failures)/;
const SLIDER_NAME = "Session time position";
const PEAK_TOOLTIP = /Highest-cost 5m interval across the full session/;

const chartDetail = buildTestSessionDetail({
  costEvents: [
    buildCostEvent({
      actorName: "Ana",
      atMinutes: 2,
      cIn: 1,
      model: "model-b",
      phase: "Research",
    }),
    buildCostEvent({
      atMinutes: 3,
      cOut: 0.5,
      model: "model-a",
      phase: "Planning",
    }),
    buildCostEvent({ atMinutes: 400, cCache: 7, model: "model-a" }),
  ],
  timelineMarkers: [
    buildMarker({ atMinutes: 1, kind: "prompt", traceRow: 0 }),
    buildMarker({ atMinutes: 2, kind: "commit", traceRow: 0 }),
    buildMarker({ atMinutes: 3, kind: "pr", traceRow: 0 }),
    buildMarker({ atMinutes: 4, kind: "fail", traceRow: 1 }),
    buildMarker({ atMinutes: 7, kind: "frust", traceRow: 1 }),
    buildMarker({ atMinutes: 6, kind: "limit", traceRow: 1 }),
    buildMarker({ atMinutes: 100, kind: "prompt", traceRow: 2 }),
    buildMarker({ atMinutes: 300, kind: "commit", traceRow: 2 }),
  ],
  trace: [
    buildTurn({
      blocks: [{ rows: [{ label: "Read" }], summary: "1 tool", type: "tools" }],
      id: "t0",
      timeLabel: "0:01",
    }),
    buildTurn({ id: "t1", kind: "idle", timeLabel: "0:04" }),
    buildTurn({ id: "t2", timeLabel: "0:30" }),
    buildTurn({ id: "t3", timeLabel: "9:00" }),
  ],
});

function renderTimeline(
  detail: SessionDetail = chartDetail,
  props: {
    activeMinutes?: number;
    defaultGrouping?: SessionTimelineGrouping;
    title?: string;
  } = {}
) {
  const onJump = vi.fn();
  const view = render(
    <SessionTimeline
      activeMinutes={props.activeMinutes ?? 0}
      defaultGrouping={props.defaultGrouping}
      detail={detail}
      onJump={onJump}
      title={props.title}
    />
  );
  return { ...view, onJump };
}

function legendLabels(name: string): string[] {
  return within(screen.getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

describe("SessionTimeline header and scale", () => {
  it("summarizes cost, peak bucket, tokens and duration under the default title", () => {
    renderTimeline();

    expect(
      screen.getByRole("heading", { name: "Session Costs Over Time" })
    ).toBeInTheDocument();
    expect(screen.getByText("$1.00").parentElement).toHaveTextContent(
      "$1.00 cost"
    );
    expect(
      screen.getByRole("button", { name: "Peak 5m bucket $7.00" })
    ).toBeInTheDocument();
    expect(screen.getByText("165k tokens")).toBeInTheDocument();
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
  });

  it("uses a caller title and reports a zero peak when there are no costs", () => {
    renderTimeline(buildTestSessionDetail(), { title: "Contribution costs" });

    expect(
      screen.getByRole("heading", { name: "Contribution costs" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Peak 5m bucket $0.00" })
    ).toBeInTheDocument();
    expect(bucketButtons()).toHaveLength(25);
    expect(
      bucketButtons().every((button) =>
        button.getAttribute("aria-label")?.endsWith(", no cost")
      )
    ).toBe(true);
  });

  it("explains the peak bucket in a tooltip", async () => {
    renderTimeline();

    fireEvent.focus(
      screen.getByRole("button", { name: "Peak 5m bucket $7.00" })
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(PEAK_TOOLTIP);
  });

  it.each([
    [120, TimelineScale.FiveMinutes],
    [121, TimelineScale.FifteenMinutes],
    [360, TimelineScale.FifteenMinutes],
    [1440, TimelineScale.OneHour],
    [1441, TimelineScale.TwelveHours],
  ])(
    "defaults a %d-minute session to the %s scale",
    (durationMinutes, scale) => {
      renderTimeline(buildTestSessionDetail({ durationMinutes }));

      expect(
        screen.getByRole("radio", { name: `${scale} timeline scale` })
      ).toBeChecked();
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: `Peak ${scale} bucket $0.00` })
      ).toBeInTheDocument();
    }
  );

  it("rebuckets on a new scale and ignores re-clicking the active scale", async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(screen.getByRole("radio", { name: "5m timeline scale" }));
    expect(
      screen.getByRole("radio", { name: "5m timeline scale" })
    ).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "15m timeline scale" }));

    expect(
      screen.getByRole("radio", { name: "15m timeline scale" })
    ).toBeChecked();
    expect(bucketButtons()[0]).toHaveAccessibleName(
      `Jump to timeline bucket 9:00 AM–9:15 AM, ${formatCostPrecise(1.5)}`
    );
    expect(
      screen.getByRole("button", { name: "Peak 15m bucket $7.00" })
    ).toBeInTheDocument();
  });
});

describe("SessionTimeline legend and grouping", () => {
  it.each<[SessionTimelineGrouping, string, string[]]>([
    ["token-type", TOKEN_TYPE_LEGEND, ["Cache", "Output", "Input"]],
    ["model", "Model legend", ["model-a", "model-b"]],
    [
      "activity-phase",
      "Activity phase legend",
      ["Planning", "Research", "Implementation"],
    ],
    ["actor", "Actor legend", ["Ana", TEST_OWNER_NAME]],
  ])("lists the %s legend", (grouping, name, labels) => {
    renderTimeline(chartDetail, { defaultGrouping: grouping });

    expect(legendLabels(name)).toEqual(labels);
  });

  it("colors models by sorted order and cycles after five", () => {
    const models = ["m6", "m1", "m2", "m3", "m4", "m5"];
    renderTimeline(
      buildTestSessionDetail({
        costEvents: models.map((model) => buildCostEvent({ cIn: 1, model })),
      }),
      { defaultGrouping: "model" }
    );

    const swatches = within(screen.getByRole("list", { name: "Model legend" }))
      .getAllByRole("listitem")
      .map((item) => {
        const swatch = item.firstElementChild;
        return swatch instanceof HTMLElement ? swatch.style.background : "";
      });
    expect(legendLabels("Model legend")).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    expect(swatches[0]).toBe("var(--chart-1)");
    expect(swatches[4]).toBe("var(--chart-5)");
    expect(swatches[5]).toBe("var(--chart-1)");
  });

  it("regroups the legend from the Group by select", async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(
      screen.getByRole("combobox", { name: "Group stacked bars by" })
    );
    await user.click(await screen.findByRole("option", { name: "Model" }));

    expect(legendLabels("Model legend")).toEqual(["model-a", "model-b"]);
    expect(
      screen.queryByRole("list", { name: TOKEN_TYPE_LEGEND })
    ).not.toBeInTheDocument();
  });
});

describe("SessionTimeline buckets and markers", () => {
  it("aggregates in-window costs and trace turns into their clock buckets", async () => {
    renderTimeline();

    expect(bucketAt(0)).toHaveAccessibleName(
      `Jump to timeline bucket 9:00 AM–9:05 AM, ${formatCostPrecise(1.5)}`
    );
    expect(bucketAt(1)).toHaveAccessibleName(
      "Jump to timeline bucket 9:05 AM–9:10 AM, no cost"
    );
    fireEvent.focus(bucketAt(0));
    // pins current behavior; looks odd because the copy pluralizes "tool calls" for a count of 1
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "2 events · 1 tool calls"
    );
  });

  it("offsets costs, markers and bucket bounds by an unaligned session start", () => {
    const { onJump } = renderTimeline(
      buildTestSessionDetail({
        costEvents: [
          buildCostEvent({ atMinutes: 1, cIn: 1 }),
          buildCostEvent({ atMinutes: 3, cIn: 1 }),
        ],
        timelineMarkers: [buildMarker({ atMinutes: 3 })],
        timelineStartMinutes: 9 * 60 + 3,
        trace: [buildTurn({ timeLabel: "0:01" })],
      })
    );

    const buckets = bucketButtons();
    expect(buckets[0]).toHaveAccessibleName(
      `Jump to timeline bucket 9:00 AM–9:05 AM, ${formatCostPrecise(1)}`
    );
    expect(buckets[1]).toHaveAccessibleName(
      `Jump to timeline bucket 9:05 AM–9:10 AM, ${formatCostPrecise(1)}`
    );
    expect(
      screen.getByRole("button", { name: "Peak 5m bucket $1.00" })
    ).toBeInTheDocument();
    const dot = screen.getByRole("button", { name: "Jump to Commits & PRs" });
    const cell = dot.parentElement;
    expect(
      cell?.parentElement ? [...cell.parentElement.children].indexOf(cell) : -1
    ).toBe(1);

    fireEvent.click(elementAt(buckets, 0));
    fireEvent.click(elementAt(buckets, 24));
    expect(onJump.mock.calls).toEqual([
      [0, 1],
      [0, 60],
    ]);
  });

  it("prices buckets when the trace has no turns", () => {
    const { onJump } = renderTimeline(
      buildTestSessionDetail({
        costEvents: [buildCostEvent({ atMinutes: 7, cOut: 2 })],
      })
    );

    expect(bucketButtons()[1]).toHaveAccessibleName(
      `Jump to timeline bucket 9:05 AM–9:10 AM, ${formatCostPrecise(2)}`
    );
    fireEvent.click(bucketAt(1));
    expect(onJump).not.toHaveBeenCalled();
  });

  it.each<[SessionTimelineGrouping, string[][]]>([
    [
      "token-type",
      [
        ["token type", "cost"],
        ["Cache", "$3.00"],
        ["Output", "$2.25"],
        ["Input", "$1.50"],
      ],
    ],
    [
      "model",
      [
        ["model", "cost"],
        ["model-a", "$6.50"],
        ["model-b", "$0.25"],
      ],
    ],
    [
      "activity-phase",
      [
        ["activity phase", "cost"],
        ["Planning", "$6.50"],
        ["Research", "$0.25"],
      ],
    ],
    [
      "actor",
      [
        ["actor", "cost"],
        [TEST_OWNER_NAME, "$6.00"],
        ["Ana", "$0.75"],
      ],
    ],
  ])(
    "sums same-bucket costs per %s in the bar tooltip",
    async (grouping, rows) => {
      renderTimeline(
        buildTestSessionDetail({
          costEvents: [
            buildCostEvent({
              atMinutes: 1,
              cCache: 3,
              cIn: 1,
              cOut: 2,
              phase: "Planning",
            }),
            buildCostEvent({
              actorName: "Ana",
              atMinutes: 2,
              cIn: 0.5,
              phase: "Planning",
            }),
            buildCostEvent({
              actorName: "Ana",
              atMinutes: 3,
              cOut: 0.25,
              model: "model-b",
              phase: "Research",
            }),
          ],
        }),
        { defaultGrouping: grouping }
      );

      fireEvent.focus(bucketAt(0));
      const tooltip = await screen.findByRole("tooltip");

      expect(
        within(tooltip)
          .getAllByRole("row")
          .map((row) =>
            [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
          )
      ).toEqual(rows);
    }
  );

  it("groups in-window markers into human, delivery and problem dots", () => {
    renderTimeline();

    expect(
      screen
        .getAllByRole("button", { name: DOT_NAME })
        .map((dot) => [
          dot.getAttribute("aria-label"),
          dot.getAttribute("data-event-group"),
        ])
    ).toEqual([
      ["Jump to Human steering", "human"],
      ["Jump to first of 2 Commits & PRs events", "delivery"],
      ["Jump to Failures, limits & corrections", "problem"],
      ["Jump to first of 2 Failures, limits & corrections events", "problem"],
      ["Jump to Human steering", "human"],
    ]);
  });

  it("jumps from a marker without a scroll behavior and clamps it to the session", () => {
    const { onJump } = renderTimeline();
    const dots = screen.getAllByRole("button", { name: DOT_NAME });

    fireEvent.click(elementAt(dots, 0));
    fireEvent.click(elementAt(dots, 4));

    expect(onJump.mock.calls).toEqual([
      [0, 1, undefined],
      [2, 60, undefined],
    ]);
  });
});

describe("SessionTimeline axis labels", () => {
  it("shows plain clock labels for a same-day window", () => {
    renderTimeline();

    expect(axisLabels()).toEqual(["9:00 AM", "11:00 AM"]);
  });

  it("prefixes day numbers when the session crosses midnight without a date", () => {
    renderTimeline(
      buildTestSessionDetail({ timelineStartMinutes: 23 * 60 + 30 })
    );

    expect(axisLabels()).toEqual(["Day 1 · 11:30 PM", "Day 2 · 1:30 AM"]);
  });

  it("prefixes calendar dates across a month boundary", () => {
    renderTimeline(
      buildTestSessionDetail({
        timelineStartDate: "2026-09-30",
        timelineStartMinutes: 23 * 60 + 30,
      })
    );

    expect(axisLabels()).toEqual(["09/30 11:30 PM", "10/01 1:30 AM"]);
  });

  it("ignores a malformed start date and shows day context for a 12h window", () => {
    renderTimeline(
      buildTestSessionDetail({
        durationMinutes: 2000,
        timelineStartDate: "Sept 30",
        timelineStartMinutes: 0,
      })
    );

    expect(axisLabels()).toEqual(["Day 1 · 12:00 AM", "Day 13 · 12:00 AM"]);
  });

  it("shows day context once the visible window spans a full day", () => {
    renderTimeline(
      buildTestSessionDetail({ durationMinutes: 1000, timelineStartMinutes: 0 })
    );

    expect(axisLabels()).toEqual(["Day 1 · 12:00 AM", "Day 2 · 12:00 AM"]);
  });

  it("keeps a same-day date-bearing window clock-only", () => {
    renderTimeline(buildTestSessionDetail({ timelineStartDate: "2026-09-30" }));

    expect(axisLabels()).toEqual(["9:00 AM", "11:00 AM"]);
  });
});

describe("SessionTimeline scrubber", () => {
  const longDetail = buildTestSessionDetail({
    durationMinutes: 300,
    trace: [
      buildTurn({ id: "a", timeLabel: "0:10" }),
      buildTurn({ id: "b", row: 5, timeLabel: "1:40" }),
      buildTurn({ id: "c", timeLabel: "4:00" }),
    ],
  });

  async function showScrubber(detail: SessionDetail, activeMinutes: number) {
    const user = userEvent.setup();
    const view = renderTimeline(detail, { activeMinutes });
    const hiddenAtDefaultScale = screen.queryByRole("slider", {
      name: SLIDER_NAME,
    });
    await user.click(screen.getByRole("radio", { name: "5m timeline scale" }));
    return {
      ...view,
      hiddenAtDefaultScale,
      slider: screen.getByRole("slider", { name: SLIDER_NAME }),
    };
  }

  it("appears only once the session outgrows the 24-column window", async () => {
    const { hiddenAtDefaultScale, slider } = await showScrubber(
      longDetail,
      12.4
    );

    expect(hiddenAtDefaultScale).toBeNull();
    expect(slider).toHaveAttribute("max", "300");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveValue("12");
  });

  it("caps the slider value at the session duration", async () => {
    const { slider } = await showScrubber(longDetail, 900);

    expect(slider).toHaveValue("300");
  });

  it("jumps to the nearest trace row, keeping the earlier row on a tie", async () => {
    const { onJump, slider } = await showScrubber(longDetail, 0);

    fireEvent.change(slider, { target: { value: "90" } });
    fireEvent.change(slider, { target: { value: "55" } });
    fireEvent.change(slider, { target: { value: "230" } });

    expect(onJump.mock.calls).toEqual([
      [5, 90, "instant"],
      [0, 55, "instant"],
      [2, 230, "instant"],
    ]);
  });

  it("jumps to row 0 when the trace is empty", async () => {
    const { onJump, slider } = await showScrubber(
      buildTestSessionDetail({ durationMinutes: 300 }),
      0
    );

    fireEvent.change(slider, { target: { value: "90" } });

    // pins current behavior; looks odd because an empty trace has no row 0 to jump to
    expect(onJump).toHaveBeenCalledWith(0, 90, "instant");
  });

  it("slides the 24-column window with the playback position, clamped at both ends", async () => {
    const { onJump, rerender } = await showScrubber(longDetail, 150);
    const renderAt = (activeMinutes: number) =>
      rerender(
        <SessionTimeline
          activeMinutes={activeMinutes}
          detail={longDetail}
          onJump={onJump}
        />
      );

    expect(axisLabels()).toEqual(["10:30 AM", "12:30 PM"]);
    expect(bucketButtons()[0]).toHaveAccessibleName(
      "Jump to timeline bucket 10:30 AM–10:35 AM, no cost"
    );
    renderAt(5);
    expect(axisLabels()).toEqual(["9:00 AM", "11:00 AM"]);
    renderAt(300);
    expect(axisLabels()).toEqual(["12:00 PM", "2:00 PM"]);
    expect(onJump).not.toHaveBeenCalled();
  });
});
