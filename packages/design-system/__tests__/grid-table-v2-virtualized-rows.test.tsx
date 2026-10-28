/**
 * ISS-12288 — `virtualizeRows`: the body paints a window of its rows.
 *
 * The cases split along the two things that must BOTH hold. The window has to
 * be real (fewer rows committed than the page holds, and the rows the offset
 * reaches), and nothing a reader can reach may change: the unpainted rows'
 * height is still in the scroll range, select-all still speaks about the whole
 * population, the grid still has a tab stop, and a row-wise keyboard move still
 * reaches rows the window has not painted.
 *
 * jsdom has no layout, so the scroller's viewport height and scroll offset are
 * supplied by the fixture. That is also why the whole-population branches are
 * worth their own cases: an unmeasurable viewport is the DEFAULT here, and a
 * test asserting a bounded window would pass against a seam that had simply
 * stopped windowing at all.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  GRID_ROW_SPACER_GAP,
  GRID_ROW_SPACER_LEADING,
  GRID_ROW_SPACER_TRAILING,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2-windowed-rows";
import { TableInlineCreateRow } from "@closedloop-ai/design-system/components/ui/table-inline-create-row";
import { GRID_TABLE_ROW_HEIGHT_PX } from "@closedloop-ai/design-system/lib/grid-row-window";
import { AFTER_ROWS_ROW_ID } from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import { HEADER_ROW_ID } from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { rovingTabStop } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ROW_COUNT = 500;
const VIEWPORT_HEIGHT_PX = 440;
const ROWS: Row[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
  id: `row-${index}`,
  name: `Row ${index}`,
}));
const COLUMNS = [{ id: "status", label: "Status" }];
/**
 * The inline-create row's own label, reused rather than restated: these cases
 * locate that row by `data-grid-row-id`, never by its copy.
 */
const CREATE_ROW_LABEL = "Add session";
const ONE_BAND: GridTableV2Group<Row>[] = [
  { items: ROWS, key: "band", label: "Band" },
];

/** Set by the one case that stubs layout, so a thrown assertion cannot leak it. */
let restoreRect: (() => void) | null = null;

afterEach(() => {
  restoreRect?.();
  restoreRect = null;
  document.body.replaceChildren();
});

/**
 * A scroll container the grid can find and measure. `viewportHeightPx` of
 * `null` leaves `clientHeight` at jsdom's 0 — the unmeasured case.
 */
function mountScroller({
  scrolls = true,
  viewportHeightPx = VIEWPORT_HEIGHT_PX,
}: {
  scrolls?: boolean;
  viewportHeightPx?: number | null;
} = {}): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = scrolls ? "auto" : "visible";
  if (viewportHeightPx !== null) {
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: viewportHeightPx,
    });
  }
  // jsdom does not scroll, so the offset is held here and read back the way a
  // real scroller's would be — which is also what lets a case assert the offset
  // the grid ASKED for when it revealed a row.
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => offset,
    set: (next: number) => {
      offset = next;
    },
  });
  document.body.append(scroller);
  return scroller;
}

function renderGrid({
  groups,
  navigableHeaderCells,
  onSelectAllRows,
  scroller,
  withCreateRow = false,
}: {
  groups?: GridTableV2Group<Row>[];
  navigableHeaderCells?: boolean;
  onSelectAllRows?: (items: readonly Row[]) => void;
  scroller: HTMLDivElement;
  withCreateRow?: boolean;
}) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      groups={groups}
      items={groups ? [] : ROWS}
      leadingLabel="Name"
      navigableHeaderCells={navigableHeaderCells}
      onSelectAllRows={onSelectAllRows}
      renderAfterRows={
        withCreateRow ? (
          <TableInlineCreateRow
            active={false}
            gridTemplateColumns="200px 120px"
            label={CREATE_ROW_LABEL}
            onActivate={noop}
            onCancel={noop}
            onCommit={noop}
          />
        ) : undefined
      }
      renderCell={(_columnId, row) => <span>{`Status ${row.name}`}</span>}
      renderLead={(row) => <span>{row.name}</span>}
      virtualizeRows
    />,
    { container: scroller }
  );
}

function noop() {
  // The create row's callbacks are not what these cases exercise.
}

function paintedRowIds(scroller: HTMLElement): string[] {
  return Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-grid-row]")
  ).map((row) => row.dataset.gridRowId ?? "");
}

