/**
 * ISS-12288 — the Sessions list's windowed body, mounted on DESKTOP.
 *
 * PR #8762 shipped `virtualizeRows` and verified it in `@closedloop-ai/design-system`,
 * `@repo/app` and `storybook`. None of its 30 files touched `apps/desktop`, and
 * root `AGENTS.md` makes a shared `packages/app` change owe coverage on both
 * adapters.
 *
 * The scroller is SUPPLIED here, not produced by the shell: on the real Sessions
 * route the shell's content viewport does not scroll and the grid's own band
 * does, so the shell's restoration writes an element that cannot move
 * (ISS-12471). What this file pins is that the windowed body and the production
 * `restoreContentScrollPosition` compose when a scroller is present.
 *
 * jsdom neither lays out nor scrolls, so the viewport height, the scroll offset
 * and the two rectangles the measurement reads are supplied too, exactly as the
 * design-system window suite supplies them. No native-layout claim is made.
 */

import { GRID_ROW_SPACER_LEADING } from "@closedloop-ai/design-system/components/ui/grid-table-v2-windowed-rows";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@closedloop-ai/design-system/components/ui/table-page-size-select";
import {
  GRID_TABLE_ROW_HEIGHT_PX,
  resolveGridRowWindow,
} from "@closedloop-ai/design-system/lib/grid-row-window";
import { GRID_ROW_SELECTOR } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { queryGridDataRows } from "@closedloop-ai/design-system/lib/grid-table-v2-row-drag";
import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionsListSurfaceV2 } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreContentScrollPosition } from "../../../navigation/use-content-scroll-restoration";

/**
 * The largest page the shipped ladder offers, taken from the ladder itself
 * rather than typed out: the surface PAGINATES, so the body never windows the
 * whole population and a hand-written row count would be asserting against a
 * page size this repo may no longer offer. The 250- and 500-row rungs exist only
 * behind `table-page-size-ladder` (default off), so this is the deepest page a
 * desktop reader reaches today — and the ticket's own 500-row measurement was
 * taken on the primitive, below this surface's paging.
 */
const PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS.at(-1) ?? DEFAULT_TABLE_PAGE_SIZE;
/** A population several pages deep, so page one is a genuine slice of it. */
const ROWS = Array.from({ length: PAGE_SIZE * 5 }, (_, index) =>
  createSessionTableRowFixture({
    id: sessionRowId(index),
    name: `agent/desktop-${index}`,
  })
);
/** The scroller's visible height, since jsdom lays nothing out to measure. */
const VIEWPORT_HEIGHT_PX = 440;
/**
 * Content between the scroller's top and row 0: a window measured from the
 * scroller's top instead of from the row anchor would be wrong by exactly this
 * much.
 */
const CONTENT_ABOVE_GRID_PX = 300;
/** A row index deep enough into the page that its window cannot still hold row 0. */
const RESTORED_ROW_INDEX = 60;
/** Derived from the row height, not a magic offset, so it keeps naming that row. */
const RESTORED_SCROLL_TOP_PX =
  CONTENT_ABOVE_GRID_PX + RESTORED_ROW_INDEX * GRID_TABLE_ROW_HEIGHT_PX;
/** The width that mounts the GRID; below its breakpoint Sessions renders cards. */
const GRID_WIDTH_PX = 1440;

/** The element whose rectangle stands in for where row 0 begins. */
const ROWS_ANCHOR_SELECTOR = `[data-grid-row-spacer="${GRID_ROW_SPACER_LEADING}"]`;

let restoreContainerWidth: (() => void) | null = null;
let restoreResizeObserver: (() => void) | undefined;
let restoreMatchMedia: (() => void) | undefined;
let restoreRects: (() => void) | null = null;
let disposeRestore: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
  restoreMatchMedia = installMatchMedia();
});

afterEach(() => {
  disposeRestore?.();
  disposeRestore = null;
  cleanup();
  restoreRects?.();
  restoreRects = null;
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  restoreResizeObserver?.();
  restoreMatchMedia?.();
  document.body.replaceChildren();
});

