/**
 * GridTable v2 — the six interaction criteria the hoist has to preserve.
 *
 * These are the behaviors a from-scratch re-derivation of the `generic-artifact`
 * prototype loses, so each is asserted directly rather than inferred from "the
 * table renders". Where the criterion is a CSS state that jsdom cannot actually
 * paint (`:hover`, `:focus-visible`, `[data-state=open]`), the assertion is made
 * against the shipped class list, which is exported as one constant precisely so
 * the test cannot drift into asserting its own copy of the string.
 */

import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import {
  COLUMN_MENU_TRIGGER_CLASS,
  hasColumnMenuItems,
} from "@repo/design-system/components/ui/table-grid-column-menu";
import {
  focusCellFromRowClick,
  isInteractiveRowClickTarget,
  resolveNextGridCell,
  shouldSkipGridNavigation,
} from "@repo/design-system/lib/grid-table-navigation";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

/** Top-level per `useTopLevelRegex` — a literal here would be rebuilt per call. */
const COLUMN_OPTIONS_NAME = /column options/;
/** Top-level per `useTopLevelRegex` — the collapsible group header's name. */
const SECOND_GROUP_NAME = /Second/;

type Row = { id: string; name: string; owner: string };

const ROWS: Row[] = [
  { id: "r1", name: "Alpha", owner: "ana" },
  { id: "r2", name: "Bravo", owner: "ben" },
  { id: "r3", name: "Cleo", owner: "cal" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner", sortable: true, filterable: true },
  { id: "status", label: "Status", groupable: true, movable: true },
];

function renderGrid(overrides: Record<string, unknown> = {}) {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="1fr 120px 120px"
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) =>
        columnId === "owner" ? row.owner : "Active"
      }
      renderLead={(row) => <span>{row.name}</span>}
      {...overrides}
    />
  );
}

describe("criterion 1 — every hover reveal has a focus-visible twin", () => {
  test("the column-options trigger reveals on hover AND on keyboard focus", () => {
    // Both must be present: `group-hover/header` alone makes the control
    // mouse-only, which is the exact regression this criterion exists to catch.
    expect(COLUMN_MENU_TRIGGER_CLASS).toContain(
      "group-hover/header:opacity-100"
    );
    expect(COLUMN_MENU_TRIGGER_CLASS).toContain("focus-visible:opacity-100");
  });

  test("the rendered trigger actually carries those classes", () => {
    renderGrid({
      enhancedHeaderInteractions: true,
      headerActions: { onFilter: vi.fn() },
    });
    const trigger = screen.getByRole("button", {
      name: "Owner column options",
    });
    expect(trigger.className).toContain("group-hover/header:opacity-100");
    expect(trigger.className).toContain("focus-visible:opacity-100");
  });
});

describe("criterion 2 — the control stays visible while its own menu is open", () => {
  test("the trigger carries data-[state=open]:opacity-100", () => {
    // Without this the trigger fades out as soon as the pointer leaves the
    // header for the menu it just opened — the control vanishes under its popup.
    expect(COLUMN_MENU_TRIGGER_CLASS).toContain(
      "data-[state=open]:opacity-100"
    );
  });
});

describe("criterion 3 — selection beats hover", () => {
  test("a selected row restates its selected background in the hover slot", () => {
    renderGrid({ isRowSelected: (row: Row) => row.id === "r2" });
    const selected = screen
      .getByText("Bravo")
      .closest("[data-grid-row]") as HTMLElement;
    expect(selected.dataset.state).toBe("selected");
    expect(selected.className).toContain("bg-primary/10");
    // The load-bearing half: without the hover restatement the row flips to the
    // neutral hover tint on mouseover and reads as deselected.
    expect(selected.className).toContain("hover:bg-primary/10");
    expect(selected.className).not.toContain("hover:bg-muted/40");
  });

  test("an unselected row keeps the ordinary hover tint", () => {
    renderGrid({ isRowSelected: (row: Row) => row.id === "r2" });
    const other = screen
      .getByText("Alpha")
      .closest("[data-grid-row]") as HTMLElement;
    expect(other.dataset.state).toBeUndefined();
    expect(other.className).toContain("hover:bg-muted/40");
  });
});

