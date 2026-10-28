import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const ROWS = [
  { id: "one", name: "Save" },
  { id: "two", name: "Cancel" },
];

describe("grid row activation boundary", () => {
  it("marks only actionable rows and preserves nested control ownership", () => {
    const select = vi.fn();
    const open = vi.fn();
    const props = {
      columns: [{ id: "action", label: "Action" }],
      getRowId: (row: (typeof ROWS)[number]) => row.id,
      gridTemplateColumns: "200px 100px",
      leadingLabel: "Name",
      items: ROWS,
      renderLead: (row: (typeof ROWS)[number]) => row.name,
      renderCell: () => (
        <button onClick={open} type="button">
          <svg aria-hidden="true" data-testid="nested-action-icon" />
          Open
        </button>
      ),
    };
    const view = render(<GridTableV2 {...props} onRowClick={select} />);
    const row = view.getByText("Save").closest("[data-grid-row]");
    expect(row).toHaveAttribute("data-analytics-action", "true");
    expect(row).toHaveAttribute("data-analytics-label", "Select row");
    expect(row).toHaveAttribute(
      "data-analytics-label-source",
      JSON.stringify(["Select row"])
    );
    fireEvent.click(view.getByText("Save"));
    expect(select).toHaveBeenCalledExactlyOnceWith(
      ROWS[0],
      expect.anything(),
      ROWS
    );
    fireEvent.click(view.getAllByRole("button", { name: "Open" })[0]);
    expect(open).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    fireEvent.click(view.getAllByTestId("nested-action-icon")[0]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    view.rerender(<GridTableV2 {...props} />);
    expect(
      view.getByText("Save").closest("[data-grid-row]")
    ).not.toHaveAttribute("data-analytics-action");
    expect(
      view.getByText("Save").closest("[data-grid-row]")
    ).not.toHaveAttribute("data-analytics-label-source");
  });
});
