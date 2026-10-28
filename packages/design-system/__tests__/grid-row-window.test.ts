/**
 * ISS-12288 — the row-window arithmetic a windowed grid body paints from.
 *
 * Two claims are load-bearing and each has its own cases here. First, a viewport
 * this module cannot measure yields the WHOLE population: windowing is an
 * optimisation, and a layout that could not be read must never be the reason a
 * row stops rendering. Second, the two pads plus the painted rows account for
 * every row's height, which is what keeps the scrollbar and the scroll offset
 * identical to an unwindowed body's.
 */

import {
  GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS,
  GRID_TABLE_ROW_HEIGHT_PX,
  type GridRowWindow,
  isSameGridRowWindow,
  resolveGridRowPaintPlan,
  resolveGridRowScrollTop,
  resolveGridRowWindow,
  wholeGridRowPopulation,
} from "@closedloop-ai/design-system/lib/grid-row-window";
import { describe, expect, it } from "vitest";

const ROW_COUNT = 500;
const VIEWPORT_HEIGHT_PX = 440;
/** Rows the fixture viewport shows, including the partial one at each edge. */
const VISIBLE_ROWS =
  Math.ceil(VIEWPORT_HEIGHT_PX / GRID_TABLE_ROW_HEIGHT_PX) + 1;
/** One viewport's worth, which on this fixture is above the floor. */
const DEFAULT_OVERSCAN = Math.max(
  GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS,
  VISIBLE_ROWS
);

function windowAt(
  scrollTop: number,
  overrides: Partial<Parameters<typeof resolveGridRowWindow>[0]> = {}
): GridRowWindow {
  return resolveGridRowWindow({
    rowCount: ROW_COUNT,
    scrollTop,
    viewportHeightPx: VIEWPORT_HEIGHT_PX,
    ...overrides,
  });
}

/** Total content height the window claims, pads included. */
function accountedHeightPx(rowWindow: GridRowWindow): number {
  const painted = rowWindow.endIndex - rowWindow.startIndex;
  return (
    rowWindow.leadingPadPx +
    painted * GRID_TABLE_ROW_HEIGHT_PX +
    rowWindow.trailingPadPx
  );
}

describe("resolveGridRowWindow", () => {
  it("paints a bounded slice of a long population", () => {
    const rowWindow = windowAt(0);

    expect(rowWindow.startIndex).toBe(0);
    expect(rowWindow.endIndex).toBeLessThan(ROW_COUNT);
    expect(rowWindow.endIndex).toBeGreaterThan(0);
  });

  it("accounts for every unpainted row's height in the two pads", () => {
    for (const scrollTop of [0, 1, 999, 4400, 21_956]) {
      expect(accountedHeightPx(windowAt(scrollTop))).toBe(
        ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX
      );
    }
  });

  it("follows the scroll offset", () => {
    const rowWindow = windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX);

    expect(rowWindow.startIndex).toBe(100 - DEFAULT_OVERSCAN);
    expect(rowWindow.endIndex).toBeGreaterThan(100);
  });

  it("keeps an overscan band past each edge", () => {
    const scrolled = windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX);

    expect(100 - scrolled.startIndex).toBe(DEFAULT_OVERSCAN);
    expect(scrolled.endIndex - (100 + VISIBLE_ROWS)).toBe(DEFAULT_OVERSCAN);
  });

  it("scales the overscan with the viewport, so a flick cannot outrun it", () => {
    const tallViewportPx = 30 * GRID_TABLE_ROW_HEIGHT_PX;
    const visibleRows =
      Math.ceil(tallViewportPx / GRID_TABLE_ROW_HEIGHT_PX) + 1;
    const scrolled = windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX, {
      viewportHeightPx: tallViewportPx,
    });

    expect(100 - scrolled.startIndex).toBe(visibleRows);
    expect(visibleRows).toBeGreaterThan(GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS);
  });

  it("holds the overscan at its floor for a viewport shorter than the floor", () => {
    const shortViewportPx = 2 * GRID_TABLE_ROW_HEIGHT_PX;
    const scrolled = windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX, {
      viewportHeightPx: shortViewportPx,
    });

    expect(100 - scrolled.startIndex).toBe(GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS);
  });

  it("honours an overscan the caller names", () => {
    const scrolled = windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX, {
      overscanRows: 2,
    });

    expect(100 - scrolled.startIndex).toBe(2);
  });

  it("holds the window inside the population at either end", () => {
    const atTop = windowAt(0);
    const pastBottom = windowAt(ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX * 2);

    expect(atTop.startIndex).toBe(0);
    expect(atTop.leadingPadPx).toBe(0);
    expect(pastBottom.endIndex).toBe(ROW_COUNT);
    expect(pastBottom.trailingPadPx).toBe(0);
    expect(pastBottom.startIndex).toBeLessThanOrEqual(ROW_COUNT);
  });

  it("subtracts the offset the rows begin at, so a header does not shift the window", () => {
    const withHeader = windowAt(40 * GRID_TABLE_ROW_HEIGHT_PX, {
      rowsOffsetPx: 10 * GRID_TABLE_ROW_HEIGHT_PX,
    });

    expect(withHeader.startIndex).toBe(30 - DEFAULT_OVERSCAN);
  });

  it.each([
    ["an unmeasured viewport", { viewportHeightPx: 0 }],
    ["a negative viewport", { viewportHeightPx: -600 }],
    ["a non-finite viewport", { viewportHeightPx: Number.NaN }],
    ["a row height of zero", { rowHeightPx: 0 }],
    ["a non-finite row height", { rowHeightPx: Number.POSITIVE_INFINITY }],
  ])("paints the whole population for %s", (_label, overrides) => {
    const rowWindow = windowAt(4400, overrides);

    expect(rowWindow).toEqual(wholeGridRowPopulation(ROW_COUNT));
  });

  it("paints nothing, and claims no height, for an empty population", () => {
    const rowWindow = windowAt(0, { rowCount: 0 });

    expect(rowWindow).toEqual({
      endIndex: 0,
      leadingPadPx: 0,
      startIndex: 0,
      trailingPadPx: 0,
    });
  });

  it.each([Number.NaN, -1, 2.5])(
    "reads a scroll offset of %s as the top rather than selecting nothing",
    (scrollTop) => {
      expect(windowAt(scrollTop).startIndex).toBe(0);
    }
  );

  it("reads a fractional row count as whole rows", () => {
    const rowWindow = windowAt(0, { rowCount: 10.7 });

    expect(rowWindow.endIndex).toBe(10);
  });
});

