import { ReadSource } from "@repo/api/src/types/read-source";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import { BranchesToolbar } from "../branches-toolbar";

/**
 * ISS-5477: Branches mounts in the same desktop renderer as the Dashboard, so
 * during the read-source hold it must carry the same explanation rather than a
 * bare muted "Local" and the old QA-only tooltip.
 */
describe("BranchesToolbar read-source detail", () => {
  it("forwards the cutover explanation to the badge", () => {
    render(
      <BranchesToolbar
        dateRange="7d"
        filters={DEFAULT_BRANCH_FILTERS}
        onDateRangeChange={vi.fn()}
        onFiltersChange={vi.fn()}
        onToggleColumn={vi.fn()}
        readSource={ReadSource.Local}
        readSourceDetail="Your history is still uploading (42 items to go). Nothing is missing."
        rows={[]}
        visibleColumns={new Set<string>()}
      />
    );

    const badge = screen.getByTestId("read-source-badge");
    expect(badge.getAttribute("data-read-source-detail")).toContain(
      "still uploading"
    );
  });

  it("marks a known-short cloud read here too", () => {
    render(
      <BranchesToolbar
        dateRange="7d"
        filters={DEFAULT_BRANCH_FILTERS}
        onDateRangeChange={vi.fn()}
        onFiltersChange={vi.fn()}
        onToggleColumn={vi.fn()}
        readSource={ReadSource.Cloud}
        readSourceDetail="This workspace view may be missing 12 items still on this device."
        readSourceIncomplete
        rows={[]}
        visibleColumns={new Set<string>()}
      />
    );

    expect(
      screen
        .getByTestId("read-source-badge")
        .getAttribute("data-read-source-incomplete")
    ).toBe("true");
  });

  it("renders exactly today's badge when the host passes no detail", () => {
    render(
      <BranchesToolbar
        dateRange="7d"
        filters={DEFAULT_BRANCH_FILTERS}
        onDateRangeChange={vi.fn()}
        onFiltersChange={vi.fn()}
        onToggleColumn={vi.fn()}
        readSource={ReadSource.Local}
        rows={[]}
        visibleColumns={new Set<string>()}
      />
    );

    const badge = screen.getByTestId("read-source-badge");
    expect(badge.getAttribute("data-read-source-detail")).toBeNull();
    expect(badge.getAttribute("data-read-source-incomplete")).toBeNull();
  });
});
