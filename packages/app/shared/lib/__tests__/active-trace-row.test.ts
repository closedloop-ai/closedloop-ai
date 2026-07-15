import { describe, expect, it } from "vitest";
import { computeActiveTraceRow } from "../active-trace-row";

function rect(top: number): DOMRect {
  return {
    bottom: top + 20,
    height: 20,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

function buildScroller(rowTops: Array<{ row: number; top: number }>): {
  scroller: HTMLDivElement;
} {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = () => rect(100);
  for (const { row, top } of rowTops) {
    const node = document.createElement("div");
    node.setAttribute("data-row", String(row));
    node.getBoundingClientRect = () => rect(top);
    scroller.append(node);
  }
  return { scroller };
}

describe("computeActiveTraceRow", () => {
  it("returns the last row whose top has passed the fold line", () => {
    // fold = scrollerTop(100) + gap(6) = 106. Rows at 90 and 105 have passed;
    // 200 has not. The lowest passed row is 3.
    const { scroller } = buildScroller([
      { row: 1, top: 90 },
      { row: 3, top: 105 },
      { row: 5, top: 200 },
    ]);
    expect(computeActiveTraceRow({ scroller })).toBe(3);
  });

  it("accounts for sticky-header heights in the fold line", () => {
    const { scroller } = buildScroller([
      { row: 1, top: 105 },
      { row: 2, top: 130 },
    ]);
    const sticky = document.createElement("div");
    sticky.className = "head";
    Object.defineProperty(sticky, "offsetHeight", { value: 40 });
    scroller.append(sticky);
    // fold = 100 + 6 + 40 = 146, so both rows have passed; lowest is 2.
    expect(
      computeActiveTraceRow({ scroller, stickySelectors: [".head"] })
    ).toBe(2);
  });

  it("falls back to the first row when scrolled above all rows (no stale row)", () => {
    // Everything is below the fold (top of scroll): reset to the first row
    // rather than returning null and leaving a stale deep row.
    const { scroller } = buildScroller([
      { row: 4, top: 300 },
      { row: 7, top: 500 },
    ]);
    expect(computeActiveTraceRow({ scroller })).toBe(4);
  });

  it("returns null only when there are no rows / no scroller", () => {
    const empty = document.createElement("div");
    empty.getBoundingClientRect = () => rect(100);
    expect(computeActiveTraceRow({ scroller: empty })).toBeNull();
    expect(computeActiveTraceRow({ scroller: null })).toBeNull();
  });
});
