import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { useGridRowSelection } from "@closedloop-ai/design-system/hooks/use-grid-row-selection";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const ROWS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];
const GROUPS = [
  { items: [ROWS[0], ROWS[1]], key: "open", label: "Open" },
  { items: [ROWS[2]], key: "done", label: "Done" },
];

afterEach(cleanup);

function GroupedList({ trailing = false }: { trailing?: boolean }) {
  const selection = useGridRowSelection<(typeof ROWS)[number]>({
    visibleRowIds: ROWS.map((row) => row.id),
  });
  return (
    <GridTableV2
      columns={[]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(200px, 1fr)"
      groups={GROUPS}
      isRowSelected={(row) => selection.selectedIds.has(row.id)}
      items={[]}
      leadingLabel="Name"
      mode="expanded"
      onRowClick={(row, event, rows) =>
        selection.onRowSelection(row, event, rows)
      }
      onRowKeyboardNavigate={(row, event, rows) =>
        selection.onRowSelection(row, event, rows)
      }
      onRowSelectionToggle={selection.toggleRowSelection}
      onSelectAllRows={selection.selectAllRows}
      renderCell={() => null}
      renderLead={(row) => <span>{row.name}</span>}
      suppressCellTabStops
      trailingHeader={trailing ? <span>add field</span> : undefined}
    />
  );
}

const selectedIds = () =>
  Array.from(
    document.querySelectorAll('[data-grid-row][aria-selected="true"]')
  ).map((row) => row.getAttribute("data-grid-row-id"));

describe("click selection moves focus into the grid (ISS-13007)", () => {
  it("lets Ctrl+A select every row and Escape clear after a plain cell click in a grouped grid", () => {
    render(<GroupedList />);
    const cell = screen.getByText("Alpha");

    fireEvent.click(cell);
    expect(selectedIds()).toEqual(["a"]);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("grid").contains(document.activeElement)).toBe(
      true
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      ctrlKey: true,
      key: "a",
    });
    expect(selectedIds()).toEqual(["a", "b", "c"]);
  });

  it("moves focus into the row's last navigable cell when the click lands on the trailing filler cell, so Ctrl+A reaches the grid", () => {
    render(<GroupedList trailing />);
    const alphaRow = document.querySelector<HTMLElement>(
      '[data-grid-row-id="a"]'
    ) as HTMLElement;
    const filler = alphaRow.querySelector<HTMLElement>(
      '[role="gridcell"][aria-hidden="true"]'
    );
    expect(filler).not.toBeNull();
    expect(filler?.hasAttribute("data-grid-cell")).toBe(false);

    fireEvent.click(filler as HTMLElement);

    expect(selectedIds()).toEqual(["a"]);
    const active = document.activeElement as HTMLElement;
    expect(active.hasAttribute("data-grid-cell")).toBe(true);
    expect(alphaRow.contains(active)).toBe(true);

    fireEvent.keyDown(active, { ctrlKey: true, key: "a" });
    expect(selectedIds()).toEqual(["a", "b", "c"]);
  });
});
