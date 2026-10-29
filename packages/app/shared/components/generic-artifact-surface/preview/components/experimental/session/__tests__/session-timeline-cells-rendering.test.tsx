import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionActorEntry } from "../session-actor-colors";
import {
  bucketCost,
  CostBarCell,
  clockLabel,
  DOT_GROUP_ORDER,
  MarkerGroupDot,
  type TimelineBucket,
} from "../session-timeline-cells";
import { buildMarker } from "./support/session-detail-builders";

const HOVER_X = "--timeline-hover-x";
const IDLE_COPY = /Agent asleep · scheduled wake-up · no tokens billed/;

const ACTOR: SessionActorEntry = {
  colors: { base: "var(--chart-1)", soft: "soft", strong: "strong" },
  id: "actor-ana",
  initials: "AN",
  name: "Ana Actor",
};

function buildBucket(overrides: Partial<TimelineBucket> = {}): TimelineBucket {
  return {
    atMinutes: 0,
    byActor: {},
    byModel: {},
    byPhase: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    endMinutes: 10,
    key: "5m-540",
    label: "9:00 AM–9:05 AM",
    startMinutes: 0,
    toolStart: 0,
    total: 0,
    traceRow: null,
    ...overrides,
  };
}

function renderCell(
  bucket: TimelineBucket,
  props: Partial<Parameters<typeof CostBarCell>[0]> = {}
) {
  const onJumpAtMinutes = vi.fn();
  const { unmount } = render(
    <CostBarCell
      actorEntries={[ACTOR]}
      bucket={bucket}
      grouping="token-type"
      maxCost={4}
      modelColors={new Map([["model-a", "var(--chart-2)"]])}
      onJumpAtMinutes={onJumpAtMinutes}
      {...props}
    />
  );
  return { button: screen.getByRole("button"), onJumpAtMinutes, unmount };
}

function barOf(button: HTMLElement): HTMLElement {
  const bar = button.children[1];
  if (!(bar instanceof HTMLElement)) {
    throw new Error("cost bar span missing");
  }
  return bar;
}

function segmentHeights(button: HTMLElement): string[] {
  const stack = barOf(button).firstElementChild;
  return stack
    ? [...stack.children].map((segment) =>
        segment instanceof HTMLElement ? segment.style.height : ""
      )
    : [];
}

async function openTooltip(button: HTMLElement): Promise<HTMLElement> {
  fireEvent.focus(button);
  return await screen.findByRole("tooltip");
}

function tooltipRows(tooltip: HTMLElement): string[][] {
  return within(tooltip)
    .getAllByRole("row")
    .map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent ?? "")
    );
}

function swatchColors(tooltip: HTMLElement): string[] {
  return [...tooltip.querySelectorAll("td > span")].map((swatch) =>
    swatch instanceof HTMLElement ? swatch.style.background : ""
  );
}

function eventCountCopy(count: number): string {
  return `${count} events`;
}

function styleOf(element: Element | null | undefined): CSSStyleDeclaration {
  if (!(element instanceof HTMLElement)) {
    throw new Error("styled element missing");
  }
  return element.style;
}

describe("clockLabel", () => {
  it("formats minutes past midnight as a 12-hour clock", () => {
    expect(clockLabel(0)).toBe("12:00 AM");
    expect(clockLabel(9 * 60 + 5)).toBe("9:05 AM");
    expect(clockLabel(11 * 60 + 59)).toBe("11:59 AM");
    expect(clockLabel(12 * 60)).toBe("12:00 PM");
    expect(clockLabel(23 * 60 + 59)).toBe("11:59 PM");
  });

  it("floors fractional minutes and wraps across days in both directions", () => {
    expect(clockLabel(9 * 60 + 5.9)).toBe("9:05 AM");
    expect(clockLabel(1440 + 60)).toBe("1:00 AM");
    expect(clockLabel(-30)).toBe("11:30 PM");
  });
});

describe("bucketCost", () => {
  it("sums input, output and cache cost", () => {
    expect(bucketCost(buildBucket({ cCache: 0.25, cIn: 1, cOut: 2 }))).toBe(
      3.25
    );
  });
});

