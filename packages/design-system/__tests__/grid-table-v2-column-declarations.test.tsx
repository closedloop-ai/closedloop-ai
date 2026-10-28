import {
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  TableChangeCell,
  TableNumberCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-primitives";
import { TableGridHeaderV2 } from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import { ColumnAlignment } from "@closedloop-ai/design-system/lib/column-registry";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9313. The column registry declared an accessible name, an alignment and a
 * per-column movability long before anything rendered them, so a registry that
 * validated clean was not proof that a blank-label column announced a name.
 * These settle that the three declarations reach the ELEMENT.
 *
 * Every case pairs the declaring column with a plain sibling, because the
 * absence of an affordance only means something beside a column that has one.
 */

type Row = { id: string; name: string; cost: string };

const ROWS: Row[] = [{ id: "1", name: "Alpha", cost: "12" }];
const LEADING_LABEL = "Name";
/** Lead track + one per data column. Widths are arbitrary; pairing is not. */
const TEMPLATE = "240px 120px 90px";

/** Written out rather than imported: importing would police nothing. */
const JUSTIFY_END_CLASS = "justify-end";
/**
 * The margin `TableNumberCell` pushes ITSELF to the trailing edge with, and the
 * reason a cell's `JUSTIFY_END_CLASS` is inert over one: an auto margin eats the
 * free space the justification would otherwise distribute (ISS-9821).
 */
const AUTO_MARGIN_CLASS = "ml-auto";
/**
 * `GridEmptyValue`'s em-dash. It is the only `TableChangeCell` state with free
 * space to be moved through — the bars themselves are `w-full` — so it is what
 * a change cell's answer to its column is readable ON.
 */
const EMPTY_VALUE_TEXT = "—";

/** The resize handle states its column and its width; only the column matters here. */
const RESIZE_COST_HANDLE = /Resize Cost column/;
const RESIZE_ACTIONS_HANDLE = /Resize Actions column/;
const RESIZE_ROW_ACTIONS_HANDLE = /Resize Row actions column/;
const RESIZE_OVERRIDE_HANDLE = /Resize Total cost in USD column/;
/** The drag payload type the header writes and reads. */
const COLUMN_DRAG_TYPE = "text/x-grid-table-column";
/** The inset rail a cell paints while it is a live drop target. */
const DROP_TARGET_CLASS = "shadow-[inset_2px_0_0_var(--primary)]";

const PLAIN_COLUMNS: GridTableV2Column[] = [
  { id: "cost", label: "Cost" },
  { id: "actions", label: "Actions" },
];

describe("GridTableV2 column ariaLabel", () => {
  it("names a blank-label columnheader, while a labelled sibling keeps its own name", () => {
    renderGrid([
      { id: "cost", label: "Cost" },
      { id: "actions", label: "", ariaLabel: "Row actions" },
    ]);

    expect(
      screen.getByRole("columnheader", { name: "Row actions" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Cost" })
    ).toBeInTheDocument();
  });

  it("leaves a blank-label column unnamed when it declares no ariaLabel", () => {
    renderGrid([
      { id: "cost", label: "Cost" },
      { id: "actions", label: "" },
    ]);

    expect(
      screen.queryByRole("columnheader", { name: "Row actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Cost" })
    ).toBeInTheDocument();
  });

  it("names the resize handle from the accessible name, not the blank label", () => {
    renderGrid(
      [
        { id: "cost", label: "Cost" },
        { id: "actions", label: "", ariaLabel: "Row actions" },
      ],
      { columnWidths: { cost: 120, actions: 90 }, onColumnWidthChange: () => 0 }
    );

    expect(
      screen.getByRole("button", { name: RESIZE_ROW_ACTIONS_HANDLE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RESIZE_COST_HANDLE })
    ).toBeInTheDocument();
  });

  it("ignores ariaLabel on a column that HAS a visible label", () => {
    // The validator accepts this pair — `MissingAccessibleName` only refuses a
    // blank label with no `ariaLabel` — so nothing upstream stops a slice author
    // writing a fuller description here. Applying it would leave the accessible
    // name not containing the visible word, which is a WCAG 2.5.3 failure on
    // every operable control in the cell.
    renderGrid([{ id: "cost", label: "Cost", ariaLabel: "Total cost in USD" }]);

    expect(
      screen.queryByRole("columnheader", { name: "Total cost in USD" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Cost" })
    ).toBeInTheDocument();
  });

  it("keeps the visible label in every control's name, not just the header", () => {
    renderGrid(
      [{ id: "cost", label: "Cost", ariaLabel: "Total cost in USD" }],
      {
        columnWidths: { cost: 120 },
        onColumnWidthChange: () => 0,
        headerActions: { onFilter: () => 0 },
      }
    );

    expect(
      screen.getByRole("button", { name: RESIZE_COST_HANDLE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RESIZE_OVERRIDE_HANDLE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Total cost in USD column options" })
    ).not.toBeInTheDocument();
  });

  it("names the sort control of a blank-label column", () => {
    renderGrid(
      [
        { id: "cost", label: "Cost", sortable: true },
        { id: "actions", label: "", ariaLabel: "Row actions", sortable: true },
      ],
      { onSort: () => 0, sortBy: null }
    );

    // The header cell and its sort button are two separate focusable things, so
    // naming the cell does not name the control inside it.
    expect(
      screen.getByRole("button", { name: "Row actions" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cost" })).toBeInTheDocument();
  });
});

describe("TableGridHeaderV2 outside a grid", () => {
  it("emits no aria-label on a cell that is not a columnheader", () => {
    // `aria-label` is prohibited on a role-less element, and this header only
    // becomes a `columnheader` when it sits inside a `role="grid"`.
    const { container } = render(
      <TableGridHeaderV2
        columns={[{ id: "actions", label: "", ariaLabel: "Row actions" }]}
        gridTemplateColumns={TEMPLATE}
        leadingLabel={LEADING_LABEL}
        onSort={() => 0}
        sortBy={null}
        sortDir="asc"
      />
    );

    const cell = container.querySelector('[data-column-id="actions"]');
    expect(cell).not.toBeNull();
    expect(cell?.getAttribute("role")).toBeNull();
    expect(cell?.getAttribute("aria-label")).toBeNull();
  });

  it("emits it once the same header is inside a grid", () => {
    render(
      <TableGridHeaderV2
        columns={[{ id: "actions", label: "", ariaLabel: "Row actions" }]}
        gridTemplateColumns={TEMPLATE}
        insideAriaTable
        leadingLabel={LEADING_LABEL}
        onSort={() => 0}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(
      screen.getByRole("columnheader", { name: "Row actions" })
    ).toBeInTheDocument();
  });
});

describe("GridTableV2 column align", () => {
  it("actually moves the label to the trailing edge, and not a plain sibling", () => {
    renderGrid([
      { id: "cost", label: "Cost", align: ColumnAlignment.End },
      { id: "actions", label: "Actions" },
    ]);

    expect(
      labelResolvesToEndAligned(
        screen.getByRole("columnheader", { name: "Cost" }),
        "Cost"
      )
    ).toBe(true);
    // The negative sibling: a predicate returning true for every header would
    // satisfy the assertion above and prove nothing.
    expect(
      labelResolvesToEndAligned(
        screen.getByRole("columnheader", { name: "Actions" }),
        "Actions"
      )
    ).toBe(false);
    expect(dataCell("cost")).toHaveClass(JUSTIFY_END_CLASS);
    expect(dataCell("actions")).not.toHaveClass(JUSTIFY_END_CLASS);
  });

  it("keeps the label off flex-1 when end-aligned, so the cell can move it", () => {
    renderGrid(
      [
        {
          id: "cost",
          label: "Cost",
          align: ColumnAlignment.End,
          sortable: true,
        },
      ],
      { onSort: () => 0, sortBy: null }
    );

    const header = screen.getByRole("columnheader", { name: "Cost" });
    const label = within(header).getByText("Cost");
    expect(label.classList.contains("flex-1")).toBe(false);
    // The sort button is the container ISS-5333 named: `flex-1` on it leaves the
    // cell's `justify-end` nothing to distribute.
    expect(label.closest("button")?.classList.contains("flex-1")).toBe(false);
  });

  it("leads the sort indicator so the label lands last, on the digits' x", () => {
    renderGrid(
      [
        {
          id: "cost",
          label: "Cost",
          align: ColumnAlignment.End,
          sortable: true,
        },
      ],
      { onSort: () => 0, sortBy: "cost" }
    );

    const button = within(
      screen.getByRole("columnheader", { name: "Cost" })
    ).getByRole("button");
    const label = within(button).getByText("Cost");
    const indicator = button.querySelector("svg");
    expect(indicator).not.toBeNull();
    // Document order inside the button: the caret has to come BEFORE the label,
    // or the label is inset from the rail by the caret's width.
    const inOrder = Array.from(button.querySelectorAll("svg, span"));
    expect(inOrder.indexOf(indicator as Element)).toBeLessThan(
      inOrder.indexOf(label)
    );
  });

  it("leaves both untouched for a column declaring start", () => {
    renderGrid([
      { id: "cost", label: "Cost", align: ColumnAlignment.Start },
      { id: "actions", label: "Actions" },
    ]);

    const header = screen.getByRole("columnheader", { name: "Cost" });
    expect(labelResolvesToEndAligned(header, "Cost")).toBe(false);
    expect(within(header).getByText("Cost")).toHaveClass("flex-1");
    expect(dataCell("cost")).not.toHaveClass(JUSTIFY_END_CLASS);
  });
});

/**
 * ISS-9821. The cases above assert the CELL's justification; these assert where
 * the VALUE actually lands, which is a different question the moment the value
 * is the node every real host renders. A `TableNumberCell` pushes itself right
 * with `ml-auto` and eats the free space `justify-end` would distribute, so a
 * cell-class assertion over one proves nothing about the figure inside it — the
 * same inert-justify trap the header half of ISS-9313 went to real trouble to
 * avoid.
 *
 * Every case here reads the FIGURE's own class, never its cell's. A predicate
 * that ORed the two — "is anything pushing this right" — was this block's first
 * revision and was itself a false green: `justify-end` lands on the cell for an
 * End column from a line this feature never touches, so the End case passed
 * with the publishing logic inverted (review-soul, class B). Where the cell's
 * justification is part of the claim, it is asserted separately and on purpose.
 */
describe("GridTableV2 column align over the canonical value primitives", () => {
  const figurePushesItselfRight = (columnId: string, text: string) =>
    within(dataCell(columnId))
      .getByText(text)
      .classList.contains(AUTO_MARGIN_CLASS);

  it("leaves the figure at the trailing edge under a start-aligned header while the gate is closed", () => {
    renderGrid([{ id: "cost", label: "Cost", align: ColumnAlignment.Start }]);

    // The defect, asserted as today's behaviour: the header obeys the column
    // and the value does not, so the two disagree.
    expect(
      labelResolvesToEndAligned(
        screen.getByRole("columnheader", { name: "Cost" }),
        "Cost"
      )
    ).toBe(false);
    expect(figurePushesItselfRight("cost", "12")).toBe(true);
  });

  it("moves the figure to the leading edge with the gate open", () => {
    renderGrid([{ id: "cost", label: "Cost", align: ColumnAlignment.Start }], {
      alignValuesToColumn: true,
    });

    expect(figurePushesItselfRight("cost", "12")).toBe(false);
    // Nothing ELSE is moving it: a start-aligned column paints no justification
    // on its cell either, so the figure is at the leading edge rather than
    // merely missing one of two mechanisms.
    expect(dataCell("cost")).not.toHaveClass(JUSTIFY_END_CLASS);
  });

  it("keeps an end-aligned column's figure at the trailing edge with the gate open", () => {
    renderGrid([{ id: "cost", label: "Cost", align: ColumnAlignment.End }], {
      alignValuesToColumn: true,
    });

    expect(figurePushesItselfRight("cost", "12")).toBe(true);
  });

  it("leaves a column carrying NO alignment on the primitive's own default", () => {
    // The whole reason opening the gate moves nothing as shipped: every
    // production v2 host hand-builds its column array and sets no `align`, and
    // an absent one must not be read as a declared `Start`. A REGISTRY-built
    // column always carries one, so this is the hand-built case only.
    renderGrid([{ id: "cost", label: "Cost" }], {
      alignValuesToColumn: true,
    });

    expect(figurePushesItselfRight("cost", "12")).toBe(true);
  });

  it("lets a cell's own alignEnd beat the column it sits in", () => {
    render(
      <GridTableV2<Row>
        alignValuesToColumn
        columns={[{ id: "cost", label: "Cost", align: ColumnAlignment.End }]}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE}
        items={ROWS}
        leadingLabel={LEADING_LABEL}
        renderCell={(columnId, row) =>
          columnId === "cost" ? (
            <TableNumberCell alignEnd={false} value={row.cost} />
          ) : null
        }
        renderLead={(row) => row.name}
      />
    );

    // A duration rendered through the numeric primitive under a numeric column
    // is the shipped case (`custom-field-cells.tsx` does exactly this), so the
    // column must not overrule an explicit opt-out.
    expect(figurePushesItselfRight("cost", "12")).toBe(false);
  });

  /**
   * `TableChangeCell` reads the same context as `TableNumberCell` rather than
   * hardcoding `alignEnd: true`, and `artifact-cell.tsx` renders the two under
   * adjacent columns (`lineChanges` beside `creationCost`), so the pair really
   * does sit side by side in production. These two pin the parity its prop
   * docstring claims: the same declared alignment, the same answer, both ways.
   */
  const renderChangeBesideNumber = (align: ColumnAlignment) =>
    render(
      <GridTableV2<Row>
        alignValuesToColumn
        columns={[
          { id: "cost", label: "Cost", align },
          { id: "changes", label: "Changes", align },
        ]}
        getRowId={(row) => row.id}
        gridTemplateColumns={TEMPLATE}
        items={ROWS}
        leadingLabel={LEADING_LABEL}
        renderCell={(columnId, row) =>
          columnId === "cost" ? (
            <TableNumberCell value={row.cost} />
          ) : (
            <TableChangeCell />
          )
        }
        renderLead={(row) => row.name}
      />
    );

  it("moves a change cell to the leading edge with the number cell beside it", () => {
    renderChangeBesideNumber(ColumnAlignment.Start);

    expect(figurePushesItselfRight("cost", "12")).toBe(false);
    expect(figurePushesItselfRight("changes", EMPTY_VALUE_TEXT)).toBe(false);
  });

  it("keeps a change cell at the trailing edge with the number cell beside it", () => {
    renderChangeBesideNumber(ColumnAlignment.End);

    expect(figurePushesItselfRight("cost", "12")).toBe(true);
    expect(figurePushesItselfRight("changes", EMPTY_VALUE_TEXT)).toBe(true);
  });
});

describe("GridTableV2 per-column movability", () => {
  it("refuses the drag surface to a column left out, and keeps it for the rest", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnOrder: ["cost", "actions"],
      onColumnOrderChange: () => 0,
      movableColumnIds: ["cost"],
    });

    expect(headerCell("actions")).toHaveAttribute("draggable", "false");
    expect(headerCell("cost")).toHaveAttribute("draggable", "true");
  });

  it("keeps every ordered column draggable when no list is declared", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnOrder: ["cost", "actions"],
      onColumnOrderChange: () => 0,
    });

    expect(headerCell("actions")).toHaveAttribute("draggable", "true");
    expect(headerCell("cost")).toHaveAttribute("draggable", "true");
  });

  it("keeps an immovable column as a DROP TARGET for the columns that do move", () => {
    // `handleColumnDrop` moves the dragged column to the drop target's index,
    // so in this exact two-column config `cost` would advertise itself as
    // draggable while the only other header refused the drop, and the reorder
    // could never complete.
    renderGrid(PLAIN_COLUMNS, {
      columnOrder: ["cost", "actions"],
      onColumnOrderChange: () => 0,
      movableColumnIds: ["cost"],
    });

    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, "dataTransfer", {
      value: { types: [COLUMN_DRAG_TYPE], dropEffect: "none" },
    });
    headerCell("actions").dispatchEvent(dragOver);

    // A handled dragover calls preventDefault; an unhandled one leaves the
    // event un-cancelled and the browser refuses the drop.
    expect(dragOver.defaultPrevented).toBe(true);
  });

  /**
   * whitlockk cid 3961205951. Enter, over and drop are all gated on
   * `isOrderedColumn` because a fixed column is a valid drop TARGET; leaving
   * only the LEAVE handler on `canReorder` meant the highlight it just turned
   * on had nothing to turn it off, so it stayed lit until another drop or an
   * unrelated render.
   */
  it("clears the drop highlight it set when the pointer leaves a fixed column", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnOrder: ["cost", "actions"],
      onColumnOrderChange: () => 0,
      movableColumnIds: ["cost"],
    });

    fireEvent.dragEnter(headerCell("actions"), {
      dataTransfer: { types: [COLUMN_DRAG_TYPE] },
    });
    // The enter half has to land, or the leave half is asserting nothing.
    expect(headerCell("actions").className).toContain(DROP_TARGET_CLASS);

    fireEvent.dragLeave(headerCell("actions"), { relatedTarget: null });

    expect(headerCell("actions").className).not.toContain(DROP_TARGET_CLASS);
  });

  it("still renders and orders a column it will not let the user move", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnOrder: ["actions", "cost"],
      onColumnOrderChange: () => 0,
      movableColumnIds: ["cost"],
    });

    // Positions rather than the whole list: the fixed leading identity column
    // carries a `data-column-id` of its own, and this case is about where the
    // two DATA columns landed relative to each other.
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.getAttribute("data-column-id"));
    expect(headers).toContain("actions");
    expect(headers).toContain("cost");
    expect(headers.indexOf("actions")).toBeLessThan(headers.indexOf("cost"));
  });
});

