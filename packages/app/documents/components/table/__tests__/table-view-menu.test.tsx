import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Render the Popover open inline so its contents are queryable without a
// click. The real component closes on outside click, which complicates
// jsdom assertions; the test only cares about the menu's contents.
vi.mock("@repo/design-system/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { TableViewMenu } from "../table-view-menu";

const STACK_RANK_LABEL = /reset to stack rank/i;
const RESET_VIEW_LABEL = /reset view/i;

describe("TableViewMenu — Reset to stack rank (PLN-755 Phase D)", () => {
  it("does not render the Reset to stack rank button when handler is omitted", () => {
    render(<TableViewMenu onResetView={vi.fn()} />);
    expect(screen.queryByText(STACK_RANK_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(RESET_VIEW_LABEL)).toBeInTheDocument();
  });

  it("renders the Reset to stack rank button when handler is provided", () => {
    render(
      <TableViewMenu onResetToStackRank={vi.fn()} onResetView={vi.fn()} />
    );
    expect(screen.getByText(STACK_RANK_LABEL)).toBeInTheDocument();
    expect(screen.getByText(RESET_VIEW_LABEL)).toBeInTheDocument();
  });

  it("renders without Reset view when only the stack-rank handler is provided", () => {
    render(<TableViewMenu onResetToStackRank={vi.fn()} />);
    expect(screen.getByText(STACK_RANK_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(RESET_VIEW_LABEL)).not.toBeInTheDocument();
  });

  it("calls onResetToStackRank when the button is clicked", () => {
    const onResetToStackRank = vi.fn();
    render(<TableViewMenu onResetToStackRank={onResetToStackRank} />);
    fireEvent.click(screen.getByText(STACK_RANK_LABEL));
    expect(onResetToStackRank).toHaveBeenCalledTimes(1);
  });
});
