import {
  TableGridHeaderV2,
  type TableGridHeaderV2Column,
  type TableGridHeaderV2Reorder,
  type TableGridHeaderV2Resize,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import { COLUMN_DRAG_DATA_TYPE } from "@closedloop-ai/design-system/components/ui/table-grid-header-v2-handles";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Targeted branch coverage for `table-grid-header-v2.tsx` that the rendered-
 * text matrices elsewhere in this directory do not reach: the leading
 * utility/rank slot's ARIA gating outside an ARIA table, the column-move
 * direction math and its bounds check, the reorder drop-target drag handlers,
 * a drag started from inside the resize handle (which must not also start a
 * column drag), and the menu-vs-button-vs-plain-label render choice for a
 * data column header cell.
 */

const RESIZE_BUTTON_NAME = /^Resize /;
const FILTER_MENU_ITEM_NAME = /^Filter$/;

const COLUMN_ORDER = ["a", "b", "c"];

function orderedColumns(): TableGridHeaderV2Column[] {
  return COLUMN_ORDER.map((id) => ({ id, label: id.toUpperCase() }));
}

function reorderWiring(): TableGridHeaderV2Reorder {
  return {
    columnOrder: COLUMN_ORDER,
    onReorder: vi.fn<(nextOrder: string[]) => void>(),
  };
}

function resizeWiring(columnIds: readonly string[], width = 160) {
  return {
    columnIds,
    getColumnWidth: () => width,
    onResize: vi.fn<(columnId: string, widthPx: number) => void>(),
  } satisfies TableGridHeaderV2Resize;
}

const noop = () => {
  // unused onSort for tests that never assert a sort call
};

/**
 * `fireEvent.dragLeave(el, { relatedTarget })` does not actually set
 * `relatedTarget` on the dispatched event — jsdom's `DragEvent` constructor
 * silently drops it, so the handler always sees `undefined` that way. A raw
 * `Event` with the property force-defined is what actually lets a handler
 * read `event.relatedTarget`, mirroring `table-grid-header-branches.test.tsx`.
 */
function dragLeaveEvent(relatedTarget: EventTarget | null) {
  const event = new Event("dragleave", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "relatedTarget", {
    value: relatedTarget,
    enumerable: true,
  });
  return event;
}

describe("TableGridHeaderV2 — leading utility/rank slot outside an ARIA table", () => {
  it("omits aria-colindex and the columnheader role from the utility cell", () => {
    render(
      <TableGridHeaderV2
        columns={[]}
        gridTemplateColumns="200px 1fr"
        leadingUtilityCell={<span>Util</span>}
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    const utilityCell = screen.getByText("Util").parentElement;
    expect(utilityCell).not.toHaveAttribute("aria-colindex");
    expect(utilityCell).not.toHaveAttribute("role");
  });

  it("renders an empty rank placeholder when no utility cell is given", () => {
    const { container } = render(
      <TableGridHeaderV2
        columns={[]}
        gridTemplateColumns="40px 200px"
        onSort={noop}
        showRankSlot={true}
        sortBy={null}
        sortDir="asc"
      />
    );

    const headerRow = container.firstElementChild;
    const placeholder = headerRow?.firstElementChild;
    expect(placeholder).not.toBeNull();
    expect(placeholder).not.toHaveAttribute("data-column-id");
    expect(placeholder?.childElementCount).toBe(0);
    // The lead identity cell is the placeholder's very next sibling, proving
    // the rank slot occupies its own track rather than being the lead cell.
    expect(placeholder?.nextElementSibling).toHaveAttribute(
      "data-column-id",
      "__leading__"
    );
  });

  it("renders no rank placeholder when neither a utility cell nor showRankSlot is given", () => {
    const { container } = render(
      <TableGridHeaderV2
        columns={[]}
        gridTemplateColumns="200px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    const headerRow = container.firstElementChild;
    expect(headerRow?.firstElementChild).toHaveAttribute(
      "data-column-id",
      "__leading__"
    );
  });
});

describe("TableGridHeaderV2 — column-move direction math and bounds", () => {
  function renderMovable(overrides?: Partial<TableGridHeaderV2Reorder>) {
    const reorder = { ...reorderWiring(), ...overrides };
    render(
      <TableGridHeaderV2
        columns={orderedColumns()}
        gridTemplateColumns="200px repeat(3, 160px)"
        onSort={noop}
        reorder={reorder}
        sortBy={null}
        sortDir="asc"
      />
    );
    return reorder;
  }

  async function selectMoveItem(columnLabel: string, itemName: string) {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: `${columnLabel} column options` }),
      { button: 0, ctrlKey: false }
    );
    const moveTrigger = await screen.findByRole("menuitem", {
      name: "Move column",
    });
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });
    const item = await screen.findByRole("menuitem", { name: itemName });
    fireEvent.click(item);
  }

  it("moves the middle column to the start", async () => {
    const reorder = renderMovable();

    await selectMoveItem("B", "Move to start");

    expect(reorder.onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("moves the middle column to the end", async () => {
    const reorder = renderMovable();

    await selectMoveItem("B", "Move to end");

    expect(reorder.onReorder).toHaveBeenCalledWith(["a", "c", "b"]);
  });

  it("moves the middle column one step left", async () => {
    const reorder = renderMovable();

    await selectMoveItem("B", "Move left");

    expect(reorder.onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("moves the middle column one step right", async () => {
    const reorder = renderMovable();

    await selectMoveItem("B", "Move right");

    expect(reorder.onReorder).toHaveBeenCalledWith(["a", "c", "b"]);
  });

  it("refuses to move the first column further left", async () => {
    const reorder = renderMovable();

    await selectMoveItem("A", "Move left");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("refuses to move the last column further right", async () => {
    const reorder = renderMovable();

    await selectMoveItem("C", "Move right");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });
});

describe("TableGridHeaderV2 — reorderable column drag handlers", () => {
  function renderCell(extra?: { resize?: TableGridHeaderV2Resize }) {
    render(
      <TableGridHeaderV2
        columns={orderedColumns()}
        gridTemplateColumns="200px repeat(3, 160px)"
        onSort={noop}
        reorder={reorderWiring()}
        resize={extra?.resize}
        sortBy={null}
        sortDir="asc"
      />
    );
    const cell = screen.getByText("B").closest("[data-column-id]");
    if (!cell) {
      throw new Error("expected the B column header cell to render");
    }
    return cell;
  }

  it("marks the cell a drop target on a genuine column drag", () => {
    const cell = renderCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });

    expect(cell.className).toContain("shadow-[inset_2px_0_0_var(--primary)]");
  });

  it("does not mark a drop target for an unrelated drag payload", () => {
    const cell = renderCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: ["text/plain"] },
    });

    expect(cell.className).not.toContain(
      "shadow-[inset_2px_0_0_var(--primary)]"
    );
  });

  it("keeps the drop-target rule while the leave is to a child still inside the cell", () => {
    const cell = renderCell();
    const child = cell.querySelector("span");
    if (!child) {
      throw new Error("expected a label span inside the header cell");
    }

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("shadow-[inset_2px_0_0_var(--primary)]");

    fireEvent(cell, dragLeaveEvent(child));

    expect(cell.className).toContain("shadow-[inset_2px_0_0_var(--primary)]");
  });

  it("clears the drop-target rule on a real leave to outside the cell", () => {
    const cell = renderCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("shadow-[inset_2px_0_0_var(--primary)]");

    fireEvent(cell, dragLeaveEvent(document.body));

    expect(cell.className).not.toContain(
      "shadow-[inset_2px_0_0_var(--primary)]"
    );
  });

  it("does not start a column drag from inside the resize handle", () => {
    const resize = resizeWiring(["b"]);
    const cell = renderCell({ resize });
    const handle = screen.getByRole("button", { name: RESIZE_BUTTON_NAME });

    const notPrevented = fireEvent.dragStart(handle, {
      dataTransfer: { setData: vi.fn() },
    });

    // fireEvent's return value is the DOM dispatch result, which is false
    // once preventDefault ran — proving the handler's own-element guard fired
    // rather than merely that nothing threw.
    expect(notPrevented).toBe(false);
    expect(cell.className).not.toContain("opacity-[0.45]");
  });

  it("resets dragging and drop-target state on dragend for a reorderable cell", () => {
    const cell = renderCell();

    fireEvent.dragEnter(cell, {
      dataTransfer: { types: [COLUMN_DRAG_DATA_TYPE] },
    });
    expect(cell.className).toContain("shadow-[inset_2px_0_0_var(--primary)]");
    fireEvent.dragStart(cell, { dataTransfer: { setData: vi.fn() } });
    expect(cell.className).toContain("opacity-[0.45]");

    fireEvent.dragEnd(cell);

    expect(cell.className).not.toContain("opacity-[0.45]");
    expect(cell.className).not.toContain(
      "shadow-[inset_2px_0_0_var(--primary)]"
    );
  });
});

describe("TableGridHeaderV2 — data column header cell render choice", () => {
  it("renders the options menu for a filterable column with filter content wired", async () => {
    render(
      <TableGridHeaderV2
        actions={{ getFilterContent: () => <span>Only mine</span> }}
        columns={[{ id: "owner", label: "Owner", filterable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Owner column options" }),
      { button: 0, ctrlKey: false }
    );

    expect(
      await screen.findByRole("menuitem", { name: FILTER_MENU_ITEM_NAME })
    ).toBeInTheDocument();
  });

  it("renders the options menu for a groupable column with grouping wired", async () => {
    render(
      <TableGridHeaderV2
        actions={{ onGroup: vi.fn() }}
        columns={[{ id: "owner", label: "Owner", groupable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Owner column options" }),
      { button: 0, ctrlKey: false }
    );

    expect(
      await screen.findByRole("menuitem", { name: "Group" })
    ).toBeInTheDocument();
  });

  it("skips the options menu for a filterable column with no filter wiring", () => {
    render(
      <TableGridHeaderV2
        actions={{ onGroup: vi.fn() }}
        columns={[{ id: "owner", label: "Owner", filterable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(
      screen.queryByRole("button", { name: "Owner column options" })
    ).toBeNull();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("skips the options menu for a groupable column with no onGroup wiring", () => {
    render(
      <TableGridHeaderV2
        actions={{ onFilter: vi.fn() }}
        columns={[{ id: "owner", label: "Owner", groupable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(
      screen.queryByRole("button", { name: "Owner column options" })
    ).toBeNull();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("renders a plain sort button, no menu, when no actions are wired at all", () => {
    render(
      <TableGridHeaderV2
        columns={[{ id: "owner", label: "Owner", sortable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(
      screen.queryByRole("button", { name: "Owner column options" })
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Owner" })).toBeInTheDocument();
  });
});

describe("TableGridHeaderV2 — column tooltip reaches the label in the non-menu render branches", () => {
  it("carries the column's own tooltip onto a sortable column's label with no menu", () => {
    render(
      <TableGridHeaderV2
        columns={[
          {
            id: "owner",
            label: "Owner",
            sortable: true,
            tooltip: "Who owns this",
          },
        ]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    // No `reorder` and no menu-triggering actions are wired, so the ONLY
    // source that could make this label a tooltip trigger is the column's own
    // `tooltip` — the `?? (canReorder ? ... : undefined)` fallback resolves to
    // `undefined` here.
    expect(screen.getByText("Owner")).toHaveAttribute(
      "data-slot",
      "tooltip-trigger"
    );
  });

  it("carries the column's own tooltip onto a static, non-menu label", () => {
    render(
      <TableGridHeaderV2
        columns={[{ id: "owner", label: "Owner", tooltip: "Who owns this" }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.getByText("Owner")).toHaveAttribute(
      "data-slot",
      "tooltip-trigger"
    );
  });

  it("renders a plain, non-tooltip label when the column carries no tooltip", () => {
    render(
      <TableGridHeaderV2
        columns={[{ id: "owner", label: "Owner" }]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    expect(screen.getByText("Owner")).not.toHaveAttribute("data-slot");
  });
});
