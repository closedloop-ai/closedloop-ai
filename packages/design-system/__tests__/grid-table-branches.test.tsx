/**
 * ISS-11299 — branch coverage for `GridTable` (v1, `components/ui/grid-table.tsx`)
 * that the existing suites (`grid-table.test.tsx`, `grid-table-pinned-lead.test.tsx`)
 * do not exercise: the resize-width fallback chain, group collapse/expand state,
 * the inline `handleCellKeyDown` keyboard contract this file keeps its own copy
 * of (distinct from `GridTableV2`'s), the leading-utility nav entry point, the
 * roving-tabindex "still valid" retention branch, every guard inside the row
 * click handler, the card-list group-collapse branch, and the standalone
 * `GridTableCell` primitive's colIndex-less role suppression.
 *
 * Every test asserts DOM/aria/callback-argument outcomes that fail under the
 * mutation of the branch it targets — never an execute-only render.
 */

import {
  GridTable,
  GridTableCell,
  type GridTableColumn,
  type GridTableGroup,
} from "@closedloop-ai/design-system/components/ui/grid-table";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string; owner: string; status: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha", owner: "ada", status: "Active" },
  { id: "2", name: "Beta", owner: "linus", status: "Done" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
];

const TEMPLATE = "minmax(200px, 1fr) 160px 160px";

/** Any resize handle, whatever width its name currently states. */
const ANY_OWNER_RESIZE_HANDLE = /^Resize Owner column,/;
const TEAM_A_HEADER_NAME = /Team A/;

function renderGridTable(
  overrides: Partial<React.ComponentProps<typeof GridTable<Row>>> = {}
) {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : row.status
      }
      renderLead={(row) => <span>{row.name}</span>}
      {...overrides}
    />
  );
}

/** The lead (identity) cell for a given row id, located by its rendered text. */
function leadCellOf(rowName: string): HTMLElement {
  const cell = screen
    .getByText(rowName)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`lead cell for ${rowName} not found`);
  }
  return cell;
}

/**
 * Real DOM focus, wrapped in `act` because a navigable cell's own `onFocus`
 * re-keys the roving tabindex — without `act`, that state update lands outside
 * React's batch and the subsequent `tabIndex` read is stale.
 */
function focusCell(cell: HTMLElement): void {
  act(() => cell.focus());
}

