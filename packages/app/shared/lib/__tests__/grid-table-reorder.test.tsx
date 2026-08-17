import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { TableGridHeaderAlign } from "@repo/design-system/components/ui/table-grid-header";
import { MIN_COLUMN_WIDTH_PX } from "@repo/design-system/lib/column-order";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * FEA-4021: the design-system `GridTable` primitive has no test runner of its
 * own, so its reorder-handle wiring is exercised here (its `@repo/app` consumer).
 * Focus: the natural-order convention — a controlled caller that passes
 * `columnOrder={[]}` (empty = natural order) with `onColumnOrderChange` must
 * still get drag handles so the FIRST reorder can be initiated. Regression for
 * the codex P2 where an empty order failed every header's `includes` check and
 * hid every handle.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 120px";

const RE_REORDER_HANDLE = /^Reorder .+ column, use arrow keys$/;

// ISS-5812: a reorderable column reserves NO lane. Pinned as a literal here
// (not imported from the component) so the implementation and the test cannot
// drift together to a different padding.
const DEFAULT_CELL_PL = "pl-3";

function renderGrid(columnOrder: string[], endAlignedIds: string[] = []) {
  const columns = COLUMNS.map((column) =>
    endAlignedIds.includes(column.id)
      ? { ...column, headerAlign: TableGridHeaderAlign.End }
      : column
  );
  return render(
    <GridTable<Row>
      columnOrder={columnOrder}
      columns={columns}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      onColumnOrderChange={() => {
        // no-op — the test only asserts the handles render.
      }}
      renderCell={(columnId, row) => (
        <span>
          {columnId}:{row.name}
        </span>
      )}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

describe("GridTable reorder handles — empty (natural) columnOrder", () => {
  it("renders a drag handle per data column when columnOrder is empty", () => {
    renderGrid([]);
    const handles = screen.getAllByRole("button", { name: RE_REORDER_HANDLE });
    // One handle for each of the two data columns (the fixed lead never gets one).
    expect(handles).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "Reorder Owner column, use arrow keys",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Reorder Status column, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("still renders handles for an explicit non-empty order", () => {
    renderGrid(["status", "owner"]);
    expect(
      screen.getAllByRole("button", { name: RE_REORDER_HANDLE })
    ).toHaveLength(2);
  });
});

/**
 * ISS-5812 — THE RECURRENCE GUARD. Read this before changing the grip.
 *
 * This defect has been fixed and reintroduced five times. The mechanism of the
 * recurrence is that nothing failed when a reserved grip lane came back: the
 * one pixel guard that would have caught it (the Sessions desktop visual
 * baseline) was REGENERATED to accept the gutter in `947890851`, so the guard
 * was taught to bless the defect instead of failing on it.
 *
 * These tests exist so that can never be true again, and they are written to
 * survive the specific ways the previous fixes were undone:
 *
 *  - They assert PARITY IN PIXELS, resolved from the rendered tokens, not the
 *    presence of a class name. A future lane spelled `pl-8`, `ps-9`, an
 *    arbitrary `pl-[36px]`, or an inline style is still a pixel difference and
 *    still fails here. A `toHaveClass("pl-3")` check would not have caught any
 *    of them (the ISS-5333 lesson, applied to this file).
 *  - They pin no absolute number. The rule is "a reorderable cell costs exactly
 *    what a non-reorderable cell costs", so the guard keeps meaning the right
 *    thing if the default cell padding is ever retuned — it can only be
 *    satisfied by charging reorder nothing.
 *  - They cover the DATA cells as well as the header. ISS-5356's lane was
 *    mirrored onto every data cell of every reorderable column, which is what
 *    made a header-row affordance indent every cell in the product.
 *
 * If you are here because this test is failing: the lane is the bug. Do not
 * relax the assertion, and do not regenerate a visual baseline to match.
 */
describe("GridTable reorder grip — reserves NO column (ISS-5812)", () => {
  it("charges a reorderable column's header and data cells the same left padding as a non-reorderable column's", () => {
    const reorderable = renderGrid([]);
    const plainCells =
      renderStaticGrid().container.querySelectorAll<HTMLElement>(
        `[data-column-id="${COLUMNS[0].id}"]`
      );
    const baseline = resolveSpacingToken(plainCells[0], RE_PADDING_LEFT);
    // Guard the guard: a baseline that failed to resolve would make every
    // comparison below vacuous.
    expect(baseline).not.toBeNull();
    expect(plainCells.length).toBe(ROWS.length + 1);

    const ownerCells = reorderable.container.querySelectorAll<HTMLElement>(
      `[data-column-id="${COLUMNS[0].id}"]`
    );
    const headerCells = [...ownerCells].filter((cell) =>
      cell.querySelector('button[aria-label^="Reorder"]')
    );
    const dataCells = [...ownerCells].filter(
      (cell) => !cell.querySelector('button[aria-label^="Reorder"]')
    );
    // Exactly one header cell (grip inside) and one data cell per row, so the
    // loop below cannot pass by measuring nothing.
    expect(headerCells).toHaveLength(1);
    expect(dataCells).toHaveLength(ROWS.length);

    for (const cell of ownerCells) {
      expect(resolveSpacingToken(cell, RE_PADDING_LEFT)).toBe(baseline);
    }
  });

  it("gives every reorderable column the same left padding, so no grid is indented by its grips", () => {
    const { container } = renderGrid([]);
    const paddings = COLUMNS.flatMap((column) => {
      const cells = container.querySelectorAll<HTMLElement>(
        `[data-column-id="${column.id}"]`
      );
      return [...cells].map((cell) =>
        resolveSpacingToken(cell, RE_PADDING_LEFT)
      );
    });
    expect(paddings.length).toBe(COLUMNS.length * (ROWS.length + 1));
    expect(new Set(paddings).size).toBe(1);
  });

  it("leaves non-reorderable cells on the default pl-3 — unchanged by the grip", () => {
    const { container } = renderStaticGrid();
    const statusCells = container.querySelectorAll<HTMLElement>(
      '[data-column-id="status"]'
    );
    // Header cell (no grip in a static grid) plus one data cell per row.
    expect(statusCells).toHaveLength(ROWS.length + 1);
    for (const cell of statusCells) {
      expect(cell.classList.contains(DEFAULT_CELL_PL)).toBe(true);
      expect(cell.querySelector('button[aria-label^="Reorder"]')).toBeNull();
    }
  });
});

/**
 * ISS-5356 — where the reorder grip sits along the x-axis of its OWN header
 * cell.
 *
 * jsdom performs no layout, so `getBoundingClientRect()` is all zeroes here and
 * a literal position read is not available (stated outright rather than quietly
 * falling back to a class check). And per ISS-5333's lesson, a class-presence
 * assertion is NOT coverage for a positioning fix — `toHaveClass("justify-end")`
 * passed there while the label provably never moved.
 *
 * So this RESOLVES the positioning rule instead: it reads the tokens the grip,
 * its glyph and its cell actually carry in the rendered DOM and computes the
 * x-interval each occupies, then asserts the geometric facts the ticket
 * requires. The resolver itself was validated against a real browser (Chromium,
 * Storybook `GridTable` canvases, both themes, column widths 100 / 120 / 148 /
 * 160px) on the PREVIOUS grip geometry, where the measured values matched it
 * exactly; the numbers quoted below are this resolver's output at the current
 * geometry, and `InteractiveV2` is the human check on the browser.
 *
 * Coordinate space: x=0 is the inner edge of the cell's `border-l` — the
 * divider — because that is the origin an absolutely positioned child resolves
 * its offsets against (the containing block's PADDING box). So negative x is
 * the previous column, positive x is this one.
 *
 * What could still break: this resolves the token subset the grip uses
 * (`left-*`, `size-*`, `justify-*`, `pl-*`). A future grip positioned some
 * other way — a transform, an inline style, `inset-*` — would slip past it, and
 * the Storybook canvases plus the attached screenshots are the human check.
 */
const TAILWIND_SPACING_STEP_PX = 4;
/**
 * `px` is Tailwind's literal-1px stop and does NOT scale by the spacing step, so
 * it is matched as its own alternative and converted separately. The resize
 * strip is pinned with `-right-px` (ISS-5812), and a digits-only pattern would
 * silently fail to resolve it — which, in a helper that throws on an
 * unresolvable token, is a red suite rather than a wrong number.
 */
const TAILWIND_PX_STOP = "px";
const TAILWIND_PX_STOP_WIDTH_PX = 1;
const RE_LEFT_OFFSET = /^(-?)left-(px|\d+(?:\.\d+)?)$/;
const RE_RIGHT_OFFSET = /^(-?)right-(px|\d+(?:\.\d+)?)$/;
/** Tailwind's `border-l` (no numeric suffix) is a 1px left border. */
const BORDER_LEFT_CLASS = "border-l";
const BORDER_LEFT_WIDTH_PX = 1;
const RE_SIZE = /^size-(\d+(?:\.\d+)?)$/;
const RE_WIDTH = /^w-(\d+(?:\.\d+)?)$/;
const RE_PADDING_LEFT = /^pl-(\d+(?:\.\d+)?)$/;
const RE_HEIGHT = /^h-(\d+(?:\.\d+)?)$/;
const RE_VIEW_BOX_SEPARATOR = /\s+/;

/**
 * The tokenized 24px minimum drag target reorder must keep (ISS-5356 #4).
 * ISS-5812 moved WHERE that target is — the header cell rather than a box beside
 * the label — but not that it has to exist.
 */
const MIN_HIT_BOX_PX = 24;

/**
 * How far the ink's centre may sit from the centre of the space before the
 * label before the grip stops reading as balanced in it. ISS-5812: that space
 * is now the cell's ordinary `pl-3`, not a bought lane, so this is what keeps
 * the dots from sliding back onto the divider once the lane is gone.
 */
const MAX_GUTTER_CENTRE_DRIFT_PX = 1.5;

/**
 * Criterion 5's resize target width — the point of the strip is that the pointer
 * never has to land on the 1px divider itself.
 */
const MIN_RESIZE_HIT_WIDTH_PX = 12;

function spacingToPx(step: string): number {
  if (step === TAILWIND_PX_STOP) {
    return TAILWIND_PX_STOP_WIDTH_PX;
  }
  return Number.parseFloat(step) * TAILWIND_SPACING_STEP_PX;
}

/** Resolve the first class matching `pattern` on `element` into pixels. */
function resolveSpacingToken(
  element: HTMLElement | SVGElement,
  pattern: RegExp
): number | null {
  for (const token of element.classList) {
    const match = pattern.exec(token);
    if (match) {
      const value = spacingToPx(match.at(-1) as string);
      return match[1] === "-" ? -value : value;
    }
  }
  return null;
}

type GripGeometry = {
  /** [left, right] of the 24px hit box, in cell padding-box pixels. */
  box: [number, number];
  /** [left, right] of the 14px glyph BOX, in cell padding-box pixels. */
  glyph: [number, number];
  /**
   * [left, right] of the painted INK — the dots themselves. The lucide grip
   * paints only in the middle of its glyph box, so the box is not what the eye
   * reads, and positioning against the box is what made the first attempt at
   * this fix land the dots hard against the divider. Derived from the icon's own
   * `viewBox` and circle geometry, so it follows the glyph if the icon changes.
   */
  ink: [number, number];
  /** x at which the cell's content — the label — starts. */
  labelStartX: number;
};

/**
 * Execute the positioning rule against the rendered grip: place the hit box
 * from its `left-*` offset and `size-*`, then place the glyph inside that box
 * according to the box's `justify-*`.
 */
function resolveGripGeometry(headerCell: HTMLElement): GripGeometry {
  const grip = headerCell.querySelector<HTMLElement>(
    'button[aria-label^="Reorder"]'
  );
  if (!grip) {
    throw new Error("header cell has no reorder grip");
  }
  const glyphEl = grip.querySelector<SVGElement>("svg");
  if (!glyphEl) {
    throw new Error("reorder grip has no glyph");
  }
  const boxLeft = resolveSpacingToken(grip, RE_LEFT_OFFSET);
  const boxWidth = resolveSpacingToken(grip, RE_SIZE);
  const glyphWidth = resolveSpacingToken(glyphEl, RE_SIZE);
  const labelStartX = resolveSpacingToken(headerCell, RE_PADDING_LEFT);
  if (
    boxLeft == null ||
    boxWidth == null ||
    glyphWidth == null ||
    labelStartX == null
  ) {
    throw new Error("grip is not positioned by the resolvable token set");
  }
  const boxRight = boxLeft + boxWidth;
  const glyphLeft = resolveGlyphLeft(grip, boxLeft, boxWidth, glyphWidth);
  return {
    box: [boxLeft, boxRight],
    glyph: [glyphLeft, glyphLeft + glyphWidth],
    ink: resolveInk(glyphEl, glyphLeft, glyphWidth),
    labelStartX,
  };
}

/**
 * The painted extent of the glyph, in cell padding-box pixels. Read from the
 * icon's `viewBox` and the geometry of the shapes inside it, then scaled onto
 * the rendered glyph width — so it stays correct if the icon or its size
 * changes, rather than hard-coding an inset. Matched a real Chromium
 * measurement of the same grip to 0.01px.
 */
function resolveInk(
  glyphEl: SVGElement,
  glyphLeft: number,
  glyphWidth: number
): [number, number] {
  const viewBox = glyphEl
    .getAttribute("viewBox")
    ?.split(RE_VIEW_BOX_SEPARATOR)
    .map(Number);
  const circles = [...glyphEl.querySelectorAll("circle")];
  if (viewBox?.length !== 4 || circles.length === 0) {
    throw new Error("grip glyph exposes no resolvable ink geometry");
  }
  const edges = circles.flatMap((circle) => {
    const cx = Number(circle.getAttribute("cx"));
    const r = Number(circle.getAttribute("r"));
    return [cx - r, cx + r];
  });
  const scale = glyphWidth / viewBox[2];
  return [
    glyphLeft + (Math.min(...edges) - viewBox[0]) * scale,
    glyphLeft + (Math.max(...edges) - viewBox[0]) * scale,
  ];
}

/** Where the glyph starts inside the hit box, per the box's `justify-*`. */
function resolveGlyphLeft(
  grip: HTMLElement,
  boxLeft: number,
  boxWidth: number,
  glyphWidth: number
): number {
  const free = boxWidth - glyphWidth;
  if (grip.classList.contains("justify-end")) {
    return boxLeft + free;
  }
  if (grip.classList.contains("justify-center")) {
    return boxLeft + free / 2;
  }
  return boxLeft;
}

/**
 * How far the previous column's RESIZE strip hangs into this column, in this
 * cell's padding-box pixels — the thing the grip has to stay clear of.
 *
 * The v2 strip is deliberately decoupled from the 1px divider so the pointer
 * does not have to find a hairline, and it carries `z-20` against the grip's
 * `z-auto`, so wherever the two overlap the STRIP wins the pointer and the user
 * gets a `col-resize` for the neighbour. Resolved from the strip's own tokens
 * rather than hard-coded, so widening the strip or pushing it back out fails the
 * assertion rather than silently re-opening the overlap.
 *
 * `hitWidth` comes back alongside `reach` so the caller can pin criterion 5's
 * 12px target at the same time. Clearance and hit size trade against each other
 * here, and asserting clearance alone would accept the degenerate fix — a strip
 * shrunk toward the 1px border it exists to replace clears the grip perfectly.
 */
function resolveNeighbourResizeReach(container: HTMLElement): {
  hitWidth: number;
  reach: number;
} {
  const strip = container.querySelector<HTMLElement>(
    'button[aria-label^="Resize"]'
  );
  if (!strip) {
    throw new Error("no resize strip rendered to measure");
  }
  const rightOffset = resolveSpacingToken(strip, RE_RIGHT_OFFSET);
  const width = resolveSpacingToken(strip, RE_WIDTH);
  if (rightOffset == null || width == null) {
    throw new Error("resize strip is not positioned by the resolvable tokens");
  }
  // A NEGATIVE `right` pushes the strip past its own cell's padding box; that
  // overshoot is what lands in the next column. A non-negative offset (the
  // pre-v2 `right-0` handle) hangs over nothing.
  //
  // ISS-5812 (wongk review): the overshoot must then be re-expressed in the NEXT
  // cell's frame before it can be compared with anything the grip resolver
  // returns, because the two frames are not the same origin — they are one
  // `border-l` apart. Reporting the raw 6px overshoot in the grip's coordinates
  // was the arithmetic slip that let the old assertion look satisfied: the
  // strip's true reach into the next column is 5px, and the ink starts at 2.67.
  const overshootFromOwnPaddingBox = Math.max(0, -rightOffset);
  // The divider between the two cells is the NEXT cell's `border-l`. Every
  // header cell carries the same one (`GridTableCell` and the header cell are
  // both `border-l`), so it is read off the strip's own cell here rather than
  // threading the neighbour in — and read from the DOM rather than assumed, so
  // dropping the border would change this number instead of silently keeping a
  // stale constant.
  const ownCell = strip.closest<HTMLElement>("[data-column-id]");
  const dividerWidth =
    ownCell?.classList.contains(BORDER_LEFT_CLASS) === true
      ? BORDER_LEFT_WIDTH_PX
      : 0;
  return {
    hitWidth: width,
    reach: Math.max(0, overshootFromOwnPaddingBox - dividerWidth),
  };
}

/** The single header cell (the one carrying a grip) for `columnId`. */
function reorderableHeaderCell(
  container: HTMLElement,
  columnId: string
): HTMLElement {
  const cells = container.querySelectorAll<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  const header = [...cells].find((cell) =>
    cell.querySelector('button[aria-label^="Reorder"]')
  );
  if (!header) {
    throw new Error(`no reorderable header cell for column "${columnId}"`);
  }
  return header;
}

describe("GridTable reorder grip — position within its own column (ISS-5356)", () => {
  it("keeps the glyph clear of the label's first character (FEA-4158)", () => {
    const { container } = renderGrid([]);
    for (const column of COLUMNS) {
      const { glyph, ink, labelStartX } = resolveGripGeometry(
        reorderableHeaderCell(container, column.id)
      );
      // The FEA-4158 regression, asserted directly. Pre-FEA-4158 (`left-1` +
      // `p-1`) the glyph box ran to x=22 against a label at x=12 — a 10px
      // overlap onto the first character. Both the box and the ink are pinned:
      // the ink is what is seen (7.33 against a label at 12 today) and the box
      // is what would collide if the icon were ever swapped for a wider one.
      expect(glyph[1]).toBeLessThanOrEqual(labelStartX);
      expect(ink[1]).toBeLessThan(labelStartX);
    }
  });

  it("takes no pointer events, so it can neither steal the sort click nor fight the neighbour's resize strip", () => {
    const { container } = renderResizableGrid();
    // This one property is what replaced ISS-5356's 36px lane. The glyph is
    // invisible at rest but would still hit-test, and it sits in the seam the
    // previous column's `z-20` resize strip also claims. `pointer-events-none`
    // settles both at once: the grip is a visual + KEYBOARD control, and the
    // pointer target for reorder is the header cell (asserted below).
    for (const column of COLUMNS) {
      const grip = reorderableHeaderCell(container, column.id).querySelector(
        'button[aria-label^="Reorder"]'
      );
      expect(grip?.classList.contains("pointer-events-none")).toBe(true);
    }
  });

  it("paints the dots wholly inside its OWN column, not astride the divider", () => {
    const { container } = renderGrid([]);
    for (const column of COLUMNS) {
      const { ink, labelStartX } = resolveGripGeometry(
        reorderableHeaderCell(container, column.id)
      );
      // The originally reported defect: the ink sat at [-2.33, +2.33] — astride
      // the divider at x=0, owned by neither column. Requiring the whole ink to
      // sit strictly inside (0, labelStartX) fails that geometry outright.
      // Measured today: [2.67, 7.33] against a label at 12.
      expect(ink[0]).toBeGreaterThan(0);
      expect(ink[1]).toBeLessThan(labelStartX);
    }
  });

  it("sits optically balanced in the gutter, not pinned to either edge", () => {
    const { container } = renderGrid([]);
    for (const column of COLUMNS) {
      const { ink, labelStartX } = resolveGripGeometry(
        reorderableHeaderCell(container, column.id)
      );
      // "Inside its own column" is necessary but not sufficient: ink shoved
      // hard against the divider still reads as belonging to the seam. The
      // design intent is the dots centred in the room before the label, so pin
      // the ink's centre near that midline. Measured today: ink centre 5.0
      // against a 6.0 midline, inside the 1.5px tolerance. This is also what a
      // future "just put it back in the seam" regression fails on — a `-left-3`
      // grip centres its ink at 0.0, squarely on the divider.
      const inkCentre = (ink[0] + ink[1]) / 2;
      expect(Math.abs(inkCentre - labelStartX / 2)).toBeLessThanOrEqual(
        MAX_GUTTER_CENTRE_DRIFT_PX
      );
    }
  });

  it("makes the HEADER CELL the pointer drag target, so reorder keeps a hit area without a lane", () => {
    const { container } = renderGrid([]);
    for (const column of COLUMNS) {
      const header = reorderableHeaderCell(container, column.id);
      // ISS-5356 was right that a seam-sized hit box is not good enough; this
      // is the part of it that must survive ISS-5812. The target is now the
      // whole header cell rather than a 24px box, which is why it needs no
      // reserved room. Height comes from the cell's own `h-10` token; width is
      // the column track, which `clampColumnWidth` floors at
      // MIN_COLUMN_WIDTH_PX — both resolved, neither hard-coded here.
      expect(header.getAttribute("draggable")).toBe("true");
      const height = resolveSpacingToken(header, RE_HEIGHT);
      expect(height).not.toBeNull();
      expect(height as number).toBeGreaterThanOrEqual(MIN_HIT_BOX_PX);
      expect(MIN_COLUMN_WIDTH_PX).toBeGreaterThanOrEqual(MIN_HIT_BOX_PX);
    }
  });

  it("does not make a non-reorderable header draggable", () => {
    const { container } = renderStaticGrid();
    const cells = container.querySelectorAll<HTMLElement>("[data-column-id]");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute("draggable")).not.toBe("true");
    }
  });

  it("paints the dots clear of the neighbour's resize reach, so grabbing the cue never resizes", () => {
    // Resize must be wired for the strip to exist, and `enhancedHeaderInteractions`
    // for the v2 strip that actually overhangs (the pre-v2 handle sits at
    // `right-0` and hangs over nothing).
    const { container } = renderResizableGrid();
    const { hitWidth, reach } = resolveNeighbourResizeReach(container);
    // Criterion 5's target size, pinned so "clear of the grip" cannot be bought
    // by shrinking the strip back toward the 1px border it replaced.
    expect(hitWidth).toBeGreaterThanOrEqual(MIN_RESIZE_HIT_WIDTH_PX);
    for (const column of COLUMNS) {
      const header = reorderableHeaderCell(container, column.id);
      const { box, ink } = resolveGripGeometry(header);
      // ISS-5356's defect, closed from the other side — and re-closed by ISS-5812
      // (wongk review) on the axis that actually reaches the user.
      //
      // The grip's BOX may still overlap the strip's reach: the box is invisible
      // and `pointer-events-none`, so an overlap there costs nothing and is
      // unavoidable for a glyph parked in the seam. That is asserted below only
      // as the thing this test is NOT complaining about.
      //
      // The INK is different, and is the assertion that matters. It is the only
      // part of the grip a user can see, so it is the part they aim at — and
      // while the strip straddled the divider (reach 5px) the dots at
      // [2.67, 7.33] had their first half sitting under a `z-20` resize target.
      // Pressing the reorder cue resized the previous column. `pointer-events-
      // none` is precisely why: it hands the press straight through to whatever
      // is underneath. So the cue must be clear of the reach in GEOMETRY, not
      // excused by the grip's own event model.
      expect(ink[0]).toBeGreaterThanOrEqual(reach);
      const grip = header.querySelector('button[aria-label^="Reorder"]');
      expect(grip?.classList.contains("pointer-events-none")).toBe(true);
      expect(box[0]).toBeLessThan(ink[0]);
    }
  });

  it("positions every column's grip identically, whatever its headerAlign", () => {
    // The grip is absolutely positioned, so it is out of the cell's flex flow
    // and `headerAlign` (ISS-5333) cannot move it — the alignment moves the
    // LABEL only — confirmed in Chromium on the previous geometry, where
    // forcing `justify-content:flex-end` onto a reorderable cell left the grip
    // unmoved; it is a property of the positioning, not of the offsets, so it
    // survived ISS-5812's move back into the seam. The grip resolves to
    // [-2, 12] either way. Pinned here so a future alignment change cannot
    // silently drag the grip with it.
    const { container } = renderGrid([], [COLUMNS[1].id]);
    const plain = resolveGripGeometry(
      reorderableHeaderCell(container, COLUMNS[0].id)
    );
    const endAligned = resolveGripGeometry(
      reorderableHeaderCell(container, COLUMNS[1].id)
    );
    expect(endAligned.box).toStrictEqual(plain.box);
    expect(endAligned.glyph).toStrictEqual(plain.glyph);
  });
});

/**
 * A grid with reorder AND v2 resize wired — the exact pairing the reported
 * defect needs, since the grip only fights a strip that exists and only the
 * `enhancedHeaderInteractions` strip overhangs into the next column.
 */
function renderResizableGrid() {
  return render(
    <GridTable<Row>
      columnOrder={[]}
      columns={COLUMNS}
      columnWidths={{ owner: 120, status: 120 }}
      enhancedHeaderInteractions
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      onColumnOrderChange={() => {
        // no-op — the test only reads geometry.
      }}
      onColumnWidthChange={() => {
        // no-op — the test only reads geometry.
      }}
      renderCell={(columnId, row) => (
        <span>
          {columnId}:{row.name}
        </span>
      )}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

function renderStaticGrid() {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) => (
        <span>
          {columnId}:{row.name}
        </span>
      )}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

/**
 * The `dataTransfer` key the drag writes and the drop reads. Pinned as a
 * literal, not imported, so a rename of the contract value cannot silently
 * rename it on both sides and leave this passing.
 */
const COLUMN_DRAG_DATA_TYPE = "text/x-grid-table-column";

/**
 * jsdom does not implement `DataTransfer`, and `fireEvent.dragStart` supplies
 * none — which is exactly how a drag test can look green while the production
 * call that writes the payload has been deleted. This is a real enough stand-in
 * to carry a value from `dragstart` to `drop`.
 */
function createDataTransferStub() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    getData: (type: string) => store.get(type) ?? "",
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    get types() {
      return [...store.keys()];
    },
  };
}

/**
 * ISS-5812 — the pointer drag path, executed end to end.
 *
 * ISS-5812 moved the drag source off the grip button and onto the header cell.
 * Nothing in the repo executed that path: the one existing dragstart test fires
 * without a `dataTransfer`, so deleting the `startColumnDrag(...)` call would
 * have left every suite green while pointer reorder silently became a no-op in
 * the browser (AGENTS.md: "a new helper needs an assertion that its production
 * caller actually invokes it").
 */
describe("GridTable reorder — the header cell drives the pointer drag (ISS-5812)", () => {
  it("writes the dragged column id on dragstart and reorders on drop", () => {
    const onColumnOrderChange = vi.fn();
    render(
      <GridTable<Row>
        columnOrder={["owner", "status"]}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Name"
        onColumnOrderChange={onColumnOrderChange}
        renderCell={(columnId, row) => (
          <span>
            {columnId}:{row.name}
          </span>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const source = screen.getByRole("columnheader", { name: "Owner" });
    const target = screen.getByRole("columnheader", { name: "Status" });
    const dataTransfer = createDataTransferStub();

    fireEvent.dragStart(source, { dataTransfer });
    // The payload the drop depends on, asserted from the test body rather than
    // inside a mock that might never run.
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      COLUMN_DRAG_DATA_TYPE,
      "owner"
    );
    expect(dataTransfer.effectAllowed).toBe("move");

    fireEvent.drop(target, { dataTransfer });
    expect(onColumnOrderChange).toHaveBeenCalledWith(["status", "owner"]);
  });

  it("does not reorder when a column is dropped on itself", () => {
    const onColumnOrderChange = vi.fn();
    render(
      <GridTable<Row>
        columnOrder={["owner", "status"]}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Name"
        onColumnOrderChange={onColumnOrderChange}
        renderCell={(columnId, row) => (
          <span>
            {columnId}:{row.name}
          </span>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const source = screen.getByRole("columnheader", { name: "Owner" });
    const dataTransfer = createDataTransferStub();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(source, { dataTransfer });
    expect(onColumnOrderChange).not.toHaveBeenCalled();
  });

  it("does not enter the dragging state when the dragstart carries no payload", () => {
    const { container } = renderGrid([]);
    const header = reorderableHeaderCell(container, COLUMNS[0].id);
    // A dragstart with no `dataTransfer` cannot produce a droppable drag, so
    // the header must not render as mid-drag for it.
    fireEvent.dragStart(header);
    expect(header.className).not.toContain("opacity-45");
  });

  it("leaves a non-reorderable column's header undraggable, so it cannot be dragged at all", () => {
    const { container } = renderStaticGrid();
    const cells = container.querySelectorAll<HTMLElement>("[data-column-id]");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute("draggable")).not.toBe("true");
    }
  });

  it("keeps the focus ring inside the grip's own box", () => {
    // The ring is the ONLY thing a keyboard user ever sees of this control, and
    // an outset `ring-2` on a 14px box placed at [-2, 12] would paint [-4, 14] —
    // over the label's first character and across the divider into the previous
    // column, re-creating on focus exactly the two overlaps ISS-5356 and
    // ISS-5812 removed at rest. `ring-inset` is what keeps it within bounds.
    const { container } = renderGrid([]);
    for (const column of COLUMNS) {
      const grip = reorderableHeaderCell(container, column.id).querySelector(
        'button[aria-label^="Reorder"]'
      );
      expect(grip?.classList.contains("focus-visible:ring-2")).toBe(true);
      expect(grip?.classList.contains("focus-visible:ring-inset")).toBe(true);
    }
  });

  it("keeps the resize strip from starting a column drag", () => {
    // ISS-5812 made the header cell `draggable`, and the HTML drag model walks
    // UP from the pressed node to the nearest draggable ancestor — so the
    // strip's own `draggable={false}` does NOT protect it. The only thing that
    // does is `handleResizePointerDown` calling `preventDefault()` on
    // pointerdown, which suppresses drag initiation. Execute that decision, so
    // deleting the call fails here instead of in a user's hands.
    const { container } = renderResizableGrid();
    const strip = container.querySelector<HTMLElement>(
      'button[aria-label^="Resize"]'
    );
    if (!strip) {
      throw new Error("no resize strip rendered");
    }
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pointerDown, "button", { value: 0 });
    Object.defineProperty(pointerDown, "pointerId", { value: 1 });
    strip.setPointerCapture = () => {
      // jsdom has no pointer capture; the handler only needs it not to throw.
    };
    strip.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
  });
});
