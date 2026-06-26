import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="dropdown-item" onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock("../document-row", () => ({
  getDocumentRowGridTemplateColumns: () => "1fr",
}));

import { DocumentTableHeader } from "../table-header";

const NAME_SORT_OPTIONS = [
  { key: "title", label: "Name" },
  { key: "status", label: "Status" },
  { key: "id", label: "ID" },
] as const;

const NAME_PATTERN = /name/i;

describe("DocumentTableHeader sort menu", () => {
  const onSort = vi.fn();
  const onClearSort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Name header as a simple button when nameSortOptions is not provided", () => {
    render(
      <DocumentTableHeader
        onSort={onSort}
        sortBy={null}
        sortDir="asc"
        visibleColumns={[]}
      />
    );

    expect(screen.queryByTestId("dropdown-menu")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: NAME_PATTERN });
    fireEvent.click(button);

    expect(onSort).toHaveBeenCalledWith("title", "desc");
  });

  it("renders Name header as a dropdown when nameSortOptions is provided", () => {
    render(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy={null}
        sortDir="asc"
        visibleColumns={[]}
      />
    );

    expect(screen.getByTestId("dropdown-menu")).toBeInTheDocument();
    expect(screen.getByTestId("dropdown-content")).toBeInTheDocument();

    const items = screen.getAllByTestId("dropdown-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Name");
    expect(items[1]).toHaveTextContent("Status");
    expect(items[2]).toHaveTextContent("ID");
  });

  it("calls onSort with ascending direction when clicking a non-active sort key", () => {
    render(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy={null}
        sortDir="asc"
        visibleColumns={[]}
      />
    );

    const items = screen.getAllByTestId("dropdown-item");
    fireEvent.click(items[1]);

    expect(onSort).toHaveBeenCalledWith("status", "asc");
  });

  it("calls onSort with descending direction when clicking the active asc sort key", () => {
    render(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy="status"
        sortDir="asc"
        visibleColumns={[]}
      />
    );

    const items = screen.getAllByTestId("dropdown-item");
    fireEvent.click(items[1]);

    expect(onSort).toHaveBeenCalledWith("status", "desc");
  });

  it("calls onClearSort when clicking the active desc sort key", () => {
    render(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy="status"
        sortDir="desc"
        visibleColumns={[]}
      />
    );

    const items = screen.getAllByTestId("dropdown-item");
    fireEvent.click(items[1]);

    expect(onClearSort).toHaveBeenCalledOnce();
    expect(onSort).not.toHaveBeenCalled();
  });

  it("shows directional arrow for the active sort key in the dropdown", () => {
    const { rerender } = render(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy="title"
        sortDir="asc"
        visibleColumns={[]}
      />
    );

    const activeItem = screen.getAllByTestId("dropdown-item")[0];
    const arrowUp = activeItem.querySelector(".lucide-arrow-up");
    expect(arrowUp).toBeInTheDocument();

    const inactiveItem = screen.getAllByTestId("dropdown-item")[1];
    const arrowUpDown = inactiveItem.querySelector(".lucide-arrow-up-down");
    expect(arrowUpDown).toBeInTheDocument();

    rerender(
      <DocumentTableHeader
        nameSortOptions={NAME_SORT_OPTIONS}
        onClearSort={onClearSort}
        onSort={onSort}
        sortBy="title"
        sortDir="desc"
        visibleColumns={[]}
      />
    );

    const arrowDown = screen
      .getAllByTestId("dropdown-item")[0]
      .querySelector(".lucide-arrow-down");
    expect(arrowDown).toBeInTheDocument();
  });
});