function spacerHeightPx(scroller: HTMLElement, spacer: string): number {
  const element = scroller.querySelector<HTMLElement>(
    `[data-grid-row-spacer="${spacer}"]`
  );
  return element ? Number.parseFloat(element.style.height || "0") : 0;
}

/**
 * Drive the scroller the way a browser does, then let the frame the hook
 * coalesces onto actually run — it updates the window inside
 * `requestAnimationFrame`, so a synchronous assertion would read the window
 * from before the scroll and pass against a hook that never updated at all.
 */
async function scrollTo(
  scroller: HTMLElement,
  offsetPx: number
): Promise<void> {
  await act(async () => {
    scroller.scrollTop = offsetPx;
    fireEvent.scroll(scroller);
    await nextFrame();
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => resolve());
  });
}

function firstCellOf(rowId: string): HTMLElement {
  const cell = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"] [data-grid-cell]`
  );
  if (!cell) {
    throw new Error(`row ${rowId} is not painted`);
  }
  return cell;
}

describe("GridTableV2 virtualizeRows", () => {
  it("never builds the whole population at mount", () => {
    // The window cannot be measured until its anchor is in the DOM, so the first
    // render precedes any window and has to paint something. Painting the whole
    // population there made a 500-row mount do 1,022 row renders and insert 500
    // rows to remove 478 — the window's cost at the one moment it buys nothing.
    // A seed corrected by the layout effect, before paint, is what makes mount
    // cheaper than not windowing at all rather than twice as expensive.
    let leadRenders = 0;
    const scroller = mountScroller();
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        renderCell={() => null}
        renderLead={(row) => {
          leadRenders += 1;
          return <span>{row.name}</span>;
        }}
        virtualizeRows
      />,
      { container: scroller }
    );

    expect(leadRenders).toBeLessThan(ROW_COUNT);
    expect(paintedRowIds(scroller).length).toBeLessThan(ROW_COUNT);
  });

  it("commits a bounded slice of a 500-row page", () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    const painted = paintedRowIds(scroller);
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.length).toBeLessThan(ROW_COUNT);
    expect(painted).toContain("row-0");
  });

  it("holds the unpainted rows' height, so the scroll range is unchanged", () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    const accounted =
      spacerHeightPx(scroller, GRID_ROW_SPACER_LEADING) +
      paintedRowIds(scroller).length * GRID_TABLE_ROW_HEIGHT_PX +
      spacerHeightPx(scroller, GRID_ROW_SPACER_TRAILING);
    expect(accounted).toBe(ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX);
  });

  it("paints the rows the scroll offset reaches", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    await scrollTo(scroller, 100 * GRID_TABLE_ROW_HEIGHT_PX);

    const painted = paintedRowIds(scroller);
    expect(painted).toContain("row-100");
    expect(painted).not.toContain("row-0");
    expect(spacerHeightPx(scroller, GRID_ROW_SPACER_LEADING)).toBeGreaterThan(
      0
    );
  });

  it("keeps a tab stop inside the painted slice once the window has moved", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    await scrollTo(scroller, 100 * GRID_TABLE_ROW_HEIGHT_PX);

    const tabStop = rovingTabStop();
    expect(tabStop).not.toBeNull();
    expect(scroller.contains(tabStop)).toBe(true);
  });

  it("counts in the row height it MEASURES, not the default-font constant", () => {
    // `h-11` is 2.75rem, so a reader whose root font size is not 16px gets rows
    // that are not GRID_TABLE_ROW_HEIGHT_PX tall. jsdom lays nothing out, so the
    // taller row is supplied here — and if the window counted in the constant
    // instead, the pads would claim a content height the rows do not have.
    const measuredRowHeightPx = 60;
    const original = Element.prototype.getBoundingClientRect;
    restoreRect = () => {
      Element.prototype.getBoundingClientRect = original;
    };
    Element.prototype.getBoundingClientRect = function boundedRect(
      this: Element
    ) {
      const height = this.matches("[data-grid-row]") ? measuredRowHeightPx : 0;
      return {
        bottom: height,
        height,
        left: 0,
        right: 0,
        toJSON: () => ({}),
        top: 0,
        width: 0,
        x: 0,
        y: 0,
      } as DOMRect;
    };

    const scroller = mountScroller();
    renderGrid({ scroller });

    const painted = paintedRowIds(scroller).length;
    expect(painted).toBeLessThan(ROW_COUNT);
    expect(spacerHeightPx(scroller, GRID_ROW_SPACER_TRAILING)).toBe(
      (ROW_COUNT - painted) * measuredRowHeightPx
    );
  });

  it("puts the leading spacer directly after the sticky header row", () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    // The sticky inset the keyboard scroll subtracts is measured by walking the
    // spacer's PRECEDING siblings for stuck ones, so this adjacency is what
    // makes the measurement find the header at all. A node inserted between the
    // two silently returns the inset to 0 and lands a focused row back under
    // the header, with nothing else to notice it.
    const spacer = scroller.querySelector(
      `[data-grid-row-spacer="${GRID_ROW_SPACER_LEADING}"]`
    );
    expect(spacer?.previousElementSibling).toHaveAttribute("role", "row");
    expect(spacer?.previousElementSibling).toHaveClass("sticky");
  });

  it("reports the whole population to select-all, not the painted slice", () => {
    const onSelectAllRows = vi.fn();
    const scroller = mountScroller();
    renderGrid({ onSelectAllRows, scroller });

    fireEvent.keyDown(firstCellOf("row-0"), { ctrlKey: true, key: "a" });

    expect(onSelectAllRows).toHaveBeenCalledTimes(1);
    expect(onSelectAllRows.mock.calls[0]?.[0]).toHaveLength(ROW_COUNT);
  });

  it("reaches the population's last row on Ctrl+End, not the last painted one", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    fireEvent.keyDown(firstCellOf("row-0"), { ctrlKey: true, key: "End" });
    // The grid asks the scroller to reveal the row; jsdom dispatches no scroll
    // event of its own, so the fixture delivers the one the browser would.
    expect(scroller.scrollTop).toBe(
      ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX
    );
    await scrollTo(scroller, scroller.scrollTop);

    expect(paintedRowIds(scroller)).toContain(`row-${ROW_COUNT - 1}`);
    expect(document.activeElement?.closest("[data-grid-row]")).toHaveAttribute(
      "data-grid-row-id",
      `row-${ROW_COUNT - 1}`
    );
  });

  it("steps onto a row past the window and keeps the column", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });

    const painted = paintedRowIds(scroller);
    const lastPainted = painted.at(-1) ?? "";
    const cell = firstCellOf(lastPainted);
    const column = cell.getAttribute("aria-colindex");
    fireEvent.keyDown(cell, { key: "ArrowDown" });
    await scrollTo(scroller, scroller.scrollTop);

    const landedRow = document.activeElement?.closest("[data-grid-row]");
    expect(landedRow).not.toBe(cell.closest("[data-grid-row]"));
    expect(document.activeElement).toHaveAttribute("aria-colindex", column);
  });

  it.each([
    ["the body is grouped", { groups: ONE_BAND }],
    ["the scroller reports no height", { viewportHeightPx: null }],
    ["nothing above the grid scrolls", { scrolls: false }],
  ])("paints every row when %s", (_label, options) => {
    const scroller = mountScroller({
      scrolls: "scrolls" in options ? options.scrolls : true,
      viewportHeightPx:
        "viewportHeightPx" in options
          ? options.viewportHeightPx
          : VIEWPORT_HEIGHT_PX,
    });
    renderGrid({
      groups: "groups" in options ? options.groups : undefined,
      scroller,
    });

    expect(paintedRowIds(scroller)).toHaveLength(ROW_COUNT);
    expect(spacerHeightPx(scroller, GRID_ROW_SPACER_TRAILING)).toBe(0);
    // The tab stop is what the window's bookkeeping can break without changing
    // the row count: the roving key set is built from the PAINTED rows, so a
    // body that paints every row through the other branch must still register
    // them — otherwise no data cell is in the tab order and a keyboard user
    // cannot enter the grid at all.
    expect(rovingTabStop()?.closest("[data-grid-row]")).not.toBeNull();
  });
});