describe("resolveGridRowScrollTop", () => {
  const scrollTopFor = (
    index: number,
    overrides: Partial<Parameters<typeof resolveGridRowScrollTop>[0]> = {}
  ) =>
    resolveGridRowScrollTop({
      index,
      rowCount: ROW_COUNT,
      scrollTop: 0,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
      ...overrides,
    });

  it("leaves a row that is already fully visible alone", () => {
    expect(scrollTopFor(0)).toBeNull();
    expect(scrollTopFor(5)).toBeNull();
  });

  it("scrolls a row above the viewport to its own top", () => {
    expect(scrollTopFor(10, { scrollTop: 44 * 40 })).toBe(
      10 * GRID_TABLE_ROW_HEIGHT_PX
    );
  });

  it("scrolls a row below the viewport to the viewport's bottom edge", () => {
    expect(scrollTopFor(100)).toBe(
      101 * GRID_TABLE_ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX
    );
  });

  it("includes the offset the rows begin at", () => {
    const offset = 37;

    expect(scrollTopFor(100, { rowsOffsetPx: offset })).toBe(
      offset + 101 * GRID_TABLE_ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX
    );
  });

  it("holds an out-of-range index inside the population", () => {
    expect(scrollTopFor(ROW_COUNT + 50)).toBe(
      ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX
    );
    expect(scrollTopFor(-3, { scrollTop: 4400 })).toBe(0);
  });

  it("reveals a row the offset has partly cut off at the top", () => {
    expect(scrollTopFor(0, { scrollTop: 10 })).toBe(0);
  });

  it("lands a row BELOW the sticky chrome rather than under it", () => {
    const stickyInsetPx = 35;

    expect(
      scrollTopFor(10, {
        scrollTop: 40 * GRID_TABLE_ROW_HEIGHT_PX,
        stickyInsetPx,
      })
    ).toBe(10 * GRID_TABLE_ROW_HEIGHT_PX - stickyInsetPx);
  });

  it("clamps at the top when the sticky inset is deeper than the row's offset", () => {
    expect(scrollTopFor(0, { scrollTop: 10, stickyInsetPx: 35 })).toBe(0);
  });

  it("scrolls a row the sticky chrome is covering, not only one above the top", () => {
    // Offset 0 puts row 0 flush with the scroller's top, where the header is
    // pinned: visible to the arithmetic, invisible to the reader.
    expect(scrollTopFor(1, { scrollTop: 44, stickyInsetPx: 35 })).toBe(
      GRID_TABLE_ROW_HEIGHT_PX - 35
    );
  });

  it("asks for no scroll when the whole population already fits", () => {
    expect(
      scrollTopFor(1, { rowCount: 2, viewportHeightPx: 10_000 })
    ).toBeNull();
  });

  it.each([
    ["an unmeasured viewport", { viewportHeightPx: 0 }],
    ["an empty population", { rowCount: 0 }],
    ["a row height of zero", { rowHeightPx: 0 }],
  ])("declines to scroll against %s", (_label, overrides) => {
    expect(scrollTopFor(100, overrides)).toBeNull();
  });
});