describe("Desktop Sessions windowed body (ISS-12288)", () => {
  it("paints a window of the page inside the supplied scroller", () => {
    const { grid } = renderDesktopSessions({ scrolls: true });

    // Windowing engaged: `aria-rowcount` is published only under the opt-in, so
    // its absence would mean this case was measuring an unwindowed body.
    const ariaRowCount = Number(grid.getAttribute("aria-rowcount"));
    expect(ariaRowCount).toBeGreaterThanOrEqual(PAGE_SIZE + 1);
    // The window is real, and the page is still what the grid REPORTS — a reader
    // is told about every row on the page while far fewer are committed.
    expect(queryGridDataRows(grid).length).toBeLessThan(PAGE_SIZE);
    expect(queryGridDataRows(grid).length).toBeGreaterThan(0);
  });

  // The CONTROL: windowing engages only when an ancestor scrolls, so without
  // this arm the case above would pass just as well against a body that had
  // stopped windowing entirely.
  it("paints every row when no ancestor scrolls", () => {
    const { grid } = renderDesktopSessions({ scrolls: false });

    expect(queryGridDataRows(grid).length).toBe(PAGE_SIZE);
  });

  // AC2's half that the two existing restoration suites cannot reach: both drive
  // their hook against synthetic elements, so neither observes that a RESTORED
  // offset and the window now read the same `scrollTop`. Windowing made these one
  // mechanism; restoring to `RESTORED_ROW_INDEX` must paint the rows around it,
  // not row 0 at that offset.
  it("moves the window to the rows a restored offset lands on", async () => {
    const { grid, scroller } = renderDesktopSessions({ scrolls: true });
    const before = paintedRowIds(grid);

    await act(async () => {
      // The production restore, not an assignment written here, so this asserts
      // the real path composes. jsdom does not emit `scroll` for a programmatic
      // offset the way a browser does, so the event the window listens for is
      // dispatched explicitly.
      disposeRestore = restoreContentScrollPosition(
        scroller,
        RESTORED_SCROLL_TOP_PX
      );
      scroller.dispatchEvent(new Event("scroll"));
      // The window coalesces scroll into ONE update per animation frame, so the
      // repaint lands a frame after the event rather than inside the dispatch.
      await new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => resolve(undefined));
      });
    });

    const after = paintedRowIds(grid);
    expect(scroller.scrollTop).toBe(RESTORED_SCROLL_TOP_PX);
    expect(after).not.toEqual(before);
    // Nothing from the top of the list survives at this offset, which is the
    // claim an "it re-rendered" assertion alone would not make. Compared id to
    // id: against `ROWS[0].name` this read a display name off a list of row ids
    // and held whether or not row 0 survived (whitlockk review).
    expect(after).not.toContain(sessionRowId(0));
    // And it is the window the DESKTOP geometry yields, which is the half the
    // bound above cannot see: an offset measured as 0 still drops row 0, just
    // `CONTENT_ABOVE_GRID_PX` worth of rows too far down.
    expect(after).toEqual(restoredWindowRowIds());
  });
});

/** The id the fixture gives row `index`, so an assertion names a painted row. */
function sessionRowId(index: number): string {
  return `ses-${index}`;
}

/** The data rows the body committed, by the id each one carries. */
function paintedRowIds(grid: HTMLElement): string[] {
  return queryGridDataRows(grid).map(
    (row) => row.dataset.gridRowId ?? "<unidentified>"
  );
}

/**
 * The rows the restored offset makes worth painting, resolved from the geometry
 * THIS FIXTURE supplies — `CONTENT_ABOVE_GRID_PX` included.
 *
 * The arithmetic is the shipped one rather than a second copy, because what this
 * file owns is whether the hook MEASURES that offset off the layout; the overscan
 * band is `resolveGridRowWindow`'s own policy and is pinned by its own suite, so
 * restating it here would fix this file to a number it does not own.
 */