/**
 * ISS-12288, marisolashgrove review — the row holding the roving tab stop is
 * painted even once the window has scrolled past it.
 *
 * Every case here has to make the row genuinely leave the WINDOW, or it proves
 * nothing: a fixture that scrolls a few rows leaves the destination inside the
 * overscan band, where the row would still be painted with no retention at all.
 * The guard is `paintedSliceExcludes`, which reads the gap spacer the retention
 * itself emits — present only when the retained row sits outside the slice.
 */
describe("GridTableV2 virtualizeRows focus retention", () => {
  const FAR_SCROLL_ROW = 300;

  function focusFirstCellOf(rowId: string): HTMLElement {
    const cell = firstCellOf(rowId);
    act(() => {
      cell.focus();
      fireEvent.focus(cell);
    });
    return cell;
  }

  /** Whether the retained row is outside the window's own slice. */
  function paintedSliceExcludes(scroller: HTMLElement): boolean {
    return (
      scroller.querySelector(
        `[data-grid-row-spacer="${GRID_ROW_SPACER_GAP}"]`
      ) !== null
    );
  }

  it("keeps the focused row painted and focused across a scroll past it", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });
    const focused = focusFirstCellOf("row-2");

    await scrollTo(scroller, FAR_SCROLL_ROW * GRID_TABLE_ROW_HEIGHT_PX);

    // The window really moved off row 2 — without this the case would pass
    // against a grid that simply never dropped a row.
    expect(paintedRowIds(scroller)).toContain(`row-${FAR_SCROLL_ROW}`);
    expect(paintedSliceExcludes(scroller)).toBe(true);
    expect(paintedRowIds(scroller)).toContain("row-2");
    expect(document.activeElement).toBe(focused);
    expect(rovingTabStop()).toBe(focused);
  });

  it("still accounts for every unpainted row's height while retaining one", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });
    focusFirstCellOf("row-2");

    await scrollTo(scroller, FAR_SCROLL_ROW * GRID_TABLE_ROW_HEIGHT_PX);

    expect(paintedSliceExcludes(scroller)).toBe(true);
    const accounted =
      spacerHeightPx(scroller, GRID_ROW_SPACER_LEADING) +
      spacerHeightPx(scroller, GRID_ROW_SPACER_GAP) +
      paintedRowIds(scroller).length * GRID_TABLE_ROW_HEIGHT_PX +
      spacerHeightPx(scroller, GRID_ROW_SPACER_TRAILING);
    expect(accounted).toBe(ROW_COUNT * GRID_TABLE_ROW_HEIGHT_PX);
  });

  it("retains a row the window has scrolled ABOVE as well as below", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller });
    await scrollTo(scroller, FAR_SCROLL_ROW * GRID_TABLE_ROW_HEIGHT_PX);
    const focused = focusFirstCellOf(`row-${FAR_SCROLL_ROW}`);

    await scrollTo(scroller, 0);

    expect(paintedRowIds(scroller)).toContain("row-0");
    expect(paintedSliceExcludes(scroller)).toBe(true);
    expect(paintedRowIds(scroller)).toContain(`row-${FAR_SCROLL_ROW}`);
    expect(document.activeElement).toBe(focused);
  });

  it("paints no gap once the window catches up with the retained row", async () => {
    // The control for the three above: the retention must be CONDITIONAL on the
    // row being outside the slice, not a third spacer the body always emits.
    const scroller = mountScroller();
    renderGrid({ scroller });
    focusFirstCellOf("row-2");

    await scrollTo(scroller, 0);

    expect(paintedSliceExcludes(scroller)).toBe(false);
    expect(paintedRowIds(scroller)).toContain("row-2");
  });
});

