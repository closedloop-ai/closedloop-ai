/**
 * ISS-9097 item 1 — the registry READS its owners; it does not re-type them.
 *
 * An identity assertion cannot tell the two apart: a registry that imported
 * `"LOC per $"` and one that typed it out hold the same string, so
 * `toBe(BRANCH_METRIC_DICTIONARY[…].label)` passes either way. Each owner is
 * replaced here with a sentinel no surface could have hardcoded, and the
 * registry is then asked what it holds — the technique
 * `packages/app/shared/lib/__tests__/metric-label-record-wiring.test.ts` uses
 * on the label records.
 *
 * Its own file because `vi.mock` is hoisted per module: the sibling
 * `loc-metric-definitions.test.ts` has to see the real strings.
 */
import { describe, expect, it, vi } from "vitest";

const MERGED_LABEL_SENTINEL = "iss9097-merged-label";
const PUSHED_LABEL_SENTINEL = "iss9097-pushed-label";
const SHIPPED_LABEL_SENTINEL = "iss9097-shipped-label";
const UNIT_SENTINEL = "iss9097-unit";

vi.mock("../branch-metrics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch-metrics.ts")>();
  return {
    ...actual,
    BRANCH_METRIC_DICTIONARY: Object.fromEntries(
      Object.entries(actual.BRANCH_METRIC_DICTIONARY).map(
        ([id, definition]) => [
          id,
          {
            ...definition,
            label: `${id}-label`,
            numerator: `${id}-numerator`,
            denominator: `${id}-denominator`,
            population: `${id}-population`,
          },
        ]
      )
    ),
  };
});

vi.mock("../../utils/loc-per-dollar.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/loc-per-dollar.ts")>();
  return {
    ...actual,
    LOC_PER_DOLLAR_LABEL: SHIPPED_LABEL_SENTINEL,
    MERGED_LOC_PER_DOLLAR_LABEL: MERGED_LABEL_SENTINEL,
    PUSHED_LOC_PER_DOLLAR_LABEL: PUSHED_LABEL_SENTINEL,
  };
});

vi.mock("../numerator-provider.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../numerator-provider.ts")>();
  return { ...actual, perDollarUnitLabelFor: () => UNIT_SENTINEL };
});

describe("ISS-9097 the registry is a join, not a fifth spelling", () => {
  it("reads both Sessions entries' labels off the label owner", async () => {
    const { LOC_METRIC_DEFINITION, LocMetricDefinitionId } = await import(
      "../loc-metric-definitions.ts"
    );
    for (const id of [
      LocMetricDefinitionId.SessionMergedLoc,
      LocMetricDefinitionId.SessionDetailMergedLoc,
    ]) {
      expect(LOC_METRIC_DEFINITION[id].label).toBe(SHIPPED_LABEL_SENTINEL);
      expect(LOC_METRIC_DEFINITION[id].canonicalLabel).toBe(
        MERGED_LABEL_SENTINEL
      );
    }
  });

  /**
   * Per-DICTIONARY-ROW sentinels, not one shared stub. A single stub spread over
   * every row proves only "read from the dictionary" and stays green when an
   * entry is re-pointed at a sibling row — which would publish the Branches LIST
   * definition as the branch-LIFETIME formula. The expected row for each member
   * is written out here rather than read back from the registry.
   */
  it("reads each Branch formula off its OWN dictionary row", async () => {
    const { LOC_METRIC_DEFINITION, LocMetricDefinitionId } = await import(
      "../loc-metric-definitions.ts"
    );
    const rowFor: Record<string, string> = {
      [LocMetricDefinitionId.BranchListPublicationLoc]: "list_loc_per_dollar",
      [LocMetricDefinitionId.BranchDetailPublicationLoc]:
        "detail_loc_per_dollar",
      [LocMetricDefinitionId.BranchCanonicalPublicationLoc]:
        "canonical_loc_per_dollar",
      [LocMetricDefinitionId.BranchPushedLoc]: "pushed_loc_per_dollar",
    };
    for (const [definitionId, row] of Object.entries(rowFor)) {
      const definition =
        LOC_METRIC_DEFINITION[
          definitionId as keyof typeof LOC_METRIC_DEFINITION
        ];
      expect(definition.label).toBe(`${row}-label`);
      expect(definition.numerator).toBe(`${row}-numerator`);
      expect(definition.denominator).toBe(`${row}-denominator`);
      expect(definition.population).toBe(`${row}-population`);
    }
  });

  it("reads the three publication ratios' canonical phrase off the label owner", async () => {
    const { LOC_METRIC_DEFINITION, LocMetricDefinitionId } = await import(
      "../loc-metric-definitions.ts"
    );
    for (const id of [
      LocMetricDefinitionId.BranchListPublicationLoc,
      LocMetricDefinitionId.BranchDetailPublicationLoc,
      LocMetricDefinitionId.BranchCanonicalPublicationLoc,
    ]) {
      expect(LOC_METRIC_DEFINITION[id].canonicalLabel).toBe(
        PUSHED_LABEL_SENTINEL
      );
    }
  });

  it("reads the compact unit off the numerator-provider owner", async () => {
    const { LOC_METRIC_DEFINITION, LocMetricDefinitionId } = await import(
      "../loc-metric-definitions.ts"
    );
    expect(
      LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionMergedLoc].unitLabel
    ).toBe(UNIT_SENTINEL);
  });
});
