import {
  BranchTraceCompletenessState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSessionsTrace,
  sessionsPanelDetail,
} from "../branch-sessions-panel-fixtures";
import { BranchSessionsTimelineTab } from "../branch-sessions-timeline-tab";

/**
 * ISS-10793. The production Branch page mounts BranchSessionsTimelineTab, and
 * this ticket promises it renders exactly as before: it still fetches its own
 * trace and never shows the new host-set state views. ISS-10797 moves the fetch into the adapter.
 */

const traceQuery = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    isLoading: true,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    retryPage: vi.fn(),
  },
}));

vi.mock("../../../hooks/use-branch-trace-pages", () => ({
  useBranchTracePages: vi.fn(() => traceQuery.current),
}));

function renderTab() {
  return render(
    <BranchSessionsTimelineTab
      detail={sessionsPanelDetail}
      scrollElementRef={createRef<HTMLDivElement>()}
    />
  );
}

describe("BranchSessionsTimelineTab (production wrapper)", () => {
  beforeEach(() => {
    traceQuery.current = {
      ...traceQuery.current,
      data: undefined,
      isLoading: true,
      isFetchNextPageError: false,
      isFetchingNextPage: false,
    };
  });

  it("shows today's skeleton while its own trace query is loading", () => {
    renderTab();

    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(
      screen.queryByText("Combined session trace", { exact: false })
    ).not.toBeInTheDocument();
  });

  it("renders the loaded timeline from its own trace query", () => {
    traceQuery.current = {
      ...traceQuery.current,
      data: completeSessionsTrace,
      isLoading: false,
    };
    renderTab();

    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("2 sessions");
  });

  it("retries a failed later page from the existing notice without replacing the timeline", () => {
    traceQuery.current = {
      ...traceQuery.current,
      data: {
        ...completeSessionsTrace,
        completeness: {
          state: BranchTraceCompletenessState.Incomplete,
          reason: BranchTraceUnavailableReason.PageFailure,
        },
        aggregateCompleteness: {
          state: BranchTraceCompletenessState.Incomplete,
          reason: BranchTraceUnavailableReason.PageFailure,
        },
      },
      isLoading: false,
      isFetchNextPageError: true,
    };
    const view = renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(traceQuery.current.retryPage).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).toBeInTheDocument();
    traceQuery.current.isFetchingNextPage = true;
    view.rerender(
      <BranchSessionsTimelineTab
        detail={sessionsPanelDetail}
        scrollElementRef={createRef<HTMLDivElement>()}
      />
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("never shows the host-set empty or error views", () => {
    traceQuery.current = {
      ...traceQuery.current,
      data: undefined,
      isLoading: false,
    };
    renderTab();

    // Production's own warning for a missing trace still renders, exactly as
    // on the base branch; only the new host-set views stay unreachable here.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Session trace unavailable"
    );
    // None of the panel's host-set views (empty/error/permission) renders.
    expect(document.querySelector("[data-branch-sessions-state]")).toBeNull();
  });
});