describe("isSameGridRowWindow", () => {
  it("is true only when both the slice and the pads agree", () => {
    const rowWindow = windowAt(0);

    expect(isSameGridRowWindow(rowWindow, windowAt(1))).toBe(true);
    expect(
      isSameGridRowWindow(rowWindow, windowAt(100 * GRID_TABLE_ROW_HEIGHT_PX))
    ).toBe(false);
    expect(
      isSameGridRowWindow(rowWindow, { ...rowWindow, trailingPadPx: 0 })
    ).toBe(false);
  });
});

/**
 * The retention half (ISS-12288, marisolashgrove review): the row the roving tab
 * stop names is painted even when the window has left it behind.
 *
 * Every case asserts the pads still account for the WHOLE population, because
 * that is the invariant the retention can break — it inserts a row and a third
 * pad into a height the two original pads already covered, so an arithmetic
 * slip here shortens or lengthens the scroll range rather than failing loudly.
 */
describe("resolveGridRowPaintPlan", () => {
  const SCROLLED_PAST_ROW = 300;

  function planFor(retainedIndex: number | null) {
    return resolveGridRowPaintPlan({
      retainedIndex,
      rowCount: ROW_COUNT,
      rowWindow: windowAt(SCROLLED_PAST_ROW * GRID_TABLE_ROW_HEIGHT_PX),
    });
  }

  /** Painted rows: the window's slice plus whichever retained row there is. */
  function paintedRowCount(
    plan: ReturnType<typeof resolveGridRowPaintPlan>
  ): number {
    const retained =
      (plan.leadingRetainedIndex === null ? 0 : 1) +
      (plan.trailingRetainedIndex === null ? 0 : 1);
    return plan.endIndex - plan.startIndex + retained;
  }

  function accountedPlanHeightPx(
    plan: ReturnType<typeof resolveGridRowPaintPlan>
  ): number {
    return (
      plan.leadingPadPx +
      plan.gapPadPx +
      paintedRowCount(plan) * GRID_TABLE_ROW_HEIGHT_PX +
      plan.trailingPadPx
    );
  }

  it("retains a row the window has scrolled below", () => {
    const plan = planFor(2);

    expect(plan.leadingRetainedIndex).toBe(2);
    expect(plan.trailingRetainedIndex).toBeNull();
    expect(plan.leadingPadPx).toBe(2 * GRID_TABLE_ROW_HEIGHT_PX);
  });

  it("retains a row the window has scrolled above", () => {
    const plan = planFor(ROW_COUNT - 1);

    expect(plan.trailingRetainedIndex).toBe(ROW_COUNT - 1);
    expect(plan.leadingRetainedIndex).toBeNull();
    // Nothing follows the population's last row.
    expect(plan.trailingPadPx).toBe(0);
  });

  it.each([
    ["below the window", 2],
    ["above the window", ROW_COUNT - 1],
  ])(
    "accounts for every row's height with one retained %s",
    (_label, index) => {
      expect(accountedPlanHeightPx(planFor(index))).toBe(
        ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX
      );
    }
  );

  it.each([
    ["no row is named", null],
    ["the window already paints it", SCROLLED_PAST_ROW],
    ["the index is outside the population", ROW_COUNT],
    ["the index is not a whole row", 2.5],
  ])("leaves the window untouched when %s", (_label, retainedIndex) => {
    // The controls. Without them the cases above could pass against a plan that
    // retained something unconditionally, which would paint a row twice and
    // claim a height the body does not have.
    const plan = planFor(retainedIndex);

    expect(plan.leadingRetainedIndex).toBeNull();
    expect(plan.trailingRetainedIndex).toBeNull();
    expect(plan.gapPadPx).toBe(0);
    expect(accountedPlanHeightPx(plan)).toBe(
      ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX
    );
  });

  it("retains nothing against a whole-population window", () => {
    // A window with no unpainted row either side has no pad to read a row height
    // back off — and no row outside it to retain.
    const plan = resolveGridRowPaintPlan({
      retainedIndex: 2,
      rowCount: ROW_COUNT,
      rowWindow: wholeGridRowPopulation(ROW_COUNT),
    });

    expect(plan.leadingRetainedIndex).toBeNull();
    expect(plan.trailingRetainedIndex).toBeNull();
  });
});
