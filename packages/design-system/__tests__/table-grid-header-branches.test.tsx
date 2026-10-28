import {
  TableGridHeader,
  type TableGridHeaderColumn,
  type TableGridHeaderReorder,
} from "@closedloop-ai/design-system/components/ui/table-grid-header";
import { COLUMN_DRAG_DATA_TYPE } from "@closedloop-ai/design-system/components/ui/table-grid-header-handles";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Targeted branch coverage for `table-grid-header.tsx` that
 * `table-grid-header-handles.test.tsx` (the drag/resize sub-controls) and
 * `grid-table.test.tsx` (rendered-text matrix) do not reach: the leading
 * utility cell's ARIA gating, `getSelectAllState`'s two truthy branches, the
 * v2 hover/drag class assembly, and the per-cell drag-enter/leave/over
 * handlers wired through `TableGridHeader` itself (`ColumnHeaderCell` is not
 * exported, so it can only be reached through the parent).
 */

const COLUMNS: TableGridHeaderColumn[] = [{ id: "status", label: "Status" }];

const noop = () => {
  // no-op onSort for tests that never assert a sort call
};

function reorderWiring(): TableGridHeaderReorder {
  return {
    columnOrder: ["status"],
    onReorder: vi.fn<(nextOrder: string[]) => void>(),
  };
}

/**
 * `MouseEventInit.relatedTarget` is not writable through `fireEvent`'s plain
 * event-property merge (jsdom's `DragEvent` exposes it as a read-only
 * getter), so building the event by hand and defining the property directly
 * is what actually lets it reach `event.relatedTarget` in the handler.
 */
function dragLeaveEvent(relatedTarget: EventTarget | null) {
  const event = new Event("dragleave", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "relatedTarget", {
    value: relatedTarget,
    enumerable: true,
  });
  return event;
}

describe("TableGridHeader — leading utility cell ARIA gating", () => {
  it("omits aria-colindex and the columnheader role when not inside an ARIA table", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        insideAriaTable={false}
        leadingUtilityHeader={<span>Select</span>}
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    const utilityCell = screen.getByText("Select").parentElement;
    expect(utilityCell).not.toHaveAttribute("aria-colindex");
    expect(utilityCell).not.toHaveAttribute("role");
  });

  it("sets aria-colindex and the columnheader role when inside an ARIA table", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        insideAriaTable={true}
        leadingUtilityHeader={<span>Select</span>}
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    const utilityCell = screen.getByText("Select").parentElement;
    expect(utilityCell).toHaveAttribute("role", "columnheader");
    expect(utilityCell).toHaveAttribute("aria-colindex", "1");
  });
});

describe("TableGridHeader — select-all checkbox state", () => {
  it("checks the box when allSelected is true, regardless of someSelected", () => {
    render(
      <TableGridHeader
        allSelected={true}
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        showSelectAll={true}
        someSelected={true}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "data-state",
      "checked"
    );
  });

  it("marks the box indeterminate when only someSelected is true", () => {
    render(
      <TableGridHeader
        allSelected={false}
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        showSelectAll={true}
        someSelected={true}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "data-state",
      "indeterminate"
    );
  });

  it("leaves the box unchecked when neither flag is set", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        showSelectAll={true}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "data-state",
      "unchecked"
    );
  });
});

describe("TableGridHeader — data column cell drag/hover class assembly (v2)", () => {
  function renderColumnCell(reorder: TableGridHeaderReorder) {
    render(
      <TableGridHeader
        columns={COLUMNS}
        enhancedHeaderInteractions={true}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        reorder={reorder}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("Status").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the column header cell to render");
    }
    return cell;
  }

  it("fades the column being dragged once enhanced interactions are on", () => {
    const reorder = reorderWiring();
    const cell = renderColumnCell(reorder);

    fireEvent.dragStart(cell, { dataTransfer: { setData: vi.fn() } });

    expect(cell.className).toContain("opacity-45");
  });

  it("does not fade the dragged column when enhanced interactions are off", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        enhancedHeaderInteractions={false}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        reorder={reorderWiring()}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("Status").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the column header cell to render");
    }

    fireEvent.dragStart(cell, { dataTransfer: { setData: vi.fn() } });

    expect(cell.getAttribute("draggable")).toBe("true");
    expect(cell.className).not.toContain("opacity-45");
  });

  it("does not fade the cell before any drag has started", () => {
    const cell = renderColumnCell(reorderWiring());

    expect(cell.className).not.toContain("opacity-45");
  });

  it("paints the insertion rule on the drop target once enhanced interactions are on", () => {
    const reorder = reorderWiring();
    const cell = renderColumnCell(reorder);

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });

    expect(cell.className).toContain("before:absolute");
  });

  it("does not paint the insertion rule when enhanced interactions are off", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        enhancedHeaderInteractions={false}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        reorder={reorderWiring()}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("Status").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the column header cell to render");
    }

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });

    // The drag entered with a column payload, so the cell IS a drop target;
    // only the flag keeps the rule off.
    expect(cell.getAttribute("draggable")).toBe("true");
    expect(cell.className).not.toContain("before:absolute");
  });

  it("does not paint the insertion rule before any drag enters", () => {
    const cell = renderColumnCell(reorderWiring());

    expect(cell.className).not.toContain("before:absolute");
  });
});

