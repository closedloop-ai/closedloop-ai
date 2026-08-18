import { describe, expect, it } from "vitest";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricEventTime,
  BranchMetricId,
  BranchMetricUnit,
} from "../branch-metrics";

describe("Branch metric dictionary", () => {
  it("defines every advertised metric exactly once", () => {
    expect(Object.keys(BRANCH_METRIC_DICTIONARY).sort()).toEqual(
      Object.values(BranchMetricId).sort()
    );
  });

  it("documents applicability, period behavior, and both formula time axes", () => {
    for (const definition of Object.values(BRANCH_METRIC_DICTIONARY)) {
      expect(definition.applicability.length).toBeGreaterThan(0);
      expect(definition.periodBehavior.length).toBeGreaterThan(0);
      expect(Object.values(BranchMetricEventTime)).toContain(
        definition.numeratorEventTime
      );
      if (definition.denominator !== null) {
        expect(definition.denominatorEventTime).not.toBeNull();
      }
    }
    expect(BRANCH_METRIC_DICTIONARY[BranchMetricId.MedianPrSize].unit).toBe(
      BranchMetricUnit.Lines
    );
  });

  it("pins Product's exact labels and incomplete disclosures", () => {
    expect(
      BRANCH_METRIC_DICTIONARY[BranchMetricId.ListLocPerDollar].label
    ).toBe("LOC per $");
    expect(
      BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar].label
    ).toBe("LOC per $");
    expect(Object.values(BranchMetricComparisonLabel)).toEqual([
      "WoW",
      "MoM",
      "QoQ",
      "all time",
    ]);
    expect(BranchMetricDisclosure.DefaultIncomplete).toBe(
      "* Calculated from available data. Some qualifying values are unavailable, so this number is incomplete."
    );
    expect(BranchMetricDisclosure.CostIncomplete).toBe(
      "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded."
    );
    expect(BranchMetricDisclosure.LocIncomplete).toBe(
      "* Only includes Branches with known line counts and qualifying cost."
    );
  });
});
