import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BranchesEmptyState,
  BranchesEmptyVariant,
} from "../branches-empty-state";

const STILL_SYNCING_REGEX = /still syncing/i;

describe("BranchesEmptyState (#3663)", () => {
  it("renders the onboarding copy for the genuine no-branches state and no action", () => {
    render(<BranchesEmptyState variant={BranchesEmptyVariant.NoBranches} />);

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Branches appear here once they're synced from your connected provider."
      )
    ).toBeInTheDocument();
    // Onboarding is not an actionable state — no reset button.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a 'Show all time' action for a windowed filtered-empty and wires it", () => {
    const onShowAllTime = vi.fn();
    render(
      <BranchesEmptyState
        onShowAllTime={onShowAllTime}
        variant={BranchesEmptyVariant.NoMatches}
      />
    );

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByText("No branches were active in the selected date range.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));
    expect(onShowAllTime).toHaveBeenCalledTimes(1);
  });

  it("renders a filter-clearing filtered-empty with no action when no window is active", () => {
    render(<BranchesEmptyState variant={BranchesEmptyVariant.NoMatches} />);

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No branches match the current filters. Try clearing a filter."
      )
    ).toBeInTheDocument();
    // No date window to widen → no "Show all time" action.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the unavailable state as an honest error with Retry, never a false 'no branches' (FEA-4181)", () => {
    const onRetry = vi.fn();
    render(
      <BranchesEmptyState
        onRetry={onRetry}
        variant={BranchesEmptyVariant.Unavailable}
      />
    );

    expect(screen.getByText("Couldn't load branches")).toBeInTheDocument();
    // review cid 3653690778: names the failure plainly — no "…or they're still
    // syncing" hedge (this variant is only ever reached on a real errored read).
    expect(
      screen.getByText("Something went wrong loading your branches.")
    ).toBeInTheDocument();
    expect(screen.queryByText(STILL_SYNCING_REGEX)).not.toBeInTheDocument();
    // Must NOT masquerade as a genuine or filtered empty.
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching branches")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