describe("criterion 4 — click hands off to keyboard", () => {
  test("clicking a row focuses the cell that was clicked", () => {
    renderGrid({ keyboardCellNavigation: true, onRowClick: vi.fn() });
    const ownerCell = screen.getByText("ben").closest("[data-grid-cell]");
    fireEvent.click(screen.getByText("ben"));
    expect(document.activeElement).toBe(ownerCell);
  });

  test("arrow keys move focus via preventDefault + focus()", () => {
    renderGrid({ keyboardCellNavigation: true });
    const leadCell = screen
      .getByText("Alpha")
      .closest("[data-grid-cell]") as HTMLElement;
    leadCell.focus();

    const downHandled = fireEvent.keyDown(leadCell, { key: "ArrowDown" });
    // `fireEvent` returns false when the handler called `preventDefault` — which
    // is what stops the arrow ALSO scrolling the table's scroll container.
    expect(downHandled).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByText("Bravo").closest("[data-grid-cell]")
    );

    const right = document.activeElement as HTMLElement;
    fireEvent.keyDown(right, { key: "ArrowRight" });
    expect((document.activeElement as HTMLElement).dataset.columnId).toBe(
      "owner"
    );
  });

  test("a roving tabindex keeps exactly one cell in the tab order", () => {
    renderGrid({ keyboardCellNavigation: true });
    const tabbable = document.querySelectorAll(
      '[data-grid-cell][tabindex="0"]'
    );
    expect(tabbable).toHaveLength(1);
  });

  test("navigation is opt-in: without it the table keeps static table semantics", () => {
    renderGrid();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelectorAll("[data-grid-cell]")).toHaveLength(0);
  });

  test("with navigation on, the table is an ARIA grid of gridcells", () => {
    renderGrid({ keyboardCellNavigation: true });
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0);
  });

  test("a click on an interactive control does not trigger row activation", () => {
    const onRowClick = vi.fn();
    render(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="1fr 120px 120px"
        items={ROWS}
        keyboardCellNavigation
        leadingLabel="Name"
        onRowClick={onRowClick}
        renderCell={(columnId, row) =>
          columnId === "owner" ? (
            <button type="button">{row.owner}</button>
          ) : (
            "Active"
          )
        }
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "ben" }));
    expect(onRowClick).not.toHaveBeenCalled();

    // …but a click on plain cell content still activates the row, or the
    // criterion would be satisfied by a handler that never fires at all.
    fireEvent.click(screen.getByText("Bravo"));
    expect(onRowClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r2" })
    );
  });
});

describe("criterion 4 — the navigation primitives in isolation", () => {
  test("arrow navigation stops at the grid's edges rather than wrapping", () => {
    renderGrid({ keyboardCellNavigation: true });
    const firstLead = screen
      .getByText("Alpha")
      .closest("[data-grid-cell]") as HTMLElement;
    expect(resolveNextGridCell(firstLead, "ArrowUp")).toBeNull();
    expect(resolveNextGridCell(firstLead, "ArrowLeft")).toBeNull();
  });

  test("a modifier chord and a text input are left to their owner", () => {
    const modifiers = { altKey: false, ctrlKey: false, metaKey: false };
    expect(shouldSkipGridNavigation("ArrowDown", null, modifiers)).toBe(false);
    expect(
      shouldSkipGridNavigation("ArrowDown", null, {
        ...modifiers,
        metaKey: true,
      })
    ).toBe(true);
    expect(shouldSkipGridNavigation("Tab", null, modifiers)).toBe(true);
    expect(
      shouldSkipGridNavigation(
        "ArrowLeft",
        document.createElement("input"),
        modifiers
      )
    ).toBe(true);
  });

  test("a row-selection surface opts a control back into row activation", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML =
      '<div data-row-selection-surface><input type="checkbox" /></div>';
    const checkbox = wrapper.querySelector("input") as HTMLElement;
    expect(isInteractiveRowClickTarget(checkbox)).toBe(false);
  });

  test("focusCellFromRowClick returns null outside a cell", () => {
    expect(focusCellFromRowClick(document.createElement("div"))).toBeNull();
  });
});

