// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { branchRows } from "../mock";
import { buildBranchDetail } from "../mock-detail";
import { BranchCostToMerge, BranchHeadlineCards } from "./detail-panels";

describe("Branch cost detail presentation", () => {
  it("renders authoritative zero without meaningless phase percentages", () => {
    render(<BranchCostToMerge detail={detailFor("br_session_cost")} />);

    expect(screen.getByText("$0", { exact: true })).toBeTruthy();
    expect(screen.getByText("No priced spend recorded yet.")).toBeTruthy();
    expect(screen.queryByText("Build", { exact: true })).toBeNull();
    expect(screen.queryByText("Review", { exact: true })).toBeNull();
    expect(screen.queryByText("Rework", { exact: true })).toBeNull();
  });

  it("keeps partial LOC-per-dollar evidence beside its disclosure", () => {
    render(<BranchHeadlineCards detail={detailFor("br_1289")} />);

    expect(screen.getByText("1.09*", { exact: true })).toBeTruthy();
    expect(
      screen.getByText((content) =>
        content.includes(
          "306 lines changed · $280* · * Calculated from available qualifying Session costs."
        )
      )
    ).toBeTruthy();
  });

  it.each([
    { branchId: "br_session_cost", label: "N/A" },
    { branchId: "br_dependabot", label: "Unavailable" },
  ])("omits the LOC/$ unit for $label", ({ branchId, label }) => {
    render(<BranchHeadlineCards detail={detailFor(branchId)} />);

    expect(screen.getByText(label, { exact: true })).toBeTruthy();
    expect(screen.queryByText("LOC/$", { exact: true })).toBeNull();
  });

  it("omits the LOC/$ unit when positive cost has no LOC numerator", () => {
    const row = branchRows.find(({ id }) => id === "br_1284");
    if (!row) {
      throw new Error("Missing positive-cost Branch fixture");
    }
    const detail = buildBranchDetail({
      ...row,
      additions: null,
      deletions: null,
    });
    render(<BranchHeadlineCards detail={detail} />);

    expect(screen.getByText("Unavailable", { exact: true })).toBeTruthy();
    expect(screen.queryByText("LOC/$", { exact: true })).toBeNull();
  });
});

function detailFor(branchId: string) {
  const row = branchRows.find(({ id }) => id === branchId);
  if (!row) {
    throw new Error(`Missing Branch fixture ${branchId}`);
  }
  return buildBranchDetail(row);
}
