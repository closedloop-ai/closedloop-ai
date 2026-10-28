import {
  GridTable,
  type GridTableColumn,
} from "@closedloop-ai/design-system/components/ui/grid-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-6959 — `GridTable`'s `pinLeadColumn` opt-in, at the primitive.
 *
 * WHAT LAYER THIS COVERS: the component's own decision about WHICH cells get
 * the pinning classes and WHEN. jsdom neither lays out nor applies a
 * stylesheet, so `position: sticky` has no observable effect here and none of
 * these assertions prove a cell stays put under a real scroll — the consumer's
 * end-to-end proof of that is `e2e/branches-pinned-name-column.spec.ts`.
 *
 * What jsdom CAN settle, and what nothing else does, is the branching:
 *
 *  1. that the opt-in is genuinely opt-in, so the six other surfaces rendering
 *     this shared primitive (Sessions, Agents, Routines, Packs, Documents,
 *     Compliance) are untouched by a Branches-only change;
 *  2. that BOTH the header cell and the body cells are pinned. Pinning one
 *     without the other renders a column label that scrolls away from the value
 *     underneath it, or a value that scrolls away from its label — visually
 *     wrong, and silent;
 *  3. the leading-utility carve-out. That track owns `left: 0`, so an identity
 *     cell also pinned there would render ON TOP of the row checkbox rather
 *     than beside it. The prop documents this as a no-op; without a test the
 *     documented no-op and the code are free to disagree.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [{ id: "1", name: "Alpha" }];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

const TEMPLATE = "minmax(300px, 1fr) 190px 190px";
// With a leading utility track the identity cell moves to the SECOND track, so
// the template grows one to match — the state the carve-out is about.
const TEMPLATE_WITH_UTILITY = `52px ${TEMPLATE}`;

// Written out rather than imported from `lib/grid-table-pin.ts`: importing them
// would make this test agree with whatever that module currently says, which is
// the one thing it is here to police.
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";

describe("GridTable pinLeadColumn (ISS-6959)", () => {
  it("pins the leading header cell and the leading body cell when opted in", () => {
    renderGridTable({ pinLeadColumn: true });

    expect(leadHeaderCell()).toHaveClass(STICKY_CLASS);
    expect(leadHeaderCell()).toHaveClass(LEFT_EDGE_CLASS);
    expect(leadBodyCell()).toHaveClass(STICKY_CLASS);
    expect(leadBodyCell()).toHaveClass(LEFT_EDGE_CLASS);
  });

  // The sibling that gives the assertions above their meaning: the same table,
  // the same queries, the opt-in withheld, the opposite outcome. Every other
  // consumer of this primitive renders in exactly this state.
  it("leaves both leading cells unpinned by default", () => {
    renderGridTable({});

    expect(leadHeaderCell()).not.toHaveClass(STICKY_CLASS);
    expect(leadHeaderCell()).not.toHaveClass(LEFT_EDGE_CLASS);
    expect(leadBodyCell()).not.toHaveClass(STICKY_CLASS);
    expect(leadBodyCell()).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // The row is `grid h-11 items-center`, which sizes a grid item to its
  // CONTENT — so an unstretched lead cell is ~28px tall in a 44px row and its
  // opaque surface leaves an 8px band top and bottom for the scrolling columns
  // to show through. Every sibling cell already carries `h-full`; the lead cell
  // did not, because until it was pinned it painted nothing. Measured on a real
  // layout engine (visual QA, 2026-08-28) at 40px against a 43px data cell.
  it("stretches the pinned cell to the full row height", () => {
    renderGridTable({ pinLeadColumn: true });

    expect(leadBodyCell()).toHaveClass("h-full");
  });

  // Pinning does not merely fail to ADD an edge — it REMOVES the one that
  // exists at rest, because the neighbour's `border-l` scrolls away underneath
  // the pin and a fresh one arrives every column-width, so the seam flickers.
  it("draws its own right-hand rule so the seam survives the scroll", () => {
    renderGridTable({ pinLeadColumn: true });

    expect(leadBodyCell()).toHaveClass("after:-right-px");
    expect(leadBodyCell()).toHaveClass("after:bg-border");
  });

  // The tint's COLOUR is inert without the overlay's GEOMETRY: strip
  // `before:absolute before:inset-0` and the pseudo-element collapses to a
  // zero-sized static box, so the pinned cell paints no tint at all while the
  // rest of its row does — and an assertion on the colour class alone stays
  // green through exactly that mutation.
  it("gives the tint overlay the geometry that makes it render", () => {
    renderGridTable({ pinLeadColumn: true });

    const cell = leadBodyCell();
    expect(cell).toHaveClass("before:absolute");
    expect(cell).toHaveClass("before:inset-0");
    expect(cell).toHaveClass("before:-z-10");
    expect(cell).toHaveClass("before:content-['']");
  });

  // Selection BEATS hover on the row, so it has to beat hover on the pinned
  // cell too or the one cell identifying the row flicks to the neutral hover
  // grey while the rest of the row holds its selected tint. Asserted as a
  // matched pair — each state's tint present AND the other's absent — so the
  // ternary cannot be swapped without going red.
  it("mirrors selection-beats-hover on the pinned cell", () => {
    renderGridTable({ isRowSelected: () => true, pinLeadColumn: true });

    expect(leadBodyCell()).toHaveClass("before:bg-primary/10");
    expect(leadBodyCell()).not.toHaveClass("group-hover:before:bg-muted/40");
  });

  it("gives an unselected pinned cell the hover tint and not the selected one", () => {
    renderGridTable({ isRowSelected: () => false, pinLeadColumn: true });

    expect(leadBodyCell()).toHaveClass("group-hover:before:bg-muted/40");
    expect(leadBodyCell()).not.toHaveClass("before:bg-primary/10");
  });

  it("declines to pin the identity cell onto a leading utility track", () => {
    renderGridTable({
      gridTemplateColumns: TEMPLATE_WITH_UTILITY,
      leadingUtilityHeader: <span>All</span>,
      pinLeadColumn: true,
      renderLeadingUtility: () => (
        <input aria-label="Select row" type="checkbox" />
      ),
    });

    // The utility cell holds `left: 0`; the identity cell must not be parked on
    // top of it. Asserted on the identity cell, and paired with the positive
    // case above so "no sticky anywhere" cannot be what makes this pass.
    expect(leadBodyCell()).not.toHaveClass(STICKY_CLASS);
    expect(screen.getByLabelText("Select row")).toBeInTheDocument();
  });
});

function renderGridTable(
  overrides: Partial<React.ComponentProps<typeof GridTable<Row>>>
) {
  render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId) => columnId}
      renderLead={(row) => <span>{row.name}</span>}
      {...overrides}
    />
  );
}

function leadHeaderCell(): HTMLElement {
  return screen.getByRole("columnheader", { name: "Name" });
}

/** The identity cell, located through the value it renders rather than by index. */
function leadBodyCell(): HTMLElement {
  const cell = screen
    .getByText(ROWS[0].name)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("lead value is not inside a table cell");
  }
  return cell;
}
