import type {
  TableGridHeaderReorder,
  TableGridHeaderResize,
} from "@closedloop-ai/design-system/components/ui/table-grid-header";
import {
  COLUMN_DRAG_DATA_TYPE,
  ColumnDragHandle,
  ColumnResizeHandle,
  handleColumnDrop,
  isColumnDragEvent,
  startColumnDrag,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-handles";
import { MIN_COLUMN_WIDTH_PX } from "@closedloop-ai/design-system/lib/column-order";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-7349. These are the header's direct-manipulation grips — the controls a
 * user drags to reorder a column and to resize one. Two properties the module
 * argues for at length and that a story cannot exercise:
 *
 *  - EVERY drag entry point must survive a `dataTransfer`-less event. The module
 *    note records that guarding only one of the three handlers left the other
 *    two throwing on exactly the input the guard exists for.
 *  - both grips must be fully operable from the keyboard (WCAG 2.1.1), and the
 *    arrow keys must `preventDefault` so the key does not ALSO scroll the
 *    table's container sideways on every press.
 *
 * The pointer resize additionally has to restore the body cursor it borrowed —
 * a host that had set its own would otherwise silently lose it.
 */

const COLUMN_ORDER = ["name", "status", "owner"];

function reorderWiring() {
  const onReorder = vi.fn<(nextOrder: string[]) => void>();
  return {
    columnOrder: COLUMN_ORDER,
    onReorder,
  } satisfies TableGridHeaderReorder;
}

function resizeWiring(width = 200) {
  const onResize = vi.fn<(columnId: string, widthPx: number) => void>();
  return {
    columnIds: COLUMN_ORDER,
    getColumnWidth: () => width,
    onResize,
  } satisfies TableGridHeaderResize;
}

/** A minimal DragEvent stand-in; `dataTransfer` may be deliberately absent. */
function dragEvent(dataTransfer?: Partial<DataTransfer>) {
  return {
    dataTransfer: dataTransfer as DataTransfer | undefined,
    preventDefault: vi.fn(),
  } as unknown as React.DragEvent<HTMLDivElement>;
}

// A resize drag borrows document.body's cursor and userSelect for its whole
// duration, so a test that deliberately leaves a drag unfinished (the
// ignored-second-pointer cases below) hands the next test a body still stuck
// on col-resize/none. Restore what this file found, not "".
let previousBodyCursor = "";
let previousBodyUserSelect = "";

beforeEach(() => {
  previousBodyCursor = globalThis.document.body.style.cursor;
  previousBodyUserSelect = globalThis.document.body.style.userSelect;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.document.body.style.cursor = previousBodyCursor;
  globalThis.document.body.style.userSelect = previousBodyUserSelect;
});

describe("startColumnDrag", () => {
  it("writes the dragged column id under the shared payload type", () => {
    const setData = vi.fn();
    const event = dragEvent({ setData } as Partial<DataTransfer>);

    expect(startColumnDrag(event, "status")).toBe(true);
    expect(setData).toHaveBeenCalledWith(COLUMN_DRAG_DATA_TYPE, "status");
  });

  it("marks the drag as a move", () => {
    const transfer = { effectAllowed: "none", setData: vi.fn() };

    startColumnDrag(dragEvent(transfer as Partial<DataTransfer>), "status");

    expect(transfer.effectAllowed).toBe("move");
  });

  it("reports failure instead of throwing when dataTransfer is absent", () => {
    // A synthetic dragstart carries no dataTransfer; advertising a drag that
    // carries no payload is worse than declining it.
    expect(startColumnDrag(dragEvent(undefined), "status")).toBe(false);
  });
});

describe("isColumnDragEvent", () => {
  it("recognises an event carrying the column payload type", () => {
    expect(
      isColumnDragEvent(
        dragEvent({ types: [COLUMN_DRAG_DATA_TYPE] } as Partial<DataTransfer>)
      )
    ).toBe(true);
  });

  it("rejects an event carrying some other payload type", () => {
    expect(
      isColumnDragEvent(
        dragEvent({ types: ["text/plain"] } as Partial<DataTransfer>)
      )
    ).toBe(false);
  });

  it("returns false rather than throwing when dataTransfer is absent", () => {
    expect(isColumnDragEvent(dragEvent(undefined))).toBe(false);
  });
});

describe("handleColumnDrop", () => {
  const transferWith = (id: string) =>
    ({ getData: () => id }) as Partial<DataTransfer>;

  it("moves the dragged column to the drop target's slot", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(transferWith("owner")), reorder, "name");

    expect(reorder.onReorder).toHaveBeenCalledWith(["owner", "name", "status"]);
  });

  it("always prevents the browser's default drop handling", () => {
    const event = dragEvent(transferWith("owner"));

    handleColumnDrop(event, reorderWiring(), "name");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when a column is dropped on itself", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(transferWith("owner")), reorder, "owner");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty payload", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(transferWith("")), reorder, "owner");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("is a no-op when the dragged id is not in the current order", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(transferWith("ghost")), reorder, "owner");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("is a no-op when the drop target is not in the current order", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(transferWith("owner")), reorder, "ghost");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("does not throw when dataTransfer is absent", () => {
    const reorder = reorderWiring();

    handleColumnDrop(dragEvent(undefined), reorder, "owner");

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });
});

