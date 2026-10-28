import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

type Row = { id: string; name: string; status: string };

const rows: Row[] = [
  { id: "one", name: "First session", status: "Active" },
  { id: "two", name: "Second session", status: "Inactive" },
];

function renderFixture(staticTableSemantics = false) {
  render(
    <GridTableV2
      columns={[{ id: "status", label: "Status" }]}
      getRowId={(row: Row) => row.id}
      gridTemplateColumns="minmax(200px, 1fr) 120px"
      items={rows}
      leadingLabel="Session"
      mode="expanded"
      renderCell={(_columnId, row) => row.status}
      renderLead={(row) => <a href={`#${row.id}`}>{row.name}</a>}
      staticTableSemantics={staticTableSemantics}
    />
  );
}

describe("GridTableV2 static table semantics", () => {
  it("keeps the default grid and roving cell entry when the option is absent", () => {
    renderFixture();

    const grid = screen.getByRole("grid");
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(4);
    expect(
      grid.querySelectorAll('[data-grid-cell][tabindex="0"]')
    ).toHaveLength(1);
  });

  it("opts into a static table with native link focus and no roving cell keys", () => {
    renderFixture(true);

    const table = screen.getByRole("table");
    expect(screen.queryByRole("grid")).toBeNull();
    const [header, ...body] = within(table).getAllByRole("row");
    expect(within(header).getAllByRole("columnheader")).toHaveLength(2);
    for (const row of body) {
      expect(within(row).getAllByRole("cell")).toHaveLength(2);
    }
    expect(table.querySelectorAll("[data-grid-cell]")).toHaveLength(0);

    const link = screen.getByRole("link", { name: rows[0].name });
    link.focus();
    fireEvent.keyDown(link, { key: "ArrowRight" });
    expect(link).toHaveFocus();
  });

  it("uses static cells in group headers as well as data rows", () => {
    render(
      <GridTableV2
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row: Row) => row.id}
        gridTemplateColumns="minmax(200px, 1fr) 120px"
        groups={[{ key: "active", label: "Active", items: [rows[0]] }]}
        items={[]}
        leadingLabel="Session"
        mode="expanded"
        renderCell={(_columnId, row) => row.status}
        renderLead={(row) => row.name}
        staticTableSemantics
      />
    );

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("rowgroup")).toHaveLength(1);
    expect(within(table).queryAllByRole("gridcell")).toHaveLength(0);
    expect(within(table).getAllByRole("cell")).toHaveLength(3);
  });
});
