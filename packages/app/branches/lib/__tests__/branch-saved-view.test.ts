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
        columnOrder: ["repo", "owner"],
        columnWidths: { repo: 200 },
      })
    ).toEqual({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points", "checks"],
      columnOrder: ["repo", "owner"],
      columnWidths: { repo: 200 },
    });
  });

  it("FEA-4021: defaults columnOrder to [] and drops non-string entries", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnOrder: ["repo", 7, null, "owner"],
      })?.columnOrder
    ).toEqual(["repo", "owner"]);
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.columnOrder
    ).toEqual([]);
  });

  it("FEA-4168: defaults columnWidths to {} and drops malformed entries", () => {
    // Missing → {}.
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.columnWidths
    ).toEqual({});
    // A NaN/negative/non-number width is dropped; a valid width survives.
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnWidths: { repo: 200, owner: -5, status: "wide", checks: 0 },
      })?.columnWidths
    ).toEqual({ repo: 200 });
  });

  it("FEA-4168: degrades a non-object columnWidths to {}", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnWidths: ["not", "an", "object"],
      })?.columnWidths
    ).toEqual({});
  });

  it("FEA-4004: tolerates and drops a legacy persisted showHidden key", () => {
    // The merged/agent-branch hide was removed; an install that persisted the
    // old `showHidden` extra must still restore its sort/columns/window cleanly,
    // with the retired key silently dropped (no `showHidden` on the result).
    const parsed = parseBranchSavedView({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points"],
      showHidden: true,
    });
    expect(parsed).toEqual({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points"],
      columnOrder: [],
      columnWidths: {},
    });
    expect(parsed).not.toHaveProperty("showHidden");
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