function restoredWindowRowIds(): string[] {
  const { startIndex, endIndex } = resolveGridRowWindow({
    rowCount: PAGE_SIZE,
    rowHeightPx: GRID_TABLE_ROW_HEIGHT_PX,
    rowsOffsetPx: CONTENT_ABOVE_GRID_PX,
    scrollTop: RESTORED_SCROLL_TOP_PX,
    viewportHeightPx: VIEWPORT_HEIGHT_PX,
  });
  return Array.from({ length: endIndex - startIndex }, (_, offset) =>
    sessionRowId(startIndex + offset)
  );
}

/**
 * The surface inside a supplied scroller. `scrolls: false` leaves it
 * non-scrolling, so the window has no ancestor to resolve to.
 */
function renderDesktopSessions({ scrolls }: { scrolls: boolean }): {
  grid: HTMLElement;
  scroller: HTMLElement;
} {
  restoreContainerWidth = stubContainerWidthPx(GRID_WIDTH_PX);
  const scroller = document.createElement("div");
  scroller.style.overflowY = scrolls ? "auto" : "visible";
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: VIEWPORT_HEIGHT_PX,
  });
  // jsdom does not scroll, so the offset is held here and read back the way a
  // real scroller's would be.
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => offset,
    set: (next: number) => {
      offset = next;
    },
  });
  // Tall enough that a restore to `RESTORED_SCROLL_TOP_PX` is not clamped away:
  // the production restore clamps to `scrollHeight - clientHeight`.
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: CONTENT_ABOVE_GRID_PX + PAGE_SIZE * GRID_TABLE_ROW_HEIGHT_PX,
  });
  // The DOM shape: content in the same scroller, above the grid. Its MEASURED
  // consequence comes from `installMeasuredRects` — a style height lays nothing
  // out in jsdom.
  const above = document.createElement("div");
  above.style.height = `${CONTENT_ABOVE_GRID_PX}px`;
  const container = document.createElement("div");
  scroller.append(above, container);
  document.body.append(scroller);
  restoreRects = installMeasuredRects(scroller);

  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <SessionsListSurfaceV2
        hasConnectedAgent
        // The fixtures carry no recent activity, and the default window would
        // filter every row out before a body existed to window.
        initialDateRange="all"
        mode="expanded"
        pageSize={PAGE_SIZE}
        rows={ROWS}
        usage={undefined}
      />
    </FeatureFlagAdapterProvider>,
    { container }
  );
  const grid = container.querySelector<HTMLElement>('[role="grid"]');
  if (grid === null) {
    throw new Error("desktop Sessions rendered no grid");
  }
  return { grid, scroller };
}

/**
 * The three rectangles the window measurement reads, which jsdom will not give
 * it: no layout engine means `getBoundingClientRect` reports zeros whatever an
 * element's style height says, so the 300px above the grid measured as nothing
 * and the hook placed row 0 at the scroller's own top (whitlockk review). Installed
 * BEFORE `render`, because the measurement runs in a layout effect of that
 * commit.
 */
function installMeasuredRects(scroller: HTMLElement): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function measuredRect(
    this: Element
  ): DOMRect {
    if (this === scroller) {
      return rectAt({ heightPx: VIEWPORT_HEIGHT_PX, topPx: 0 });
    }
    if (this.matches(ROWS_ANCHOR_SELECTOR)) {
      // Row 0 begins below the content above it, and scrolling carries it up the
      // way a real layout would — the hook adds `scrollTop` back.
      return rectAt({
        heightPx: 0,
        topPx: CONTENT_ABOVE_GRID_PX - scroller.scrollTop,
      });
    }
    if (this.matches(GRID_ROW_SELECTOR)) {
      return rectAt({ heightPx: GRID_TABLE_ROW_HEIGHT_PX, topPx: 0 });
    }
    return original.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** A rect with only the two lengths the measurement reads carrying a value. */
function rectAt({
  heightPx,
  topPx,
}: {
  heightPx: number;
  topPx: number;
}): DOMRect {
  return {
    bottom: topPx + heightPx,
    height: heightPx,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: topPx,
    width: 0,
    x: 0,
    y: topPx,
  } as DOMRect;
}

function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

function installMatchMedia(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "matchMedia"
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "matchMedia");
      return;
    }
    Object.defineProperty(window, "matchMedia", originalDescriptor);
  };
}
