import { GITHUB_COMPARE_FILE_LIMIT } from "@repo/github";
import { describe, expect, it } from "vitest";
import { branchAnalyticsSelect } from "./branch-analytics-select";
import {
  BRANCH_FILE_CHANGE_READ_BOUNDS,
  branchFileChangePersistenceCap,
  NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND,
  narrowestReadBound,
} from "./branch-file-change-read-bounds";
import {
  branchArtifactSelectForOrganization,
  branchDetailArtifactSelectForOrganization,
} from "./branch-read-selects";

const ORGANIZATION_ID = "org-1";

describe("branch file-change read bounds", () => {
  // Literals written here rather than read back from the module under test, so
  // moving a bound reddens this case. That is the intent: the persistence cap
  // and the bound it is measured against are only correct while someone moves
  // them together, and an exact-object match also fails when a consumer is added
  // or dropped without being named — the `branchDetailAndList` read ISS-10298
  // removed, and the `hasCompleteCloudLocCache` guard ISS-10009 part 2 did.
  it("names every completeness consumer and derives the strictest bound from them", () => {
    expect(BRANCH_FILE_CHANGE_READ_BOUNDS).toEqual({
      branchAnalytics: 500,
    });
    expect(NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND).toBe(500);
  });

  // One shipped bound, so nothing above can tell the narrowest apart from the
  // widest — and a cap checked against the WIDEST would pass while the strictest
  // consumer rejected every cache that filled it. Unequal literals pin the
  // direction against the day a second consumer appears.
  it("takes the NARROWEST of unequal bounds, not the widest", () => {
    expect(narrowestReadBound({ detail: 200, analytics: 500 })).toBe(200);
    expect(narrowestReadBound({ detail: 500, analytics: 200 })).toBe(200);
  });

  it("refuses an empty bound registry rather than reporting no bound at all", () => {
    expect(() => narrowestReadBound({})).toThrow(
      "Branch file-change bounds cannot be empty"
    );
  });

  it("returns a cap below the narrowest read bound unchanged", () => {
    expect(branchFileChangePersistenceCap(300)).toBe(300);
  });

  it("accepts a cap sitting exactly at the narrowest read bound", () => {
    expect(branchFileChangePersistenceCap(500)).toBe(500);
  });

  it("refuses a cap one row past the strictest completeness bound, naming both", () => {
    expect(() => branchFileChangePersistenceCap(501)).toThrow(
      "Branch file-change persistence cap 501 exceeds the strictest completeness bound (500 rows)"
    );
  });

  it.each([
    ["zero, which an empty-string parse silently produces", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses a %s cap before comparing it to any bound", (_label, cap) => {
    expect(() => branchFileChangePersistenceCap(cap)).toThrow(
      "must be a positive safe integer"
    );
  });

  // ISS-10298: the list, detail, and analytics selects fold their file-change
  // totals in SQL (`getBranchFileChangeTotals`) instead of loading the rows, so
  // there is no `take` left to pin — and no way back to one without this case
  // reddening. `fileChanges` reappearing on any of the three selects is the
  // regression: it would put the corpus-wide row projection back on the
  // `pageMode=server` list read this ticket took it off.
  it("loads no per-file rows on any branch select", () => {
    expect(
      branchArtifactSelectForOrganization(ORGANIZATION_ID).branch.select
    ).not.toHaveProperty("fileChanges");
    expect(
      branchDetailArtifactSelectForOrganization(ORGANIZATION_ID).branch.select
    ).not.toHaveProperty("fileChanges");
    expect(branchAnalyticsSelect.branch.select).not.toHaveProperty(
      "fileChanges"
    );
  });

  // The completeness bound is only reachable if persistence can fill it.
  // GitHub's compare ceiling sits under it, so a complete cache never lands AT
  // the bound, and a reader reintroducing a strict `<` against it could never
  // reject one. Driven through the SAME constant `file-cache-service` passes into this
  // helper, not a second literal of its value: raising GITHUB_COMPARE_FILE_LIMIT
  // past the bound must redden here rather than leave this green while the real
  // refresh starts throwing.
  it("caps persistence below the completeness bound, so no complete cache reads as truncated", () => {
    expect(
      branchFileChangePersistenceCap(GITHUB_COMPARE_FILE_LIMIT)
    ).toBeLessThan(BRANCH_FILE_CHANGE_READ_BOUNDS.branchAnalytics);
  });
});
