import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useBranchTracePlayhead } from "../../../lib/branch-trace-playhead";
import {
  completeSessionsTrace,
  sessionsPanelDetail,
} from "../branch-sessions-panel-fixtures";
import { BranchSessionsTimelinePanel } from "../branch-sessions-timeline-tab";

vi.mock("../../branch-merged-trace", () => ({
  BranchMergedTrace() {
    const controller = useBranchTracePlayhead();
    return (
      <button onClick={() => controller.scrubToRow(0)} type="button">
        {controller.activeRow ?? "Select trace row"}
      </button>
    );
  },
}));

describe("paged branch timeline", () => {
  it("retains the selected playhead row while another page arrives", () => {
    const scrollElementRef = createRef<HTMLDivElement>();
    const overviewItems = completeSessionsTrace.items;
    const renderPanel = (items: typeof overviewItems) => (
      <BranchSessionsTimelinePanel
        detail={sessionsPanelDetail}
        scrollElementRef={scrollElementRef}
        trace={{
          data: { ...completeSessionsTrace, items, overviewItems },
          isLoading: false,
        }}
      />
    );
    const { rerender } = render(renderPanel(overviewItems.slice(0, 2)));
    fireEvent.click(screen.getByRole("button", { name: "Select trace row" }));
    expect(screen.getByRole("button", { name: "0" })).toBeVisible();
    rerender(renderPanel(overviewItems));
    expect(screen.getByRole("button", { name: "0" })).toBeVisible();
  });
});
