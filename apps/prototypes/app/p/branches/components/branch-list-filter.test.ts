import { describe, expect, it } from "vitest";
import { type BranchRow, BranchStatus, branchRows, DateRange } from "../mock";
import {
  ActivityRange,
  activityRange,
  BranchFilterFacet,
  ChangesRange,
  createDefaultBranchFilters,
  filterBranchRows,
  isBranchRowInDateRange,
  PullRequestPresence,
  selfExcludingFacetRows,
} from "./branch-list-filter";
import { BRANCH_METRIC_FIXTURE_NOW } from "./branch-list-fixtures";

describe("Branch list cohort filtering", () => {
  it("uses inclusive row boundaries and retains unknown activity timestamps", () => {
    const boundary = withActivity(
      branchRows[0] as BranchRow,
      "2026-06-29T00:00:00.000Z"
    );
    const before = withActivity(
      branchRows[1] as BranchRow,
      "2026-06-28T23:59:59.999Z"
    );
    const malformed = withActivity(branchRows[2] as BranchRow, "not-a-date");

    expect(
      isBranchRowInDateRange(
        boundary,
        DateRange.ThirtyDays,
        BRANCH_METRIC_FIXTURE_NOW
      )
    ).toBe(true);
    expect(
      isBranchRowInDateRange(
        before,
        DateRange.ThirtyDays,
        BRANCH_METRIC_FIXTURE_NOW
      )
    ).toBe(false);
    expect(
      isBranchRowInDateRange(
        malformed,
        DateRange.ThirtyDays,
        BRANCH_METRIC_FIXTURE_NOW
      )
    ).toBe(true);
  });

  it("derives half-open activity facets from timestamps instead of labels", () => {
    const source = branchRows[0] as BranchRow;
    const at = (lastActivityAt: string, lastActivityLabel = "stale label") => ({
      ...source,
      lastActivityAt,
      lastActivityLabel,
    });

    expect(
      activityRange(at("2026-07-28T23:00:00.001Z"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBe(ActivityRange.LastHour);
    expect(
      activityRange(at("2026-07-28T23:00:00.000Z"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBe(ActivityRange.OneToSixHours);
    expect(
      activityRange(at("2026-07-28T17:00:00.000Z"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBe(ActivityRange.SevenToTwentyFourHours);
    expect(
      activityRange(at("2026-07-28T00:00:00.000Z"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBe(ActivityRange.OneDayPlus);
    expect(
      activityRange(at("not-a-date"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBeNull();
    expect(
      activityRange(at("2026-07-30T00:00:00.000Z"), BRANCH_METRIC_FIXTURE_NOW)
    ).toBeNull();
  });

  it("applies OR within a facet and AND across facets", () => {
    const filters = createDefaultBranchFilters();
    filters.statuses = [BranchStatus.Open, BranchStatus.Review];
    filters.owners = ["Sam Chen"];

    const result = filterBranchRows(
      branchRows,
      DateRange.ThirtyDays,
      filters,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(result.map((row) => row.id)).toEqual([
      "br_1281",
      "br_saml",
      "br_unpriced_sessions",
    ]);
  });

  it("builds a self-excluding facet population while applying other facets", () => {
    const filters = createDefaultBranchFilters();
    filters.statuses = [BranchStatus.Merged];
    filters.owners = ["Sam Chen"];

    const population = selfExcludingFacetRows(
      branchRows,
      DateRange.ThirtyDays,
      filters,
      BranchFilterFacet.Status,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(population.map((row) => row.id)).toEqual([
      "br_1281",
      "br_saml",
      "br_unpriced_sessions",
    ]);
  });

  it("keys linked pull requests to the canonical PR number", () => {
    const row = {
      ...(branchRows[0] as BranchRow),
      prNumber: 42,
      prUrl: null,
    };
    const filters = createDefaultBranchFilters();
    filters.pullRequests = [PullRequestPresence.Linked];

    expect(
      filterBranchRows([row], DateRange.All, filters, BRANCH_METRIC_FIXTURE_NOW)
    ).toEqual([row]);
  });

  it("excludes unavailable change totals only when a range is active", () => {
    const row = {
      ...(branchRows[0] as BranchRow),
      additions: null,
      deletions: 5,
    };
    const filters = createDefaultBranchFilters();

    expect(
      filterBranchRows([row], DateRange.All, filters, BRANCH_METRIC_FIXTURE_NOW)
    ).toEqual([row]);

    filters.changes = [ChangesRange.Under100];
    expect(
      filterBranchRows([row], DateRange.All, filters, BRANCH_METRIC_FIXTURE_NOW)
    ).toEqual([]);
  });
});

function withActivity(row: BranchRow, lastActivityAt: string): BranchRow {
  return { ...row, lastActivityAt };
}
