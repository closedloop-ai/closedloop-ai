import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { describe, expect, it } from "vitest";
import { resolveBranchesListPerDollar } from "../branches-list-per-dollar";

/**
 * ISS-11117 — the Branches listing's per-dollar arm.
 *
 * Every expectation below is an INDEPENDENT literal rather than a value
 * re-derived from `perDollarShortLabelFor` or from the bundle: a test that
 * rebuilds its expectation from the same helper the code reads passes for
 * whatever that helper returns, wrong values included.
 *
 * Label and figure are asserted TOGETHER in every case. Drift between them is
 * the exact failure this resolver exists to prevent, and either assertion alone
 * would stay green while the other went wrong.
 */
const LOC_LABEL = "LOC per $";

describe("ISS-11117 Branches listing per-dollar", () => {
  it("renders Pts / $ from the Pensero numerator when points resolve", () => {
    const resolved = resolveBranchesListPerDollar(
      bundle({
        canonicalLocPerDollar: {
          current: { state: BranchMetricAvailability.Complete, value: 42.5 },
        },
        penseroPointsPerDollar: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 12.34,
            disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
          },
        },
      }),
      { locLabel: LOC_LABEL }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Pensero);
    expect(resolved.label).toBe("Pts / $");
    expect(resolved.value.current.value).toBe(12.34);
    // ONE decimal — the provider's declared precision. Two would print a
    // measured 12.3 as 12.30 and claim a digit the feed never emitted.
    expect(resolved.format(12.34)).toBe("12.3 Pts/$");
    expect(resolved.caption).toBe("points delivered per dollar");
    expect(resolved.info.how).toContain("Pensero-scored interaction");
  });

  it("publishes a MEASURED zero as 0 Pts/$ rather than falling back", () => {
    // A cohort Pensero scored at nothing is a real measurement, and the LOC
    // ratio beside it is a different number — rendering LOC here would answer
    // a question nobody asked.
    const resolved = resolveBranchesListPerDollar(
      bundle({
        canonicalLocPerDollar: {
          current: { state: BranchMetricAvailability.Complete, value: 42.5 },
        },
        penseroPointsPerDollar: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 0,
            disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
          },
        },
      }),
      { locLabel: LOC_LABEL }
    );

    expect(resolved.label).toBe("Pts / $");
    expect(resolved.format(resolved.value.current.value ?? -1)).toBe("0 Pts/$");
  });

  it("renders LOC/$ unchanged, WITH its LOC label, when no numerator is sent", () => {
    // AC2. Asserted positively — a bare `not.toContain("Pts")` would be
    // satisfied by a card that rendered nothing at all.
    const resolved = resolveBranchesListPerDollar(
      bundle({
        canonicalLocPerDollar: {
          current: { state: BranchMetricAvailability.Complete, value: 42.5 },
        },
      }),
      { locLabel: LOC_LABEL }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Loc);
    expect(resolved.label).toBe(LOC_LABEL);
    expect(resolved.value.current.value).toBe(42.5);
    expect(resolved.format(42.5)).toBe("42.5 LOC/$");
    expect(resolved.format(12.345)).toBe("12.35 LOC/$");
    expect(resolved.caption).toBe("lines changed per dollar");
  });

  it("keeps LOC/$ when a Pensero field arrives UNPUBLISHABLE", () => {
    // Testing the object's truthiness is the bug this guards: a
    // `BranchListMetricValue` is an object, so an Unavailable one is truthy and
    // would swap a computable LOC ratio for an empty `Pts / $ —`.
    const resolved = resolveBranchesListPerDollar(
      bundle({
        canonicalLocPerDollar: {
          current: { state: BranchMetricAvailability.Complete, value: 42.5 },
        },
        penseroPointsPerDollar: {
          current: { state: BranchMetricAvailability.Unavailable, value: null },
        },
      }),
      { locLabel: LOC_LABEL }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Loc);
    expect(resolved.label).toBe(LOC_LABEL);
    expect(resolved.format(42.5)).toBe("42.5 LOC/$");
  });

  it("falls back to the pushed ratio for a producer predating both fields", () => {
    const resolved = resolveBranchesListPerDollar(
      bundle({
        pushedLocPerDollar: {
          current: { state: BranchMetricAvailability.Complete, value: 7 },
        },
      }),
      { locLabel: LOC_LABEL }
    );

    expect(resolved.label).toBe(LOC_LABEL);
    expect(resolved.value.current.value).toBe(7);
  });
});

function bundle(
  fields: Partial<BranchListMetricBundle>
): BranchListMetricBundle {
  return fields as BranchListMetricBundle;
}
