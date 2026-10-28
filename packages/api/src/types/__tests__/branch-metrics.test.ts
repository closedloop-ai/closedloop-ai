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

  /**
   * ISS-9097 item 2. The two entries used to read "deduplicated verified-push
   * OR merged-PR additions plus deletions", which names no single basis and so
   * cannot be squared with the merged-authored ruling at all. The producer picks
   * ONE lane per branch and discards the other
   * (`apps/api/app/branches/branch-publication-loc-projection.ts`), so the prose
   * has to say which lane wins and when the other is used.
   *
   * Pinned as literals, the way the labels below are: an expectation derived
   * from the dictionary would agree with whatever the dictionary later says.
   */
  it("pins the lane-selected publication numerator, not a union", () => {
    const listNumerator =
      BRANCH_METRIC_DICTIONARY[BranchMetricId.ListLocPerDollar].numerator;
    const detailNumerator =
      BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar].numerator;
    expect(listNumerator).toBe(
      "per branch, successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR"
    );
    expect(detailNumerator).toBe(
      "per branch, lifetime successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR"
    );
    for (const numerator of [listNumerator, detailNumerator]) {
      expect(numerator).not.toContain("verified-push or merged-PR");
    }
  });

  /**
   * Desktop renders these same strings, and its merged-PR change identity is
   * `repository#prNumber` — cloud's is the head SHA
   * (`apps/api/app/branches/branch-publication-loc-projection.ts:328` against
   * `apps/desktop/src/main/branch/branch-publication-loc-projection.ts:45`). A
   * numerator that spells either key is false on the other surface, which is
   * what "deduplicated by head" was.
   */
  it("names no surface-specific dedup key in the publication numerators", () => {
    for (const id of [
      BranchMetricId.ListLocPerDollar,
      BranchMetricId.DetailLocPerDollar,
      BranchMetricId.CanonicalLocPerDollar,
    ]) {
      const numerator = BRANCH_METRIC_DICTIONARY[id].numerator;
      expect(numerator).toContain("deduplicated by change identity");
      expect(numerator).not.toContain("by head");
      expect(numerator).not.toContain("PR number");
    }
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
      "vs prior 60d",
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
      "* Result uses verified publication LOC and all known qualifying Session cost; unavailable evidence is excluded."
    );
    expect(BranchMetricDisclosure.PrIncomplete).toBe(
      "* Calculated from merged PRs with known line counts. Some qualifying pull request sizes are unavailable."
    );
    expect(BranchMetricDisclosure.BranchesIncomplete).toBe(
      "* Calculated from part of the current selection. Some branches in this filter are not included in this figure."
    );
    expect(BranchMetricDisclosure.BranchesAndEvidenceIncomplete).toBe(
      "* Calculated from part of the current selection. Some branches in this filter are not included, and some qualifying values for those that are remain unavailable."
    );
    // ISS-9930, operator ruling 2026-09-17. Re-typed here like every sibling
    // above: copy the operator chose word for word is pinned AGAINST the
    // implementation, never derived from it.
    expect(BranchMetricDisclosure.PenseroAcquisitionIncomplete).toBe(
      "* Calculated from the Pensero delivery days collected so far. Earlier history is still being collected."
    );
    expect(BranchMetricDisclosure.PenseroAcquisitionDaysFailed).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, and earlier history is still being collected."
    );
    // ISS-10608, operator ruling 2026-09-17: the ambiguity clause sharpened and
    // the unreadable-value clause added, re-typed from the ticket.
    expect(BranchMetricDisclosure.PenseroAttributionAmbiguous).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some points belong to more than one branch, and earlier history is still being collected."
    );
    expect(BranchMetricDisclosure.PenseroPointValuesUnreadable).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some point values could not be read, and earlier history is still being collected."
    );
    expect(
      BranchMetricDisclosure.PenseroDaysFailedAndAttributionAmbiguous
    ).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some points belong to more than one branch, and earlier history is still being collected."
    );
    expect(
      BranchMetricDisclosure.PenseroDaysFailedAndPointValuesUnreadable
    ).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some point values could not be read, and earlier history is still being collected."
    );
    expect(
      BranchMetricDisclosure.PenseroAttributionAmbiguousAndPointValuesUnreadable
    ).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some points belong to more than one branch, some point values could not be read, and earlier history is still being collected."
    );
    expect(
      BranchMetricDisclosure.PenseroDaysFailedAttributionAmbiguousAndPointValuesUnreadable
    ).toBe(
      "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some points belong to more than one branch, some point values could not be read, and earlier history is still being collected."
    );
    expect(BRANCH_METRIC_DICTIONARY[BranchMetricId.AbandonmentTime]).toEqual(
      expect.objectContaining({
        applicability: "selected closed-unmerged PR cycle",
        numerator: "close time minus qualifying successful push anchor",
        population: "latest selected closed-unmerged PR cycle",
      })
    );
  });
});
