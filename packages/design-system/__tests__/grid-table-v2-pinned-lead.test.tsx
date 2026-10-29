import {
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9223 — `GridTableV2`'s `pinLeadColumn`, at the primitive, including the
 * case v1 declines: a leading UTILITY track (favourite star, checkbox) sitting
 * ahead of the identity cell.
 *
 * v2 pins the REGION rather than skipping the pin there. The utility cell holds
 * `left: 0` and the identity cell parks one track in. Skipping it left every
 * surface that renders a favourite star — which is both Sessions hosts —
 * receiving `pinLeadColumn` and rendering nothing different, the silent-no-op
 * this ticket family is about.
 *
 * jsdom neither lays out nor applies a stylesheet, so `position: sticky` has no
 * observable effect here; what these settle is WHICH cells get the classes and
 * WHEN. The consumer-level proof of the same chain is
 * `packages/app/agents/components/sessions/__tests__/sessions-pinned-lead-column.test.tsx`.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [{ id: "1", name: "Alpha" }];
const COLUMNS: GridTableV2Column[] = [{ id: "status", label: "Status" }];
const TEMPLATE = "240px 190px";
const TEMPLATE_WITH_UTILITY = `${GRID_TABLE_V2_FAVORITE_TRACK} ${TEMPLATE}`;

// Written out rather than imported from `lib/grid-table-pin.ts`: importing them
// would make this test agree with whatever that module currently says, which is
// the one thing it is here to police.
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";
/**
 * The offset the identity cell parks at behind the FAVOURITE track every caller
 * in this repo declares. Read off the element's inline `left` rather than a
 * class: `gridTemplateColumns` is arbitrary, so the anchor is derived from the
 * caller's own leading track and cannot be a statically-scanned class.
 */
const UTILITY_OFFSET_PX = "36px";
/**
 * A leading utility track that is NOT the 36px one, for the case a hardcoded
 * `left-9` got wrong: the identity cell has to clear the track the caller
 * actually declared, or the two pinned cells overlap by 16px.
 */
const WIDE_UTILITY_TRACK = "52px";
/** The lead header's accessible name also carries its sort affordance. */
const LEAD_HEADER_PATTERN = /name/i;

describe("GridTableV2 pinLeadColumn (ISS-9223)", () => {
  it("pins the identity header and body cells at the left edge", () => {
    renderGrid({ pinLeadColumn: true });

    for (const cell of [leadHeaderCell(), leadBodyCell()]) {
      expect(cell).toHaveClass(STICKY_CLASS);
      expect(cell).toHaveClass(LEFT_EDGE_CLASS);
    }
  });

  it("leaves both identity cells unpinned by default", () => {
    renderGrid({});

    for (const cell of [leadHeaderCell(), leadBodyCell()]) {
      expect(cell).not.toHaveClass(STICKY_CLASS);
      expect(cell).not.toHaveClass(LEFT_EDGE_CLASS);
    }
    expect(leadHeaderCell()).toHaveClass("hover:bg-muted/40");
  });

  it("keeps the pinned header's hover tint above its opaque surface", () => {
    renderGrid(withUtilityTrack({ pinLeadColumn: true }));

    expect(leadHeaderCell()).toHaveClass(
      "bg-[var(--grid-table-surface,var(--background))]"
    );
    expect(leadHeaderCell()).toHaveClass("hover:before:bg-muted/40");
    expect(leadHeaderCell()).toHaveClass("before:transition-colors");
    expect(leadHeaderCell()).toHaveClass("z-[var(--z-pinned-header)]");
    expect(leadHeaderCell()).not.toHaveClass("z-[var(--z-pinned-column)]");
    expect(screen.getByRole("columnheader", { name: "Favorite" })).toHaveClass(
      "z-[var(--z-pinned-header)]"
    );
    expect(leadHeaderCell()).not.toHaveClass("hover:bg-muted/40");
  });

  it("pins the utility track and offsets the identity cell behind it", () => {
    renderGrid(withUtilityTrack({ pinLeadColumn: true }));

    expect(utilityBodyCell()).toHaveClass(STICKY_CLASS);
    expect(utilityBodyCell()).toHaveClass(LEFT_EDGE_CLASS);
    expect(leadBodyCell()).toHaveClass(STICKY_CLASS);
    expect(leadBodyCell().style.left).toBe(UTILITY_OFFSET_PX);
    expect(leadBodyCell()).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // The header must make the same offset choice as the body, or the column
  // label scrolls away from the values underneath it.
  it("offsets the identity header by the same track as the body", () => {
    renderGrid(withUtilityTrack({ pinLeadColumn: true }));

    expect(leadHeaderCell().style.left).toBe(UTILITY_OFFSET_PX);
    expect(leadHeaderCell()).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // The case a hardcoded `left-9` shipped wrong. `gridTemplateColumns` is
  // arbitrary and is not part of any narrower contract, so a consumer is free
  // to declare a utility track of its own width — and the identity cell has to
  // clear THAT, or it parks 16px on top of the control beside it. Both runs
  // read the same template, so the header is asserted too.
  it("offsets the identity cells by a utility track that is not the favourite width", () => {
    renderGrid(
      withUtilityTrack({
        gridTemplateColumns: `${WIDE_UTILITY_TRACK} ${TEMPLATE}`,
        pinLeadColumn: true,
      })
    );

    expect(utilityBodyCell()).toHaveClass(LEFT_EDGE_CLASS);
    for (const cell of [leadHeaderCell(), leadBodyCell()]) {
      expect(cell).toHaveClass(STICKY_CLASS);
      expect(cell.style.left).toBe(WIDE_UTILITY_TRACK);
    }
  });

  // A leading track no sticky `left` can be anchored to (`minmax(…)` resolves
  // to a width only the layout engine knows, and `left: minmax(…)` is dropped
  // by the browser). The pin degrades to the documented utility width rather
  // than emitting an invalid declaration that would silently unpin the cell.
  it("falls back to the documented utility width when the leading track is not a length", () => {
    renderGrid(
      withUtilityTrack({
        gridTemplateColumns: `minmax(36px, 1fr) ${TEMPLATE}`,
        pinLeadColumn: true,
      })
    );

    expect(leadBodyCell().style.left).toBe(GRID_TABLE_V2_FAVORITE_TRACK);
  });
});

function withUtilityTrack(
  overrides: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
): Partial<React.ComponentProps<typeof GridTableV2<Row>>> {
  return {
    gridTemplateColumns: TEMPLATE_WITH_UTILITY,
    leadingUtilityLabel: "Favorite",
    renderLeadingUtility: () => (
      <button type="button">{UTILITY_CONTROL_LABEL}</button>
    ),
    ...overrides,
  };
}

function renderGrid(
  overrides: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      mode="expanded"
      renderCell={(columnId) => columnId}
      renderLead={(row) => <span>{row.name}</span>}
      {...overrides}
    />
  );
}

function leadHeaderCell(): HTMLElement {
  return screen.getByRole("columnheader", { name: LEAD_HEADER_PATTERN });
}

function leadBodyCell(): HTMLElement {
  return closestCell(screen.getByText(ROWS[0].name), "lead value");
}

function utilityBodyCell(): HTMLElement {
  return closestCell(
    screen.getByRole("button", { name: UTILITY_CONTROL_LABEL }),
    "utility control"
  );
}

function closestCell(node: HTMLElement, what: string): HTMLElement {
  const cell = node.closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`${what} is not inside a table cell`);
  }
  return cell;
}

const UTILITY_CONTROL_LABEL = "Favorite Alpha";