describe("criterion 6 — drag affordances", () => {
  test("the reorder grip is keyboard-reachable and the header is grabbable", () => {
    renderGrid({
      columnOrder: ["owner", "status"],
      onColumnOrderChange: vi.fn(),
    });
    const grip = screen.getByRole("button", {
      name: "Reorder Owner column, use arrow keys",
    });
    // ISS-5812 split the two affordances: the GRIP is the keyboard control and
    // the visual cue (and takes no pointer events, so a `cursor-*` on it would
    // be inert), while the HEADER CELL is what the pointer grabs.
    expect(grip.className).toContain("pointer-events-none");
    expect(grip.className).toContain("focus-visible:opacity-100");
    const header = screen.getByRole("columnheader", { name: "Owner" });
    expect(header.className).toContain("cursor-grab");
    expect(header.className).toContain("active:cursor-grabbing");
  });

  test("the dragged header fades and the drop target rules", () => {
    renderGrid({
      columnOrder: ["owner", "status"],
      enhancedHeaderInteractions: true,
      onColumnOrderChange: vi.fn(),
    });
    const header = screen.getByRole("columnheader", { name: "Owner" });
    expect(header.className).toContain("transition-colors");
    // ISS-5812: the drag source is the header cell, and it only enters the
    // dragging state once a payload is actually written — so the event has to
    // carry a `dataTransfer`, which `fireEvent.dragStart` does not supply on its
    // own. A bare dragstart deliberately no longer fades the header.
    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      getData: (type: string) => store.get(type) ?? "",
      setData: (type: string, value: string) => {
        store.set(type, value);
      },
      get types() {
        return [...store.keys()];
      },
    };
    fireEvent.dragStart(header, { dataTransfer });
    expect(header.className).toContain("opacity-45");
    fireEvent.dragEnd(header);
    expect(header.className).not.toContain("opacity-45");
  });
});

describe("the column menu never advertises an action the table cannot perform", () => {
  test("no trigger renders when the table wires no actions", () => {
    renderGrid();
    expect(
      screen.queryByRole("button", { name: COLUMN_OPTIONS_NAME })
    ).toBeNull();
  });

  test("a column that opted out of every action gets no menu", () => {
    expect(hasColumnMenuItems({ actions: { onFilter: vi.fn() } })).toBe(false);
    // …and a column that opted in, with the action wired, does.
    expect(
      hasColumnMenuItems({
        actions: { onFilter: vi.fn() },
        filterable: true,
      })
    ).toBe(true);
    // An opt-in with NO wired callback is still nothing to show.
    expect(hasColumnMenuItems({ actions: {}, filterable: true })).toBe(false);
  });

  test("sort alone never summons a menu — the header label already sorts", () => {
    // stage review: with `sortable` counting, wiring `headerActions` at all gave
    // EVERY sortable column a chevron whose menu held only Sort ascending /
    // descending — two controls for the one action the label already performs.
    // `status` is groupable+movable, so the table still wires real actions here.
    renderGrid({
      enhancedHeaderInteractions: true,
      headerActions: { onGroup: vi.fn(), onMove: vi.fn() },
    });
    expect(
      screen.queryByRole("button", { name: "Owner column options" })
    ).toBeNull();
    // …but a column with a real reason still gets one, and sort rides along in it.
    expect(
      screen.getByRole("button", { name: "Status column options" })
    ).toBeTruthy();
  });
});

