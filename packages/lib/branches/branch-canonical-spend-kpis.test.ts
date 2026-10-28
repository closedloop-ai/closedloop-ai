import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import { canonicalSpendKpis } from "./branch-canonical-spend-kpis";

function cards(spend: number | null, ratio: number | null) {
  const result = (value: number | null) => ({
    current:
      value === null
        ? { state: BranchMetricAvailability.Unavailable, value: null }
        : { state: BranchMetricAvailability.Complete, value },
  });
  return {
    aiSpendUsd: result(spend),
    locPerDollar: result(ratio),
  } as Pick<BranchListMetricBundle, "aiSpendUsd" | "locPerDollar">;
}

describe("canonicalSpendKpis", () => {
  it("publishes the cards' own spend and LOC per dollar", () => {
    const kpis = canonicalSpendKpis(cards(4.25, 13.56));

    expect(kpis.totalSpendUsd).toMatchObject({
      state: BranchKpiState.Available,
      value: 4.25,
    });
    expect(kpis.locPerDollar).toMatchObject({
      state: BranchKpiState.Available,
      value: 13.56,
    });
  });

  it("reports an unavailable card as unavailable, not zero", () => {
    const kpis = canonicalSpendKpis(cards(null, null));

    expect(kpis.totalSpendUsd).toMatchObject({
      state: BranchKpiState.Unavailable,
      value: null,
    });
    expect(kpis.locPerDollar).toMatchObject({
      state: BranchKpiState.Unavailable,
      value: null,
    });
  });

  it("keeps a measured zero spend unreportable (ISS-4737)", () => {
    expect(canonicalSpendKpis(cards(0, null)).totalSpendUsd.state).toBe(
      BranchKpiState.Unavailable
    );
  });

  it("carries no baseline, so a corpus figure never reads as a per-branch verdict", () => {
    const { totalSpendUsd } = canonicalSpendKpis(cards(1, 1));

    expect(totalSpendUsd.baseline30d).toBeNull();
    expect(totalSpendUsd.comparisonScope).toBeUndefined();
  });
});