describe("GridTableV2 per-column resizability", () => {
  it("grows a handle only on the declared columns", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnWidths: { cost: 120, actions: 90 },
      onColumnWidthChange: () => 0,
      resizableColumnIds: ["cost"],
    });

    expect(
      screen.getByRole("button", { name: RESIZE_COST_HANDLE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RESIZE_ACTIONS_HANDLE })
    ).not.toBeInTheDocument();
  });

  it("falls back to every measured column when no list is declared", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnWidths: { cost: 120, actions: 90 },
      onColumnWidthChange: () => 0,
    });

    expect(
      screen.getByRole("button", { name: RESIZE_COST_HANDLE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RESIZE_ACTIONS_HANDLE })
    ).toBeInTheDocument();
  });

  /**
   * marisolashgrove cid 3961273890. The two props are independent by design, so
   * the list NARROWS the width map and must not widen it. An id listed here but
   * unseeded in `columnWidths` rendered a handle whose `getColumnWidth` fell
   * through to the shared floor — announcing "60 pixels" for a column painting
   * at 200 and committing 60 + delta on the first drag, a snap that was
   * structurally impossible while the list WAS the keys of the map.
   */
  it("refuses a handle to a declared id the width map never measured", () => {
    renderGrid(PLAIN_COLUMNS, {
      columnWidths: { cost: 120 },
      onColumnWidthChange: () => 0,
      resizableColumnIds: ["cost", "actions"],
    });

    expect(
      screen.getByRole("button", { name: RESIZE_COST_HANDLE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RESIZE_ACTIONS_HANDLE })
    ).not.toBeInTheDocument();
  });
});