describe("CostBarCell", () => {
  it("renders an idle bucket as a no-cost hatched bar with the asleep copy", async () => {
    const { button } = renderCell(buildBucket({ toolStart: 2, total: 3 }));

    expect(button).toHaveAccessibleName(
      "Jump to timeline bucket 9:00 AM–9:05 AM, no cost"
    );
    expect(barOf(button).style.height).toBe("7%");
    expect(segmentHeights(button)).toEqual([]);

    const tooltip = await openTooltip(button);
    expect(within(tooltip).getByText(IDLE_COPY)).toBeInTheDocument();
    expect(within(tooltip).queryByRole("table")).not.toBeInTheDocument();
    expect(tooltip).toHaveTextContent(
      "3 events · 2 tool calls · Click anywhere in this interval to navigate"
    );
  });

  it("stacks token-type segments with cost, dropping zero segments", async () => {
    const { button } = renderCell(buildBucket({ cCache: 1, cIn: 3, cOut: 0 }));

    expect(button).toHaveAccessibleName(
      `Jump to timeline bucket 9:00 AM–9:05 AM, ${formatCostPrecise(4)}`
    );
    expect(barOf(button).style.height).toBe("100%");
    expect(segmentHeights(button)).toEqual(["25%", "75%"]);

    const tooltip = await openTooltip(button);
    expect(within(tooltip).queryByText(IDLE_COPY)).not.toBeInTheDocument();
    expect(tooltipRows(tooltip)).toEqual([
      ["token type", "cost"],
      ["Cache", formatCostPrecise(1)],
      ["Input", formatCostPrecise(3)],
    ]);
    expect(swatchColors(tooltip)).toEqual(["var(--chart-3)", "var(--chart-1)"]);
  });

  it("floors a tiny bar at 9% and scales by the square root of cost", () => {
    const { unmount } = renderCell(buildBucket({ cIn: 0.0001 }), {
      maxCost: 100,
    });
    expect(barOf(screen.getByRole("button")).style.height).toBe("9%");
    unmount();

    renderCell(buildBucket({ cIn: 25 }), { maxCost: 100 });
    expect(barOf(screen.getByRole("button")).style.height).toBe("50%");
  });

  it("lists model segments with the model color map and a fallback color", async () => {
    const { button } = renderCell(
      buildBucket({
        byModel: {
          "model-a": { cCache: 0, cIn: 1, cOut: 0 },
          "model-b": { cCache: 1, cIn: 0, cOut: 1 },
          "model-zero": { cCache: 0, cIn: 0, cOut: 0 },
        },
        cIn: 3,
      }),
      { grouping: "model" }
    );

    const tooltip = await openTooltip(button);
    expect(tooltipRows(tooltip)).toEqual([
      ["model", "cost"],
      ["model-a", formatCostPrecise(1)],
      ["model-b", formatCostPrecise(2)],
    ]);
    expect(swatchColors(tooltip)).toEqual(["var(--chart-2)", "var(--chart-1)"]);
  });

  it("lists activity-phase segments in phase colors, keeping zero phases", async () => {
    const { button } = renderCell(
      buildBucket({
        byPhase: { Planning: 1, Research: 0, Verification: 2 },
        cIn: 3,
      }),
      { grouping: "activity-phase" }
    );

    const tooltip = await openTooltip(button);
    // pins current behavior; looks odd because every other grouping drops zero-cost segments
    expect(tooltipRows(tooltip)).toEqual([
      ["activity phase", "cost"],
      ["Planning", formatCostPrecise(1)],
      ["Research", formatCostPrecise(0)],
      ["Verification", formatCostPrecise(2)],
    ]);
    expect(swatchColors(tooltip)).toEqual([
      "var(--chart-4)",
      "var(--chart-2)",
      "var(--chart-3)",
    ]);
  });

  it("colors cache, output and input segments distinctly", async () => {
    const { button } = renderCell(buildBucket({ cCache: 1, cIn: 1, cOut: 1 }));

    expect(swatchColors(await openTooltip(button))).toEqual([
      "var(--chart-3)",
      "var(--chart-2)",
      "var(--chart-1)",
    ]);
  });

  it("colors the implementation phase", async () => {
    const { button } = renderCell(
      buildBucket({ byPhase: { Implementation: 1 }, cIn: 1 }),
      { grouping: "activity-phase" }
    );

    expect(swatchColors(await openTooltip(button))).toEqual(["var(--chart-1)"]);
  });

  it("names known actors and labels an unknown actor as Contributor", async () => {
    const { button } = renderCell(
      buildBucket({
        byActor: { "actor-ana": 1, "actor-gone": 2, "actor-zero": 0 },
        cIn: 3,
      }),
      { grouping: "actor" }
    );

    const tooltip = await openTooltip(button);
    expect(tooltipRows(tooltip)).toEqual([
      ["actor", "cost"],
      ["Ana Actor", formatCostPrecise(1)],
      ["Contributor", formatCostPrecise(2)],
    ]);
    expect(swatchColors(tooltip)).toEqual(["var(--chart-1)", "var(--chart-1)"]);
  });

  it("jumps to the clicked fraction of the interval, clamped to its edges", () => {
    const { button, onJumpAtMinutes } = renderCell(
      buildBucket({ endMinutes: 30, startMinutes: 10 })
    );
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ height: 10, width: 100, x: 50, y: 0 })
    );

    fireEvent.click(button, { clientX: 75 });
    fireEvent.click(button, { clientX: 0 });
    fireEvent.click(button, { clientX: 400 });

    expect(onJumpAtMinutes.mock.calls).toEqual([
      [15, 75],
      [10, 0],
      [30, 400],
    ]);
  });

  it("jumps to the interval midpoint when the bar has no measured width", () => {
    const { button, onJumpAtMinutes } = renderCell(
      buildBucket({ endMinutes: 30, startMinutes: 10 })
    );

    fireEvent.click(button, { clientX: 999 });

    expect(onJumpAtMinutes).toHaveBeenCalledWith(20, 999);
  });

  it("tracks the hover line within the bar and clears it on leave and blur", () => {
    const { button } = renderCell(buildBucket());
    expect(styleOf(button.firstElementChild).left).toBe(
      "var(--timeline-hover-x, 50%)"
    );
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ height: 10, width: 100, x: 10, y: 0 })
    );

    fireEvent.pointerMove(button, { clientX: 30 });
    expect(button.style.getPropertyValue(HOVER_X)).toBe("20px");
    fireEvent.pointerMove(button, { clientX: 500 });
    expect(button.style.getPropertyValue(HOVER_X)).toBe("100px");
    fireEvent.pointerMove(button, { clientX: 0 });
    expect(button.style.getPropertyValue(HOVER_X)).toBe("0px");

    fireEvent.pointerLeave(button);
    expect(button.style.getPropertyValue(HOVER_X)).toBe("");

    fireEvent.pointerMove(button, { clientX: 30 });
    fireEvent.blur(button);
    expect(button.style.getPropertyValue(HOVER_X)).toBe("");
  });
});

