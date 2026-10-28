import { EMPTY_TABLE_COLLAPSED_GROUPS } from "@repo/app/shared/lib/table-collapsed-groups";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it, vi } from "vitest";
import { composeBranchResetView } from "../branch-page-state";

describe("composeBranchResetView (ISS-12664)", () => {
  it("resets the saved view, then clears the URL-stated grouping and bands", () => {
    const calls: string[] = [];
    const resetView = vi.fn(() => calls.push("resetView"));
    const handleGroupingChange = vi.fn(() => calls.push("grouping"));
    const handleCollapsedGroupsChange = vi.fn(() => calls.push("collapsed"));

    composeBranchResetView(resetView, {
      handleCollapsedGroupsChange,
      handleGroupingChange,
    })();

    expect(handleGroupingChange).toHaveBeenCalledWith(EMPTY_TABLE_GROUPING);
    expect(handleCollapsedGroupsChange).toHaveBeenCalledWith(
      EMPTY_TABLE_COLLAPSED_GROUPS
    );
    expect(calls).toEqual(["resetView", "grouping", "collapsed"]);
  });
});
