import { describe, expect, it } from "vitest";
import { parseBranchSavedView } from "../branch-saved-view";

describe("parseBranchSavedView", () => {
  it("accepts a well-formed view", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        dateRange: "30d",
        hiddenColumns: ["points", "checks"],
      })
    ).toEqual({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points", "checks"],
    });
  });

  it("defaults the time window to 7d when absent", () => {
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.dateRange
    ).toBe("7d");
  });

  it("rejects non-objects and unknown enum values", () => {
    expect(parseBranchSavedView(null)).toBeNull();
    expect(parseBranchSavedView("nope")).toBeNull();
    expect(
      parseBranchSavedView({
        sortKey: "bogus",
        sortDir: "asc",
      })
    ).toBeNull();
  });

  it("defaults hiddenColumns to [] and drops non-string entries", () => {
    expect(
      parseBranchSavedView({
        sortKey: "lastActivity",
        sortDir: "desc",
        hiddenColumns: ["points", 7, null],
      })?.hiddenColumns
    ).toEqual(["points"]);
    expect(
      parseBranchSavedView({
        sortKey: "lastActivity",
        sortDir: "desc",
      })?.hiddenColumns
    ).toEqual([]);
  });
});
