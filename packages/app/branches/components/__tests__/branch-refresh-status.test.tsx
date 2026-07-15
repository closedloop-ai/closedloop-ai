import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_REFRESH_STATUS_VISIBLE_MS,
  BranchRefreshState,
  BranchRefreshStatus,
  useAutoClearBranchRefreshState,
} from "../branch-refresh-status";

describe("BranchRefreshStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-clears transient success and error states", () => {
    vi.useFakeTimers();
    render(<RefreshStatusHarness initialState={BranchRefreshState.Success} />);

    expect(screen.getByText("Branch data refreshed.")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(BRANCH_REFRESH_STATUS_VISIBLE_MS);
    });

    expect(
      screen.queryByText("Branch data refreshed.")
    ).not.toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Show error" }).click();
    });

    expect(
      screen.getByText("Branch refresh failed. Retry from the Refresh button.")
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(BRANCH_REFRESH_STATUS_VISIBLE_MS);
    });

    expect(
      screen.queryByText(
        "Branch refresh failed. Retry from the Refresh button."
      )
    ).not.toBeInTheDocument();
  });
});

function RefreshStatusHarness({
  initialState,
}: {
  initialState: BranchRefreshState;
}) {
  const [state, setState] = useState(initialState);
  useAutoClearBranchRefreshState(state, setState);

  return (
    <>
      <BranchRefreshStatus state={state} subject="branch data" />
      <button onClick={() => setState(BranchRefreshState.Error)} type="button">
        Show error
      </button>
    </>
  );
}
