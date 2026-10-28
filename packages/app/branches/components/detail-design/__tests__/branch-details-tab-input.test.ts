import { formatLocPerDollar } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import {
  BRANCH_DESIGN_DETAILS_INPUT,
  BRANCH_DESIGN_PULL_REQUEST_IDS,
  branchDesignDetailFor,
} from "../branch-detail-design-fixtures";

const lines = (
  pullRequest:
    | { additions?: number | null; deletions?: number | null }
    | null
    | undefined
) => (pullRequest?.additions ?? 0) + (pullRequest?.deletions ?? 0);

describe("ISS-12252 Branch The Details tab page input", () => {
  it("divides branch-lifetime LOC (both pull requests) by the branch's cost", () => {
    const merged = branchDesignDetailFor(BRANCH_DESIGN_PULL_REQUEST_IDS.Merged);
    const open = branchDesignDetailFor(BRANCH_DESIGN_PULL_REQUEST_IDS.Open);
    const lifetimeLines =
      lines(merged.selectedPullRequest) + lines(open.selectedPullRequest);
    // Both cycles' lines, never the open PR's alone.
    expect(lines(merged.selectedPullRequest)).toBeGreaterThan(0);
    expect(BRANCH_DESIGN_DETAILS_INPUT.locPerDollar).toBe(
      formatLocPerDollar(lifetimeLines / (open.estimatedCostUsd ?? 0))
    );
  });
});
