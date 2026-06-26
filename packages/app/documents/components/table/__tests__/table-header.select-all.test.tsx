import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentTableHeader } from "../table-header";

describe("DocumentTableHeader — select-all checkbox", () => {
  const baseProps = {
    visibleColumns: [] as never[],
    sortBy: null,
    sortDir: "desc" as const,
    onSort: vi.fn(),
  };

  it("does not render a checkbox when showSelectAll is false", () => {
    render(<DocumentTableHeader {...baseProps} showSelectAll={false} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not render a checkbox when showSelectAll is undefined", () => {
    render(<DocumentTableHeader {...baseProps} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders an unchecked checkbox when nothing is selected", () => {
    render(
      <DocumentTableHeader
        {...baseProps}
        allSelected={false}
        showSelectAll
        someSelected={false}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("renders an indeterminate checkbox when some items are selected", () => {
    render(
      <DocumentTableHeader
        {...baseProps}
        allSelected={false}
        showSelectAll
        someSelected
      />
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "indeterminate");
  });

  it("renders a checked checkbox when all items are selected", () => {
    render(
      <DocumentTableHeader
        {...baseProps}
        allSelected
        showSelectAll
        someSelected={false}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "checked");
  });

  it("calls onSelectAll with true when unchecked checkbox is clicked", () => {
    const onSelectAll = vi.fn();

    render(
      <DocumentTableHeader
        {...baseProps}
        allSelected={false}
        onSelectAll={onSelectAll}
        showSelectAll
        someSelected={false}
      />
    );

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onSelectAll).toHaveBeenCalledWith(true);
  });

  it("calls onSelectAll with false when checked checkbox is clicked", () => {
    const onSelectAll = vi.fn();

    render(
      <DocumentTableHeader
        {...baseProps}
        allSelected
        onSelectAll={onSelectAll}
        showSelectAll
        someSelected={false}
      />
    );

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onSelectAll).toHaveBeenCalledWith(false);
  });
});