describe("ISS-4779 — the v2 header presentation is opt-in", () => {
  test("flag off: the sort caret is not hidden and the header does not restyle", () => {
    renderGrid({ onSort: vi.fn() });
    const header = screen.getByRole("columnheader", { name: "Owner" });
    const caret = header.querySelector("svg") as SVGElement;
    expect(caret.getAttribute("class")).not.toContain("opacity-0");
    expect(header.className).not.toContain("transition-colors");
    // No hover scope either: nothing in this header needs one when the caret is
    // always painted.
    expect(header.className).not.toContain("group/header");
  });

  test("flag on: a sortable column hides its caret AND carries the hover scope", () => {
    renderGrid({ enhancedHeaderInteractions: true, onSort: vi.fn() });
    const header = screen.getByRole("columnheader", { name: "Owner" });
    // stage review: `group/header` used to be applied only when reorder, resize
    // or a menu was wired, so a sortable-only table (Packs admin) painted an
    // `opacity-0` caret nothing on the page could ever reveal.
    expect(header.className).toContain("group/header");
    const caret = header.querySelector("svg") as SVGElement;
    const caretClass = caret.getAttribute("class") ?? "";
    expect(caretClass).toContain("opacity-0");
    expect(caretClass).toContain("group-hover/header:opacity-60");
    // The keyboard twin the docstring promises (WCAG 2.4.7).
    expect(caretClass).toContain("group-focus-visible/sortbtn:opacity-60");
  });

  test("flag on: the lead column follows the SAME caret rule as the data columns", () => {
    // stage review: the lead caret used to paint at full opacity while every
    // data caret was hidden, so a Branches header read as "only Branch sorts".
    renderGrid({
      enhancedHeaderInteractions: true,
      leadingSortKey: "name",
      onSort: vi.fn(),
    });
    const leadHeader = screen.getByRole("columnheader", { name: "Name" });
    const leadCaret = leadHeader.querySelector("svg") as SVGElement;
    expect(leadCaret.getAttribute("class")).toContain("opacity-0");
    expect(leadHeader.className).toContain("group/header");
  });

  test("flag off: the resize handle keeps its pre-v2 reveal", () => {
    renderGrid({
      columnWidths: { owner: 160 },
      onColumnWidthChange: vi.fn(),
    });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    expect(handle.className).toContain("group-hover/header:opacity-100");
    expect(handle.className).not.toContain("after:bg-primary");
  });

  test("flag on: the resize hairline still reveals on HEADER hover, not only inside the strip", () => {
    renderGrid({
      columnWidths: { owner: 160 },
      enhancedHeaderInteractions: true,
      onColumnWidthChange: vi.fn(),
    });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    // stage review: without the header-scoped reveal the affordance went from
    // "hover the column, see that it resizes" to "know it's there and find it".
    expect(handle.className).toContain("group-hover/header:after:opacity-40");
    expect(handle.className).toContain("hover:after:opacity-70");
  });
});

describe("roving tabindex survives the focused row disappearing", () => {
  test("a data change that drops the focused row hands the tab stop back", () => {
    const { rerender } = render(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="1fr 120px 120px"
        items={ROWS}
        keyboardCellNavigation
        leadingLabel="Name"
        renderCell={(columnId, row) => (columnId === "owner" ? row.owner : "—")}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    // Focus a cell on the LAST row, then drop that row from the data.
    const cleoCell = screen
      .getByText("Cleo")
      .closest("[data-grid-cell]") as HTMLElement;
    fireEvent.focus(cleoCell);
    expect(cleoCell.getAttribute("tabindex")).toBe("0");

    rerender(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="1fr 120px 120px"
        items={ROWS.slice(0, 2)}
        keyboardCellNavigation
        leadingLabel="Name"
        renderCell={(columnId, row) => (columnId === "owner" ? row.owner : "—")}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    // wongk review: the remembered key names a row nothing renders, so without
    // the fallback EVERY remaining cell would be tabindex -1 and the grid would
    // fall out of the tab order entirely.
    expect(
      document.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);
    expect(
      (screen.getByText("Alpha").closest("[data-grid-cell]") as HTMLElement)
        .tabIndex
    ).toBe(0);
  });

  test("collapsing the group holding the focused row hands the tab stop back", () => {
    render(
      <GridTable<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="1fr 120px 120px"
        groups={[
          { key: "g1", label: "First", items: ROWS.slice(0, 1) },
          { key: "g2", label: "Second", items: ROWS.slice(1) },
        ]}
        items={ROWS}
        keyboardCellNavigation
        leadingLabel="Name"
        renderCell={(columnId, row) => (columnId === "owner" ? row.owner : "—")}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const bravoCell = screen
      .getByText("Bravo")
      .closest("[data-grid-cell]") as HTMLElement;
    fireEvent.focus(bravoCell);
    expect(bravoCell.getAttribute("tabindex")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: SECOND_GROUP_NAME }));
    expect(screen.queryByText("Bravo")).toBeNull();
    expect(
      document.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);
  });
});
