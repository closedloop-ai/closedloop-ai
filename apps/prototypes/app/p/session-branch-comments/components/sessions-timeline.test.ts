import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventDot } from "../mock";
import { timelineColumn, timelineColumnHeightPct } from "../timeline-fixtures";
import { positionEventDots } from "./event-dot-position";
import { BranchSessionsEmptyState } from "./sessions-empty-state";

const event = (leftPct: number, label: string): EventDot => ({
  leftPct,
  kind: "blue",
  label,
  at: "09:00",
  targetTurnId: label,
});

describe("positionEventDots", () => {
  it("centers dots under their activity bar and stacks shared bars vertically", () => {
    const positioned = positionEventDots(
      [
        event(12, "first"),
        event(30, "second"),
        event(34, "third"),
        event(41, "fourth"),
      ],
      8
    );

    expect(positioned.map(({ leftPct }) => leftPct)).toEqual([
      6.25, 31.25, 31.25, 43.75,
    ]);
    expect(positioned.map(({ stackIndex }) => stackIndex)).toEqual([
      0, 0, 1, 0,
    ]);
  });

  it("returns no positioned dots when the timeline has no columns", () => {
    expect(positionEventDots([event(12, "first")], 0)).toEqual([]);
  });

  it("clamps event positions to both ends of the timeline", () => {
    const positioned = positionEventDots(
      [event(-20, "before"), event(120, "after")],
      8
    );

    expect(positioned.map(({ leftPct }) => leftPct)).toEqual([6.25, 93.75]);
  });

  it("derives timeline height from explicit token categories", () => {
    const column = timelineColumn(
      { input: 100, output: 300, cacheRead: 600 },
      []
    );

    expect(timelineColumnHeightPct(column, 2000)).toBe(50);
  });

  it("renders an explicit empty state for a branch with no sessions", () => {
    const html = renderToStaticMarkup(createElement(BranchSessionsEmptyState));

    expect(html).toContain("No sessions recorded");
    expect(html).not.toContain("Combined session trace");
  });
});