/**
 * ISS-12288, whitlockk and marisolashgrove review — row-wise navigation resolves
 * against the grid's WHOLE row sequence, chrome rows included.
 *
 * The two ends are one model, so each case names the row it must reach by
 * `data-grid-row-id` rather than by position: the header and the create row are
 * the two rows a data-row-only population cannot see at all.
 */
describe("GridTableV2 virtualizeRows full navigation model", () => {
  function focusedRowId(): string | undefined {
    return document.activeElement?.closest<HTMLElement>("[data-grid-row]")
      ?.dataset.gridRowId;
  }

  it("reaches the column header on Ctrl+Home from a data row", () => {
    const scroller = mountScroller();
    renderGrid({ navigableHeaderCells: true, scroller });

    fireEvent.keyDown(firstCellOf("row-0"), { ctrlKey: true, key: "Home" });

    expect(focusedRowId()).toBe(HEADER_ROW_ID);
  });

  it("reaches the population's last row on Ctrl+End from the header", async () => {
    const scroller = mountScroller();
    renderGrid({ navigableHeaderCells: true, scroller });

    fireEvent.keyDown(firstCellOf(HEADER_ROW_ID), {
      ctrlKey: true,
      key: "End",
    });
    await scrollTo(scroller, scroller.scrollTop);

    // Not the last PAINTED row, which is what the DOM walk answered with.
    expect(focusedRowId()).toBe(`row-${ROW_COUNT - 1}`);
  });

  it("reaches the trailing create row on Ctrl+End from a data row", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller, withCreateRow: true });

    fireEvent.keyDown(firstCellOf("row-0"), { ctrlKey: true, key: "End" });
    await scrollTo(scroller, scroller.scrollTop);

    expect(focusedRowId()).toBe(AFTER_ROWS_ROW_ID);
  });

  it("reaches row 0 on Ctrl+Home from the create row, not the first painted row", async () => {
    const scroller = mountScroller();
    renderGrid({ scroller, withCreateRow: true });
    await scrollTo(scroller, 460 * GRID_TABLE_ROW_HEIGHT_PX);
    // The window is nowhere near row 0, which is the whole point: the DOM walk
    // answered this with the first row the body happened to paint.
    expect(paintedRowIds(scroller)).not.toContain("row-0");

    fireEvent.keyDown(firstCellOf(AFTER_ROWS_ROW_ID), {
      ctrlKey: true,
      key: "Home",
    });
    await scrollTo(scroller, scroller.scrollTop);

    expect(focusedRowId()).toBe("row-0");
  });

  it("steps from the first data row up onto the header", () => {
    // The step half of the same model: ArrowUp off row 0 is a move, not an edge,
    // once the header is a row of the population.
    const scroller = mountScroller();
    renderGrid({ navigableHeaderCells: true, scroller });

    fireEvent.keyDown(firstCellOf("row-0"), { key: "ArrowUp" });

    expect(focusedRowId()).toBe(HEADER_ROW_ID);
  });

  it("leaves ArrowUp alone at the real top of the sequence", () => {
    // The control: the model must still report an EDGE, or the key would be
    // swallowed where the browser should keep it.
    const scroller = mountScroller();
    renderGrid({ navigableHeaderCells: true, scroller });
    const headerCell = firstCellOf(HEADER_ROW_ID);

    const claimed = fireEvent.keyDown(headerCell, { key: "ArrowUp" });

    // `fireEvent` returns false when a handler called `preventDefault`.
    expect(claimed).toBe(true);
    expect(document.activeElement).not.toBe(headerCell);
  });
});