describe("TableGridHeader — reorderable column drag handlers", () => {
  function renderColumnCell() {
    const reorder = reorderWiring();
    render(
      <TableGridHeader
        columns={COLUMNS}
        enhancedHeaderInteractions={true}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        reorder={reorder}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("Status").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the column header cell to render");
    }
    return cell;
  }

  it("marks the cell as a drop target when a genuine column drag enters it", () => {
    const cell = renderColumnCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });

    // Observing the effect through the class the insertion rule adds proves
    // `setIsDropTarget(true)` actually ran, not merely that the handler exists.
    expect(cell.className).toContain("before:absolute");
  });

  it("does not mark a drop target for an unrelated drag payload", () => {
    const cell = renderColumnCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: ["text/plain"] },
    });

    expect(cell.className).not.toContain("before:absolute");
  });

  it("does not mark a drop target while the cell itself is the one being dragged", () => {
    // The dragenter the browser fires on the drag SOURCE right after
    // dragstart must not paint that same cell as its own drop target.
    const cell = renderColumnCell();

    fireEvent.dragStart(cell, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });

    expect(cell.className).not.toContain("before:absolute");
  });

  it("clears the drop-target rule on a real dragleave from outside the cell", () => {
    const cell = renderColumnCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("before:absolute");

    fireEvent(cell, dragLeaveEvent(document.body));

    expect(cell.className).not.toContain("before:absolute");
  });

  it("ignores a dragleave fired for a child element still inside the cell", () => {
    const cell = renderColumnCell();
    const child = cell.querySelector("span");
    if (!child) {
      throw new Error("expected a label span inside the header cell");
    }

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("before:absolute");

    // relatedTarget is a descendant the pointer crossed onto, so the leave
    // must be swallowed and the insertion rule must survive it.
    fireEvent(cell, dragLeaveEvent(child));

    expect(cell.className).toContain("before:absolute");
  });

  it("clears the drop-target rule when relatedTarget is not a DOM Node", () => {
    // jsdom lets a synthetic event carry a non-Node relatedTarget (e.g. null);
    // the `instanceof Node` guard must route that straight to the fallback
    // `setIsDropTarget(false)` rather than throwing on `.contains`.
    const cell = renderColumnCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("before:absolute");

    fireEvent(cell, dragLeaveEvent(null));

    expect(cell.className).not.toContain("before:absolute");
  });

  it("prevents the browser's default dragover handling so a drop can land", () => {
    const cell = renderColumnCell();

    const event = new Event("dragover", { bubbles: true, cancelable: true });
    cell.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("clears both the fade and the drop-target rule on dragend", () => {
    const cell = renderColumnCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("before:absolute");
    fireEvent.dragStart(cell, { dataTransfer: { setData: vi.fn() } });
    expect(cell.className).toContain("opacity-45");

    fireEvent.dragEnd(cell);

    expect(cell.className).not.toContain("opacity-45");
    expect(cell.className).not.toContain("before:absolute");
  });
});

describe("TableGridHeader — non-reorderable column drag handlers", () => {
  it("wires no drag handlers at all when reorder is absent", () => {
    render(
      <TableGridHeader
        columns={COLUMNS}
        gridTemplateColumns="1fr 1fr"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("Status").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the column header cell to render");
    }

    expect(cell).toHaveAttribute("draggable", "false");

    // With no handler bound, dragover's default is never prevented — the
    // event's own defaultPrevented flag proves nothing ran.
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