describe("MarkerGroupDot", () => {
  it("orders dot groups human, delivery, problem", () => {
    expect(DOT_GROUP_ORDER).toEqual(["human", "delivery", "problem"]);
  });

  it("renders nothing for an empty event list", () => {
    const { container } = render(
      <MarkerGroupDot
        events={[]}
        group="human"
        onJump={vi.fn()}
        timelineStartMinutes={0}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("jumps to a single event and describes it as this event", async () => {
    const onJump = vi.fn();
    render(
      <MarkerGroupDot
        events={[
          buildMarker({
            atMinutes: 5,
            kind: "prompt",
            label: "Asked for a fix",
            traceRow: 3,
          }),
        ]}
        group="human"
        onJump={onJump}
        timelineStartMinutes={9 * 60}
      />
    );

    const dot = screen.getByRole("button", { name: "Jump to Human steering" });
    expect(dot).toHaveAttribute("data-event-count", "1");
    expect(dot).toHaveAttribute("data-event-group", "human");
    fireEvent.click(dot);
    expect(onJump).toHaveBeenCalledWith(3, 5);

    const tooltip = await openTooltip(dot);
    expect(tooltip).toHaveTextContent("9:05 AM");
    expect(tooltip).toHaveTextContent("Asked for a fix");
    expect(tooltip).toHaveTextContent(
      "Click the dot to jump to this in the trace"
    );
    expect(tooltip).not.toHaveTextContent(eventCountCopy(1));
  });

  it("jumps to the earliest of several events and counts them", async () => {
    const onJump = vi.fn();
    render(
      <MarkerGroupDot
        events={[
          buildMarker({
            atMinutes: 40,
            kind: "pr",
            label: "Opened PR",
            traceRow: 9,
          }),
          buildMarker({
            atMinutes: 12,
            kind: "commit",
            label: "First commit",
            traceRow: 4,
          }),
        ]}
        group="delivery"
        onJump={onJump}
        timelineStartMinutes={0}
      />
    );

    const dot = screen.getByRole("button", {
      name: "Jump to first of 2 Commits & PRs events",
    });
    expect(dot).toHaveAttribute("data-first-event-minutes", "12");
    fireEvent.click(dot);
    expect(onJump).toHaveBeenCalledWith(4, 12);

    const tooltip = await openTooltip(dot);
    expect(tooltip).toHaveTextContent(eventCountCopy(2));
    expect(tooltip).toHaveTextContent(
      "Click the dot to jump to the first in the trace"
    );
    const text = tooltip.textContent ?? "";
    expect(text.indexOf("First commit")).toBeLessThan(
      text.indexOf("Opened PR")
    );
    expect(text).toContain("12:12 AM");
    expect(text).toContain("12:40 AM");
  });

  it("labels the problem group", () => {
    render(
      <MarkerGroupDot
        events={[buildMarker({ kind: "fail" })]}
        group="problem"
        onJump={vi.fn()}
        timelineStartMinutes={0}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "Jump to Failures, limits & corrections",
      })
    ).toBeInTheDocument();
  });

  it.each([
    ["human", "var(--primary)"],
    ["delivery", "var(--success)"],
    ["problem", "var(--destructive)"],
  ] as const)(
    "colors the %s dot and its tooltip swatch",
    async (group, color) => {
      render(
        <MarkerGroupDot
          events={[buildMarker()]}
          group={group}
          onJump={vi.fn()}
          timelineStartMinutes={0}
        />
      );
      const dot = screen.getByRole("button");

      expect(styleOf(dot.firstElementChild).background).toBe(color);
      const tooltip = await openTooltip(dot);
      expect(
        styleOf(tooltip.firstElementChild?.firstElementChild).background
      ).toBe(color);
    }
  );
});