describe("ColumnDragHandle", () => {
  const renderHandle = (reorder: TableGridHeaderReorder) =>
    render(
      <ColumnDragHandle columnId="status" label="Status" reorder={reorder} />
    );

  it("names the control AND the operation for a screen-reader user", () => {
    renderHandle(reorderWiring());

    expect(
      screen.getByRole("button", {
        name: "Reorder Status column, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("moves the column left on ArrowLeft", () => {
    const reorder = reorderWiring();
    renderHandle(reorder);

    fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowLeft" });

    expect(reorder.onReorder).toHaveBeenCalledWith(["status", "name", "owner"]);
  });

  it("moves the column right on ArrowRight", () => {
    const reorder = reorderWiring();
    renderHandle(reorder);

    fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowRight" });

    expect(reorder.onReorder).toHaveBeenCalledWith(["name", "owner", "status"]);
  });

  it("ignores an unrelated key", () => {
    const reorder = reorderWiring();
    renderHandle(reorder);

    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });

    expect(reorder.onReorder).not.toHaveBeenCalled();
  });

  it("stays out of the pointer's way", () => {
    // Load-bearing, not decoration: the glyph sits in the divider seam, so a
    // pointer claim here would fight the neighbour's resize strip.
    renderHandle(reorderWiring());

    expect(screen.getByRole("button").className).toContain(
      "pointer-events-none"
    );
  });
});

describe("ColumnResizeHandle", () => {
  const renderHandle = (resize: TableGridHeaderResize, enhanced = true) =>
    render(
      <ColumnResizeHandle
        columnId="status"
        enhancedHeaderInteractions={enhanced}
        label="Status"
        resize={resize}
      />
    );

  it("names the control AND the operation in both variants", () => {
    const { unmount } = renderHandle(resizeWiring(), true);
    expect(
      screen.getByRole("button", {
        name: "Resize Status column, use arrow keys",
      })
    ).toBeInTheDocument();
    unmount();

    renderHandle(resizeWiring(), false);
    expect(
      screen.getByRole("button", {
        name: "Resize Status column, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("renders the pre-v2 handle with its visible divider bar", () => {
    // Kept verbatim for every table that has not opted in.
    renderHandle(resizeWiring(), false);

    expect(screen.getByRole("button").firstChild).not.toBeNull();
  });

  it("renders the v2 strip with no child element", () => {
    renderHandle(resizeWiring(), true);

    expect(screen.getByRole("button").firstChild).toBeNull();
  });

  it("is never itself a drag source", () => {
    renderHandle(resizeWiring(), true);

    expect(screen.getByRole("button")).toHaveAttribute("draggable", "false");
    expect(screen.getByRole("button")).toHaveAttribute("data-no-column-drag");
  });

  it("shrinks one step on ArrowLeft", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);

    fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowLeft" });

    expect(resize.onResize).toHaveBeenCalledWith("status", 184);
  });

  it("grows one step on ArrowRight", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);

    fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowRight" });

    expect(resize.onResize).toHaveBeenCalledWith("status", 216);
  });

  it("clamps a keyboard shrink at the shared floor", () => {
    const resize = resizeWiring(MIN_COLUMN_WIDTH_PX);
    renderHandle(resize);

    fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowLeft" });

    expect(resize.onResize).toHaveBeenCalledWith("status", MIN_COLUMN_WIDTH_PX);
  });

  it("ignores an unrelated key", () => {
    const resize = resizeWiring();
    renderHandle(resize);

    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });

    expect(resize.onResize).not.toHaveBeenCalled();
  });

  it("ignores a non-primary pointer button", () => {
    // A context-menu press must not start a phantom resize. The press alone
    // proves nothing — the handler never calls onResize on pointerdown either
    // way — so the drag is driven to completion: no listeners were attached, so
    // the move and the release must both go unheard.
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 2, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(resize.onResize).not.toHaveBeenCalled();
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
  });

  it("commits the final width on pointer release", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 560, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(resize.onResize).toHaveBeenLastCalledWith("status", 260);
  });

  it("clamps a drag past the floor rather than collapsing the column", () => {
    const resize = resizeWiring(100);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(resize.onResize).toHaveBeenLastCalledWith(
      "status",
      MIN_COLUMN_WIDTH_PX
    );
  });

  it("ignores moves from a second concurrent pointer", () => {
    // A second touch must not hijack the drag the first one started.
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 2 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(resize.onResize).toHaveBeenLastCalledWith("status", 200);
  });

  it("ignores a pointerup from a different pointer", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 2 });

    expect(resize.onResize).not.toHaveBeenCalled();
  });

  it("restores the host's previous body cursor when the drag ends", () => {
    // Restore the PREVIOUS value, not "" — a host mid-drag-operation had set
    // its own and must not silently lose it.
    globalThis.document.body.style.cursor = "grabbing";
    const resize = resizeWiring();
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    expect(globalThis.document.body.style.cursor).toBe("col-resize");
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(globalThis.document.body.style.cursor).toBe("grabbing");
    globalThis.document.body.style.cursor = "";
  });

  it("tears down when pointer capture is lost without an up or cancel", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent(handle, new Event("lostpointercapture"));
    resize.onResize.mockClear();
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });

    expect(resize.onResize).not.toHaveBeenCalled();
  });

  it("ends the drag on pointercancel", () => {
    const resize = resizeWiring(200);
    renderHandle(resize);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(resize.onResize).toHaveBeenCalledWith("status", 200);
  });
});
