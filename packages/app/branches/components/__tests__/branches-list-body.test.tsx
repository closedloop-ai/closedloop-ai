import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { BranchesListBody } from "../branches-list-body";

const BASE_PROPS: ComponentProps<typeof BranchesListBody> = {
  allRows: [],
  approved: true,
  columnOrder: [],
  columnWidths: {},
  hasRows: true,
  hasWindow: true,
  isError: false,
  isPending: false,
  items: [],
  onColumnOrderChange: () => undefined,
  onColumnWidthChange: () => undefined,
  onRetry: () => undefined,
  onShowAllTime: () => undefined,
  onSort: () => undefined,
  sortBy: "lastActivity",
  sortDir: "desc",
  visibleColumns: new Set(),
  windowedEmptyIsNoMatches: false,
};

describe("BranchesListBody empty recovery", () => {
  it("does not offer to widen time when facets caused the empty result", () => {
    render(<BranchesListBody {...BASE_PROPS} />);

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No branches match the current filters. Try clearing a filter."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show all time" })
    ).not.toBeInTheDocument();
  });

  it("offers to widen time when the bounded window caused the empty result", () => {
    const onShowAllTime = vi.fn();
    render(
      <BranchesListBody
        {...BASE_PROPS}
        onShowAllTime={onShowAllTime}
        windowedEmptyIsNoMatches
      />
    );

    screen.getByRole("button", { name: "Show all time" }).click();
    expect(onShowAllTime).toHaveBeenCalledTimes(1);
  });
});
