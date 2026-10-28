/**
 * ISS-10667 — the four canonical labels, and the spellings ruling 7 retired.
 *
 * The expectations are INDEPENDENT literals, not reads of the constants they
 * police: a fixture built from the record it guards agrees with that record
 * whatever it says, so a rename or a case slip would stay green.
 *
 * The SETS are derived from `canonical-metric-vocabulary.ts`, whose two maps
 * are exhaustive `Record`s over `CanonicalMetric` — a fifth metric cannot reach
 * a surface without failing `tsc` there, and the literals below then fail here
 * (marisolashgrove review). What that still cannot see is an alias constant
 * declared beside its canonical phrase and never joined to the union.
 *
 * Ruling 6 (sentence case) is the one these are most likely to lose: DOC-27
 * writes both phrases in title case, so a future edit "correcting" the code to
 * the spec has to fail here first.
 */
import {
  CANONICAL_METRIC_ALIAS_LABEL,
  CANONICAL_METRIC_LABEL,
  CanonicalMetric,
} from "@repo/api/src/types/canonical-metric-vocabulary";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { describe, expect, it } from "vitest";

describe("ISS-10667 the canonical vocabulary", () => {
  it("spells the dollar figure in sentence case", () => {
    expect(CANONICAL_METRIC_LABEL[CanonicalMetric.TotalEstimatedCost]).toBe(
      "Total estimated cost"
    );
  });

  it("spells the token total in sentence case", () => {
    expect(CANONICAL_METRIC_LABEL[CanonicalMetric.TotalTokens]).toBe(
      "Total tokens"
    );
  });

  it("leads the ratio with its basis", () => {
    expect(CANONICAL_METRIC_LABEL[CanonicalMetric.MergedLocPerDollar]).toBe(
      "Merged LOC per $"
    );
    expect(CANONICAL_METRIC_LABEL[CanonicalMetric.PushedLocPerDollar]).toBe(
      "Pushed LOC per $"
    );
  });

  it("governs these metrics and no others", () => {
    expect([...Object.values(CanonicalMetric)].sort()).toEqual([
      "merged_loc_per_dollar",
      "pushed_loc_per_dollar",
      "total_estimated_cost",
      "total_tokens",
    ]);
  });

  it("authorizes one short form per governed metric and no other spelling", () => {
    expect(
      [...new Set(Object.values(CANONICAL_METRIC_ALIAS_LABEL))].sort()
    ).toEqual(["Cost", "LOC per $", "Tokens"]);
  });

  it("gives both ratio bases the same short form", () => {
    // The alias drops the basis R4a put first, so the two bases cannot be told
    // apart by it — which is why a surface showing both may not use it.
    expect(
      CANONICAL_METRIC_ALIAS_LABEL[CanonicalMetric.MergedLocPerDollar]
    ).toBe(CANONICAL_METRIC_ALIAS_LABEL[CanonicalMetric.PushedLocPerDollar]);
  });

  it("keeps each alias shorter than the phrase it stands in for", () => {
    // The alias exists for width. One that is not shorter has no reason to.
    for (const metric of Object.values(CanonicalMetric)) {
      expect(CANONICAL_METRIC_ALIAS_LABEL[metric].length).toBeLessThan(
        CANONICAL_METRIC_LABEL[metric].length
      );
    }
  });

  it("pins the one flag key the vocabulary is gated by", () => {
    expect(ONE_LABEL_PER_METRIC_FLAG_KEY).toBe("one-label-per-metric");
  });
});
