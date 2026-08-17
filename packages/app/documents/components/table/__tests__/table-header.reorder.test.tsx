import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentTableHeader } from "../table-header";

const VISIBLE_COLUMNS = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Priority,
];

const baseProps = {
  visibleColumns: VISIBLE_COLUMNS,
  sortBy: null,
  sortDir: "desc" as const,
  onSort: vi.fn(),
};

const REORDER_ANY = /Reorder .* column/;
const REORDER_TYPE = /Reorder Type column/;
const REORDER_ASSIGNEE = /Reorder Assignee column/;
const REORDER_PRIORITY = /Reorder Priority column/;

describe("DocumentTableHeader — column reorder (FEA-4165)", () => {
  it("renders no drag handles when onReorderColumns is omitted", () => {
    render(<DocumentTableHeader {...baseProps} />);

    expect(
      screen.queryByRole("button", { name: REORDER_ANY })
    ).not.toBeInTheDocument();
  });

  it("renders a drag handle per data column when reorder is wired", () => {
    render(<DocumentTableHeader {...baseProps} onReorderColumns={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: REORDER_TYPE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REORDER_ASSIGNEE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REORDER_PRIORITY })
    ).toBeInTheDocument();
  });

  it("emits the reordered VISIBLE order when a handle is moved right via keyboard", () => {
    const onReorderColumns = vi.fn();
    render(
      <DocumentTableHeader {...baseProps} onReorderColumns={onReorderColumns} />
    );

    fireEvent.keyDown(screen.getByRole("button", { name: REORDER_TYPE }), {
      key: "ArrowRight",
    });

    expect(onReorderColumns).toHaveBeenCalledWith([
      DocumentColumn.Assignee,
      DocumentColumn.Type,
      DocumentColumn.Priority,
    ]);
  });

  it("does not move a column past the left edge", () => {
    const onReorderColumns = vi.fn();
    render(
      <DocumentTableHeader {...baseProps} onReorderColumns={onReorderColumns} />
    );

    fireEvent.keyDown(screen.getByRole("button", { name: REORDER_TYPE }), {
      key: "ArrowLeft",
    });

    // Type is already first; the emitted order is unchanged.
    expect(onReorderColumns).toHaveBeenCalledWith(VISIBLE_COLUMNS);
  });
});