/**
 * Ported from `agents-count-column-alignment.test.tsx`. A class assertion is NOT
 * alignment: `justify-end` on a container whose child already ate the free space
 * moves nothing, and that false green is exactly how ISS-5333 shipped. Walk from
 * the label to the cell and ask whether anything can still move it.
 *
 * A `function` rather than the `const` it started as, because ISS-9821's block
 * asks the same question of the VALUE and both blocks call this for the header.
 */
function labelResolvesToEndAligned(header: HTMLElement, text: string): boolean {
  const label = within(header).getByText(text);
  let node: HTMLElement | null = label;
  let growsIntoFreeSpace = false;
  while (node && node !== header.parentElement) {
    if (node !== label && node.classList.contains(JUSTIFY_END_CLASS)) {
      return !growsIntoFreeSpace;
    }
    if (node.classList.contains("flex-1") || node.classList.contains("grow")) {
      growsIntoFreeSpace = true;
    }
    node = node.parentElement;
  }
  return false;
}

function headerCell(columnId: string): HTMLElement {
  const cell = screen
    .getAllByRole("columnheader")
    .find((element) => element.getAttribute("data-column-id") === columnId);
  if (!cell) {
    throw new Error(`no columnheader rendered for "${columnId}"`);
  }
  return cell;
}

function dataCell(columnId: string): HTMLElement {
  const cell = screen
    .getAllByRole("gridcell")
    .find((element) => element.getAttribute("data-column-id") === columnId);
  if (!cell) {
    throw new Error(`no gridcell rendered for "${columnId}"`);
  }
  return cell;
}

function renderGrid(
  columns: GridTableV2Column[],
  extra: Partial<ComponentProps<typeof GridTableV2<Row>>> = {}
) {
  render(
    <GridTableV2<Row>
      columns={columns}
      getRowId={(row) => row.id}
      gridTemplateColumns={TEMPLATE}
      items={ROWS}
      leadingLabel={LEADING_LABEL}
      renderCell={(columnId, row) =>
        columnId === "cost" ? <TableNumberCell value={row.cost} /> : null
      }
      renderLead={(row) => row.name}
      {...extra}
    />
  );
}
