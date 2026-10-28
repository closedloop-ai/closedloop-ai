import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridTableV2 } from "../components/ui/grid-table-v2";
import { GRID_ROW_DRAG_TYPE } from "../lib/grid-table-v2-group-drop";

const rows = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];
function transfer() {
  const data = new Map<string, string>();
  return {
    setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}
function mount(canDrop = true) {
  const onRowDrop = vi.fn();
  const onGroupDrop = vi.fn();
  const result = render(
    <GridTableV2
      canDropOnRow={() => canDrop}
      columns={[]}
      getRowId={(row) => row.id}
      gridTemplateColumns="1fr"
      groups={[{ key: "group", label: "Group", items: rows }]}
      items={rows}
      leadingLabel="Name"
      mode="expanded"
      onGroupDrop={onGroupDrop}
      onRowDrop={onRowDrop}
      renderCell={() => null}
      renderLead={(row) => (
        <>
          <button
            aria-label={`Drag ${row.name}`}
            data-grid-row-drag-handle=""
            draggable
            type="button"
          >
            Grip
          </button>
          <span>{row.name}</span>
        </>
      )}
      rowDragHandleOnly
      rowDragPreviewLabel={(row) => row.name}
    />
  );
  const first = screen
    .getByText("Alpha")
    .closest<HTMLElement>("[data-grid-row]");
  const second = screen
    .getByText("Beta")
    .closest<HTMLElement>("[data-grid-row]");
  if (!(first && second)) {
    throw new Error("Missing grid fixture row");
  }
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 40,
    top: 40,
    bottom: 80,
    left: 0,
    right: 500,
    width: 500,
    height: 40,
    toJSON: () => ({}),
  });
  return { ...result, first, second, onRowDrop, onGroupDrop };
}
describe("explicit row placement", () => {
  it.each([
    ["before", 0, 42, 42],
    ["after", 0, 78, 78],
    ["inside", 40, 60, 80],
  ] as const)(
    "keeps the preview clear of the %s indicator",
    (placement, clientX, clientY, expectedTop) => {
      const { second } = mount();
      const dataTransfer = transfer();
      const source = screen.getByRole("button", { name: "Drag Alpha" });
      const start = createEvent.dragStart(source, { dataTransfer });
      Object.defineProperties(start, {
        clientX: { value: 0 },
        clientY: { value: 20 },
      });
      fireEvent(source, start);
      const over = createEvent.dragOver(second, { dataTransfer });
      Object.defineProperties(over, {
        clientX: { value: clientX },
        clientY: { value: clientY },
      });
      fireEvent(second, over);
      expect(second).toHaveAttribute("data-row-drop", placement);
      expect(screen.getByTestId("drag-preview-chip")).toHaveStyle({
        top: `${expectedTop}px`,
      });
    }
  );

  it("keeps whitespace available for selection and allows the explicit button grip to move before a row", () => {
    const { first, second, onRowDrop } = mount();
    const dataTransfer = transfer();
    expect(first).toHaveAttribute("draggable", "false");
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Alpha" }), {
      dataTransfer,
      clientX: 0,
    });
    expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe("a");
    const over = createEvent.dragOver(second, { dataTransfer });
    Object.defineProperties(over, {
      clientX: { value: 0 },
      clientY: { value: 42 },
    });
    fireEvent(second, over);
    expect(second).toHaveAttribute("data-row-drop", "before");
    fireEvent.drop(second, { dataTransfer });
    expect(onRowDrop).toHaveBeenCalledWith(rows[0], rows[1], "before");
  });
  it("actively refuses an illegal row placement without allowing its containing group to claim the drop", () => {
    const { second, onRowDrop, onGroupDrop } = mount(false);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Alpha" }), {
      dataTransfer,
    });
    fireEvent.dragOver(second, { dataTransfer, clientY: 42 });
    fireEvent.drop(second, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    expect(onRowDrop).not.toHaveBeenCalled();
    expect(onGroupDrop).not.toHaveBeenCalled();
  });
});
