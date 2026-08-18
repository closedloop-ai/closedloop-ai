import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { MIN_COLUMN_WIDTH_PX } from "@repo/design-system/lib/column-order";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * FEA-4168: the design-system `GridTable` primitive has no test runner of its
 * own, so its resize-handle wiring is exercised here (its `@repo/app` consumer),
 * mirroring the reorder test alongside. Focus: a resize handle renders per data
 * column, keyboard `ArrowLeft`/`ArrowRight` emit a clamped width, a pointer drag
 * emits width-at-press + delta, and both honor the shared floor.
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

const RE_RESIZE_HANDLE = /^Resize .+ column, use arrow keys$/;

// jsdom does not implement PointerEvent capture; stub it so the pointer-drag
// path (setPointerCapture) does not throw.
beforeAll(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {
      // no-op
    };
    Element.prototype.releasePointerCapture = () => {
      // no-op
    };
  }
});

function renderGrid(
  onColumnWidthChange: (columnId: string, widthPx: number) => void,
  columnWidths?: Record<string, number>
) {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      columnWidths={columnWidths ?? { owner: 150, status: 120 }}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      onColumnWidthChange={onColumnWidthChange}
      renderCell={(columnId, row) => (
        <span>
          {columnId}:{row.name}
        </span>
      )}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
}

describe("GridTable resize handles (FEA-4168)", () => {
  it("renders an accessibly-named resize handle per data column", () => {
    renderGrid(() => {
      // no-op — this case only asserts the handles render.
    });
    const handles = screen.getAllByRole("button", { name: RE_RESIZE_HANDLE });
    // One handle for each data column (the fixed lead never gets one).
    expect(handles).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("renders no handle for a column absent from the resizable set (codex review)", () => {
    // Only `owner` is seeded as resizable; `status` is a fixed column and must
    // not render an operable handle whose emitted width would be discarded.
    render(
      <GridTable<Row>
        columns={COLUMNS}
        columnWidths={{ owner: 150 }}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Name"
        onColumnWidthChange={() => {
          // no-op — this case only asserts which handles render.
        }}
        renderCell={(columnId, row) => (
          <span>
            {columnId}:{row.name}
          </span>
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const handles = screen.getAllByRole("button", { name: RE_RESIZE_HANDLE });
    expect(handles).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, use arrow keys",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Resize Status column, use arrow keys",
      })
    ).not.toBeInTheDocument();
  });

  it("emits no handle when resize is not wired", () => {
    render(
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
    expect(
      screen.queryByRole("button", { name: RE_RESIZE_HANDLE })
    ).not.toBeInTheDocument();
  });

  it("keyboard ArrowRight grows the focused column from its current width", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledTimes(1);
    const [columnId, width] = onResize.mock.calls[0];
    expect(columnId).toBe("owner");
    // Grew from the base 150 by one keyboard step.
    expect(width).toBeGreaterThan(150);
  });

  it("keyboard ArrowLeft clamps at the shared floor", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: MIN_COLUMN_WIDTH_PX, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledWith("owner", MIN_COLUMN_WIDTH_PX);
  });

  it("pointer drag emits width-at-press plus the horizontal delta", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // Base 150 + (380 - 300) = 230.
    expect(onResize).toHaveBeenLastCalledWith("owner", 230);
  });

  it("pointer drag past the label clamps to the shared floor", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    // Drag far left, well below the floor.
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith("owner", MIN_COLUMN_WIDTH_PX);
  });

  it("ignores a non-left pointer button", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.pointerDown(handle, { button: 2, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("ignores moves from a second concurrent pointer (wongk review)", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    // A second touch (pointerId 2) must not steal the drag started by pointer 1.
    fireEvent.pointerMove(handle, { clientX: 999, pointerId: 2 });
    // The legitimate pointer's move + release commit only its own delta.
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith("owner", 230);
    for (const [, width] of onResize.mock.calls) {
      // The rogue pointer's 999 delta never reaches onResize.
      expect(width).toBe(230);
    }
  });

  it("tears down the drag when pointer capture is lost (wongk review)", () => {
    const onResize = vi.fn();
    renderGrid(onResize, { owner: 150, status: 120 });
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    // Capture is lost without a pointerup/pointercancel.
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    // A stray move after cleanup must not resize (listeners are gone): a width
    // of 500 (base 150 + delta 350) would prove the move handler still ran.
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    for (const [, width] of onResize.mock.calls) {
      expect(width).not.toBe(500);
    }
  });
});