/**
 * ISS-12288, whitlockk review — a windowed grid publishes the row lattice.
 *
 * WCAG 1.3.1 via ARIA 1.2: without `aria-rowcount` and an ABSOLUTE
 * `aria-rowindex`, assistive technology reads the painted slice as the whole
 * table. The last case is the counterweight: ISS-8921 deliberately left the
 * unwindowed grid without a declared lattice, and that line still holds.
 */
describe("GridTableV2 virtualizeRows ARIA row lattice", () => {
  function rowIndexOf(rowId: string): string | null {
    return (
      document
        .querySelector<HTMLElement>(`[data-grid-row-id="${rowId}"]`)
        ?.getAttribute("aria-rowindex") ?? null
    );
  }

  it("counts the whole population plus the header and the create row", () => {
    const scroller = mountScroller();
    renderGrid({ scroller, withCreateRow: true });

    expect(
      scroller.querySelector("[data-grid-body]")?.getAttribute("aria-rowcount")
    ).toBe(String(ROW_COUNT + 2));
  });

  it("numbers the header 1 and each row by its position in the full list", async () => {
    const scroller = mountScroller();
    renderGrid({ navigableHeaderCells: true, scroller, withCreateRow: true });

    await scrollTo(scroller, 100 * GRID_TABLE_ROW_HEIGHT_PX);

    expect(rowIndexOf(HEADER_ROW_ID)).toBe("1");
    // Row 100 is the 102nd row of the table: the header, then rows 0..99.
    expect(rowIndexOf("row-100")).toBe("102");
    // The create row is last, after every data row — painted or not.
    expect(rowIndexOf(AFTER_ROWS_ROW_ID)).toBe(String(ROW_COUNT + 2));
  });

  it("declares no lattice on a body that paints every row", () => {
    // ISS-8921's line: a grid whose rows are all in the DOM gains nothing from a
    // declared index and would owe a second source of truth to keep in step.
    const scroller = mountScroller();
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        renderCell={() => null}
        renderLead={(row) => <span>{row.name}</span>}
      />,
      { container: scroller }
    );

    expect(
      scroller.querySelector("[data-grid-body]")?.getAttribute("aria-rowcount")
    ).toBeNull();
    expect(rowIndexOf("row-0")).toBeNull();
  });
});