describe("GridTable resize width resolution (columnWidths ?? {} / ?? MIN_COLUMN_WIDTH_PX)", () => {
  it("omitting columnWidths keeps resize wired but leaves no column resizable", () => {
    // columnWidths absent + onColumnWidthChange present exercises the `??` RHS
    // (`Object.keys(columnWidths ?? {})` -> `Object.keys({})` -> []), so no
    // column id is ever a member of `resize.columnIds` and no handle renders.
    // A mutant that drops the `?? {}` fallback would throw on `Object.keys(undefined)`
    // instead, which this render (not just this query) would surface.
    renderGridTable({ onColumnWidthChange: vi.fn() });

    expect(
      screen.queryByRole("button", { name: ANY_OWNER_RESIZE_HANDLE })
    ).toBeNull();
  });

  it("a column present in columnWidths with an undefined width resizes FROM the shared 60px floor", () => {
    // A real own-enumerable key whose VALUE is undefined — the one runtime shape
    // that makes `columnWidths?.[columnId]` nullish while the id still sits in
    // `Object.keys(columnWidths)`, so `resize.columnIds` includes "owner" and the
    // handle renders. `getColumnWidth` is only actually CALLED (and this branch
    // only actually exercised) once a resize interaction reads a start width —
    // the v1 handle's accessible name does not restate the width, unlike v2's.
    const columnWidths: Record<string, number> = {};
    Object.defineProperty(columnWidths, "owner", {
      enumerable: true,
      value: undefined,
    });
    const onColumnWidthChange = vi.fn();

    renderGridTable({ columnWidths, onColumnWidthChange });
    const handle = screen.getByRole("button", {
      name: ANY_OWNER_RESIZE_HANDLE,
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    // 60 (MIN_COLUMN_WIDTH_PX, the `?? MIN_COLUMN_WIDTH_PX` fallback) + 16
    // (COLUMN_RESIZE_KEYBOARD_STEP_PX) = 76. A mutant that dropped the
    // fallback would instead start the resize from `NaN` and report `NaN`.
    expect(onColumnWidthChange).toHaveBeenCalledWith("owner", 76);
  });
});

describe("GridTable group collapse toggles the Set membership both ways", () => {
  const GROUPS: GridTableGroup<Row>[] = [
    { key: "team-a", label: "Team A", items: ROWS },
  ];

  it("collapsing hides the group's rows and re-expanding brings them back", () => {
    renderGridTable({ groups: GROUPS });

    const header = screen.getByRole("button", { name: TEAM_A_HEADER_NAME });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();

    // First click: "Team A" is not yet in `collapsedGroups` -> the `else` arm
    // (`next.add(key)`) runs. Both rows disappear from the rendered grid.
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();

    // Second click: "Team A" IS now in `collapsedGroups` -> the `then` arm
    // (`next.delete(key)`) runs. The rows return.
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});

describe("GridTable card-list group collapse (mode=compact)", () => {
  const GROUPS: GridTableGroup<Row>[] = [
    { key: "team-a", label: "Team A", items: [ROWS[0]] },
    { key: "team-b", label: "Team B", items: [ROWS[1]] },
  ];

  it("collapsing one group removes only that group's cards from the card list", () => {
    renderGridTable({
      cardRender: (row) => <div>{`card:${row.name}`}</div>,
      groups: GROUPS,
      mode: "compact",
    });

    expect(screen.getByText("card:Alpha")).toBeInTheDocument();
    expect(screen.getByText("card:Beta")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: TEAM_A_HEADER_NAME }));

    expect(screen.queryByText("card:Alpha")).toBeNull();
    // The sibling group is untouched, so this cannot pass from wiping the
    // whole card list rather than gating on THIS group's `isOpen`.
    expect(screen.getByText("card:Beta")).toBeInTheDocument();
  });
});

describe("GridTable handleCellKeyDown — Enter hands focus to the cell's control", () => {
  function renderWithButtonCell() {
    return renderGridTable({
      keyboardCellNavigation: true,
      renderCell: (columnId, row) =>
        columnId === "owner" ? (
          <button type="button">{`Edit ${row.name}`}</button>
        ) : (
          row.status
        ),
    });
  }

  it("Enter on a cell holding a control moves focus into the control", () => {
    renderWithButtonCell();
    const ownerCell = screen
      .getByRole("button", { name: "Edit Alpha" })
      .closest("[data-grid-cell]") as HTMLElement;
    focusCell(ownerCell);
    expect(document.activeElement).toBe(ownerCell);

    fireEvent.keyDown(ownerCell, { key: "Enter" });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit Alpha" })
    );
  });
});

describe("GridTable handleCellKeyDown — navigation skip / edge / same-cell branches", () => {
  function ownerCellOf(rowName: string): HTMLElement {
    const cell = leadCellOf(rowName).parentElement?.querySelector(
      '[data-grid-cell][data-column-id="owner"]'
    );
    if (!(cell instanceof HTMLElement)) {
      throw new Error(`owner cell for ${rowName} not found`);
    }
    return cell;
  }

  it("Alt+ArrowRight is skipped by shouldSkipGridNavigation and does not move focus", () => {
    renderGridTable({ keyboardCellNavigation: true });
    const lead = leadCellOf("Alpha");
    focusCell(lead);

    fireEvent.keyDown(lead, { key: "ArrowRight", altKey: true });

    expect(document.activeElement).toBe(lead);
  });

  it("a plain ArrowRight moves focus to the next cell", () => {
    renderGridTable({ keyboardCellNavigation: true });
    const lead = leadCellOf("Alpha");
    focusCell(lead);

    fireEvent.keyDown(lead, { key: "ArrowRight" });

    expect(document.activeElement).toBe(ownerCellOf("Alpha"));
    expect(document.activeElement).not.toBe(lead);
  });

  it("ArrowLeft off the first column resolves to no cell and leaves the key unclaimed", () => {
    renderGridTable({ keyboardCellNavigation: true });
    const lead = leadCellOf("Alpha");
    focusCell(lead);

    const notDefaultPrevented = fireEvent.keyDown(lead, { key: "ArrowLeft" });

    // resolveNextGridCell returns null at the grid's own left edge, so the
    // handler returns before calling preventDefault — the key keeps its native
    // meaning (e.g. scrolling), unlike every other branch in this describe.
    expect(notDefaultPrevented).toBe(true);
    expect(document.activeElement).toBe(lead);
  });

  it("Home on the row's own first cell claims the key even though focus stays put", () => {
    renderGridTable({ keyboardCellNavigation: true });
    const lead = leadCellOf("Alpha");
    focusCell(lead);

    const notDefaultPrevented = fireEvent.keyDown(lead, { key: "Home" });

    // Distinguishes this case from the ArrowLeft-edge case above: here
    // `nextCell` DID resolve (to the same cell), so preventDefault runs before
    // the same-cell return. That return itself is not observable: `.focus()` on
    // the already-focused cell is a no-op.
    expect(notDefaultPrevented).toBe(false);
    expect(document.activeElement).toBe(lead);
  });
});

describe("GridTable leading utility track — nav entry point and focus-ring class", () => {
  it("makes the utility cell (not the lead cell) the initial tab stop and gives it the nav ring class", () => {
    renderGridTable({
      keyboardCellNavigation: true,
      leadingUtilityHeader: <span>All</span>,
      renderLeadingUtility: (row) => (
        <input aria-label={`Select ${row.name}`} type="checkbox" />
      ),
    });

    const checkbox = screen.getByLabelText("Select Alpha");
    const utilityCell = checkbox.closest("[data-grid-cell]");
    if (!(utilityCell instanceof HTMLElement)) {
      throw new Error("utility cell not found");
    }

    // Entry point: the FIRST tab stop is the utility cell, not the lead cell.
    expect(utilityCell.tabIndex).toBe(0);
    expect(leadCellOf("Alpha").tabIndex).toBe(-1);
    expect(
      document.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);

    // The `navigationEnabled && "outline-none …"` branch — present only
    // because navigation is on; a table that never sets keyboardCellNavigation
    // never adds this class to its utility cell (see sibling test below).
    expect(utilityCell.className).toContain("outline-none");
    expect(utilityCell.className).toContain("focus-visible:ring-2");
  });

  it("omits the nav ring class from the utility cell when navigation is off", () => {
    renderGridTable({
      leadingUtilityHeader: <span>All</span>,
      renderLeadingUtility: (row) => (
        <input aria-label={`Select ${row.name}`} type="checkbox" />
      ),
    });

    const checkbox = screen.getByLabelText("Select Alpha");
    // No `keyboardCellNavigation` here, so `buildCellNavigationProps` never
    // sets `data-grid-cell` at all — locate the cell by its `role="cell"`
    // instead, which the utility cell carries either way.
    const utilityCell = checkbox.closest('[role="cell"]');
    if (!(utilityCell instanceof HTMLElement)) {
      throw new Error("utility cell not found");
    }

    expect(utilityCell.className).not.toContain("outline-none");
  });
});

describe("GridTable roving tabindex resolves against the rendered cells", () => {
  it("retains the focused cell as the active cell across a re-render instead of falling back to the first cell", () => {
    renderGridTable({ keyboardCellNavigation: true });
    const lead = leadCellOf("Alpha");
    expect(lead.tabIndex).toBe(0);

    const ownerCell = document.querySelector(
      '[data-grid-cell][data-column-id="owner"]'
    ) as HTMLElement;
    focusCell(ownerCell);

    // onFocus sets activeCellKey; the next render recomputes
    // `effectiveActiveCellKey` and — because that cell key IS in
    // `renderedCellKeys` — keeps it, rather than falling back to `firstCellKey`.
    // Observable as the roving tabindex moving off the lead cell onto this one.
    expect(ownerCell.tabIndex).toBe(0);
    expect(lead.tabIndex).toBe(-1);
  });

  it("falls back to the first rendered cell once the active cell's group collapses", () => {
    renderGridTable({
      groups: [
        { key: "team-a", label: "Team A", items: [ROWS[0]] },
        { key: "team-b", label: "Team B", items: [ROWS[1]] },
      ],
      keyboardCellNavigation: true,
    });
    const alphaOwner = leadCellOf("Alpha").parentElement?.querySelector(
      '[data-grid-cell][data-column-id="owner"]'
    );
    if (!(alphaOwner instanceof HTMLElement)) {
      throw new Error("owner cell for Alpha not found");
    }
    focusCell(alphaOwner);
    expect(alphaOwner.tabIndex).toBe(0);
    expect(leadCellOf("Beta").tabIndex).toBe(-1);

    fireEvent.click(screen.getByRole("button", { name: TEAM_A_HEADER_NAME }));

    // activeCellKey still names Alpha's owner cell, which no longer renders.
    // Without the fallback every rendered cell compares unequal and the grid
    // drops out of the tab order; with it, Team B's first cell is the tab stop.
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(leadCellOf("Beta").tabIndex).toBe(0);
    expect(
      document.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);
  });
});

describe("GridTable row click guards", () => {
  it("fires onRowClick for a plain, non-interactive, non-navigable click", () => {
    const onRowClick = vi.fn();
    renderGridTable({ onRowClick });

    fireEvent.click(screen.getByText("Alpha"));

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("ignores a click whose target is not an HTMLElement", () => {
    const onRowClick = vi.fn();
    renderGridTable({
      onRowClick,
      renderLead: (row) => (
        <span>
          {row.name}
          {/** biome-ignore lint/a11y/noSvgWithoutTitle: test fixture only */}
          <svg data-testid={`icon-${row.id}`}>
            <circle cx="1" cy="1" r="1" />
          </svg>
        </span>
      ),
    });

    // An inline SVG's event target is an SVGElement, which fails the row
    // handler's `event.target instanceof HTMLElement` check, so it returns
    // before ever reaching `onRowClick`.
    fireEvent.click(screen.getByTestId("icon-1"));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("ignores a click on an interactive control inside the row", () => {
    const onRowClick = vi.fn();
    renderGridTable({
      onRowClick,
      renderCell: (columnId, row) =>
        columnId === "owner" ? (
          <button type="button">{`Open ${row.name}`}</button>
        ) : (
          row.status
        ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("clicking inside a cell with navigation on both fires onRowClick and re-keys the active cell", () => {
    const onRowClick = vi.fn();
    renderGridTable({ keyboardCellNavigation: true, onRowClick });
    const lead = leadCellOf("Alpha");
    expect(lead.tabIndex).toBe(0);

    fireEvent.click(screen.getByText("Beta"));

    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
    // The click handed off to keyboard nav: the clicked row's lead cell is now
    // the roving tab stop instead of the grid's first cell.
    expect(leadCellOf("Beta").tabIndex).toBe(0);
    expect(lead.tabIndex).toBe(-1);
  });

  it("clicking the row container itself (no cell ancestor) still fires onRowClick but leaves the active cell untouched", () => {
    const onRowClick = vi.fn();
    renderGridTable({ keyboardCellNavigation: true, onRowClick });
    const lead = leadCellOf("Alpha");
    expect(lead.tabIndex).toBe(0);

    const row = lead.closest("[data-grid-row]");
    if (!(row instanceof HTMLElement)) {
      throw new Error("row not found");
    }

    // `focusCellFromRowClick` walks up from the target for a `[data-grid-cell]`
    // ancestor; firing directly on the row element itself has none, so
    // `cellKey` is undefined and `setActiveCellKey` is never called — yet
    // `onRowClick` still fires because that call sits outside the `if`.
    fireEvent.click(row);

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
    expect(lead.tabIndex).toBe(0);
  });
});

describe("GridTableCell — colIndex-less usage renders no role at all", () => {
  it("omits both aria-colindex and role when no colIndex is supplied", () => {
    render(
      <div>
        <GridTableCell>standalone content</GridTableCell>
      </div>
    );

    const cell = screen.getByText("standalone content").closest("div");
    expect(cell).not.toHaveAttribute("role");
    expect(cell).not.toHaveAttribute("aria-colindex");
  });

  it("carries the cell role once colIndex is supplied, for contrast", () => {
    render(
      <div>
        <GridTableCell colIndex={2}>with index</GridTableCell>
      </div>
    );

    const cell = screen.getByRole("cell");
    expect(within(cell).getByText("with index")).toBeInTheDocument();
    expect(cell).toHaveAttribute("aria-colindex", "2");
  });
});
