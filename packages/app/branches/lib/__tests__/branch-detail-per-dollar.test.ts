import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { describe, expect, it } from "vitest";
import {
  type BranchDetailPerDollarMetrics,
  resolveBranchDetailPerDollar,
} from "../branch-detail-per-dollar";

/**
 * ISS-9814 — which per-dollar metric the branch-detail card renders, and the
 * words it renders it under.
 *
 * Labels are pinned as INDEPENDENT literals. Re-deriving them from
 * `perDollarLabelFor` would make every case pass for whatever that function
 * currently returns, including a Pensero number labelled `LOC / $`.
 */
const LOC_CARD_LABEL = "LOC per $";
const LOC_CARD_UNIT = "LOC/$";
const PENSERO_CARD_LABEL = "Pensero pts / $";
const PENSERO_CARD_UNIT = "Pensero pts/$";

const LOC_RATIO = 5;
const POINTS_RATIO = 2;

describe("ISS-9814 branch-detail per-dollar selection", () => {
  it("AC2: with the flag OFF it renders LOC/$ even when Pensero data is present", () => {
    // Drives the OFF position against a payload that WOULD switch — a test that
    // only passed an empty payload here would stay green on a broken default.
    const presentation = resolveBranchDetailPerDollar(metricsWithPensero(), {
      penseroPointsEnabled: false,
      populationMatched: false,
    });

    expect(presentation.providerId).toBe(NumeratorProvider.Loc);
    expect(presentation.result?.value).toBe(LOC_RATIO);
    expect(presentation.label).toBe(LOC_CARD_LABEL);
    expect(presentation.unitLabel).toBe(LOC_CARD_UNIT);
  });

  it("AC2: the flag-OFF presentation is byte-identical with and without Pensero data", () => {
    const withData = resolveBranchDetailPerDollar(metricsWithPensero(), {
      penseroPointsEnabled: false,
      populationMatched: false,
    });
    const withoutData = resolveBranchDetailPerDollar(locOnlyMetrics(), {
      penseroPointsEnabled: false,
      populationMatched: false,
    });

    // Every string, not just the label: detail line, unavailable sentence and
    // both info sentences are part of "exactly as today".
    expect(withData).toEqual(withoutData);
  });

  it("AC1: with the flag ON and data present it renders Pensero points", () => {
    const presentation = resolveBranchDetailPerDollar(metricsWithPensero(), {
      penseroPointsEnabled: true,
      populationMatched: false,
    });

    expect(presentation.providerId).toBe(NumeratorProvider.Pensero);
    expect(presentation.result?.value).toBe(POINTS_RATIO);
    expect(presentation.label).toBe(PENSERO_CARD_LABEL);
    expect(presentation.unitLabel).toBe(PENSERO_CARD_UNIT);
  });

  it("AC3: a measured zero renders 0 under the Pensero label, not the LOC card", () => {
    const presentation = resolveBranchDetailPerDollar(
      { ...locOnlyMetrics(), penseroPointsPerDollar: complete(0) },
      { penseroPointsEnabled: true, populationMatched: false }
    );

    expect(presentation.result?.value).toBe(0);
    expect(presentation.result?.state).toBe(BranchMetricAvailability.Complete);
    // The zero must not have fallen through to the LOC arm, which would print
    // the LOC ratio under a LOC label and silently discard the measurement.
    expect(presentation.providerId).toBe(NumeratorProvider.Pensero);
    expect(presentation.label).toBe(PENSERO_CARD_LABEL);
  });

  it("an EMPTY delivery table reads as no Pensero data, never as 0 pts", () => {
    // Flag ON, org inside the rollout, but nothing backfilled: the producer
    // omits the field entirely. This is a DIFFERENT case from the measured zero
    // above and must not render a Pensero number of any kind.
    const presentation = resolveBranchDetailPerDollar(locOnlyMetrics(), {
      penseroPointsEnabled: true,
      populationMatched: false,
    });

    expect(presentation.providerId).toBe(NumeratorProvider.Loc);
    expect(presentation.result?.value).toBe(LOC_RATIO);
    expect(presentation.label).toBe(LOC_CARD_LABEL);
  });

  it("AC6: the label always names the numerator the value came from", () => {
    const cases = [
      { enabled: false, metrics: metricsWithPensero() },
      { enabled: true, metrics: metricsWithPensero() },
      { enabled: true, metrics: locOnlyMetrics() },
      {
        enabled: true,
        metrics: {
          ...locOnlyMetrics(),
          penseroPointsPerDollar: complete(0),
        },
      },
    ];

    for (const testCase of cases) {
      const presentation = resolveBranchDetailPerDollar(testCase.metrics, {
        penseroPointsEnabled: testCase.enabled,
        populationMatched: false,
      });
      const isPensero = presentation.providerId === NumeratorProvider.Pensero;
      // Neither direction may happen: no Pensero number under a LOC label, and
      // no LOC number under a pts label.
      expect(presentation.label).toBe(
        isPensero ? PENSERO_CARD_LABEL : LOC_CARD_LABEL
      );
      expect(presentation.unitLabel).toBe(
        isPensero ? PENSERO_CARD_UNIT : LOC_CARD_UNIT
      );
      expect(presentation.info.how.includes("Pensero")).toBe(isPensero);
      expect(presentation.detail.includes("Pensero")).toBe(isPensero);
    }
  });

  it("AC2: a REFUSED Pensero numerator falls back to LOC/$ rather than hiding it", () => {
    // A BranchMetricResult is an object, so `if (pensero)` is true even for
    // {state: Unavailable, value: null}. Selecting on truthiness swapped a
    // perfectly computable LOC/$ for an empty "Pensero pts / $ -" whenever a
    // branch's delivery evidence was refused.
    const presentation = resolveBranchDetailPerDollar(
      {
        ...locOnlyMetrics(),
        penseroPointsPerDollar: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
      },
      { penseroPointsEnabled: true, populationMatched: false }
    );

    expect(presentation.providerId).toBe(NumeratorProvider.Loc);
    expect(presentation.result?.value).toBe(LOC_RATIO);
    expect(presentation.label).toBe(LOC_CARD_LABEL);
  });

  it("ISS-9930 AC2: a PARTIAL Pensero result publishes, disclosure intact", () => {
    // The shipped selector took `Complete` and nothing else. Since the ruling
    // made Partial the only state a published Pensero result takes, that
    // selector would have silently swapped every Pensero number for the LOC
    // card — withholding it one layer above the kernel that stopped doing so.
    const partial: BranchMetricResult<number> = {
      state: BranchMetricAvailability.Partial,
      value: POINTS_RATIO,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
    };

    const presentation = resolveBranchDetailPerDollar(
      { ...locOnlyMetrics(), penseroPointsPerDollar: partial },
      { penseroPointsEnabled: true, populationMatched: false }
    );

    expect(presentation.providerId).toBe(NumeratorProvider.Pensero);
    expect(presentation.label).toBe(PENSERO_CARD_LABEL);
    // The whole result, not just the value: a selector that published the
    // number while dropping the disclosure would render an unstarred figure
    // claiming a completeness nothing can attest.
    expect(presentation.result).toEqual(partial);
  });

  it("AC6: precision travels with the unit — Pensero keeps the tenths LOC rounds away", () => {
    // The provider's feed emits tenths verbatim; LOC/$ rounds to whole numbers
    // above 10 because lines are whole. Formatting a Pensero ratio with LOC's
    // formatter printed a measured 25.5 as "26".
    const pensero = resolveBranchDetailPerDollar(
      { ...locOnlyMetrics(), penseroPointsPerDollar: complete(25.5) },
      { penseroPointsEnabled: true, populationMatched: false }
    );
    const loc = resolveBranchDetailPerDollar(locOnlyMetrics(), {
      penseroPointsEnabled: false,
      populationMatched: false,
    });

    expect(pensero.format(25.5)).toBe("25.5");
    // The LOC arm's rounding is unchanged — AC2 forbids drifting it.
    expect(loc.format(25.5)).toBe("26");
  });

  it("keeps the population-matched LOC companion selectable independently", () => {
    // The two keys are independent: turning the Pensero key on must not decide
    // the ISS-9732 question, and with Pensero absent that key still governs.
    const presentation = resolveBranchDetailPerDollar(
      { ...locOnlyMetrics(), populationMatchedLocPerDollar: complete(7) },
      { penseroPointsEnabled: true, populationMatched: true }
    );

    expect(presentation.providerId).toBe(NumeratorProvider.Loc);
    expect(presentation.result?.value).toBe(7);
  });
});

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

/** A producer with no Pensero numerator — the field is ABSENT, not null. */
function locOnlyMetrics(): BranchDetailPerDollarMetrics {
  return { locPerDollar: complete(LOC_RATIO) };
}

/** A producer carrying both ratios. */
function metricsWithPensero(): BranchDetailPerDollarMetrics {
  return {
    locPerDollar: complete(LOC_RATIO),
    penseroPointsPerDollar: complete(POINTS_RATIO),
  };
}
