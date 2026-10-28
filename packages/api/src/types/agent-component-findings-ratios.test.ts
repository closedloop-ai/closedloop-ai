import { describe, expect, it } from "vitest";
import {
  type AgentComponentFindingsFunnelReading,
  AgentComponentFindingsFunnelState,
  readAgentComponentFindingsFunnel,
} from "./agent-component-findings-funnel.ts";
import {
  AgentComponentFindingsRatioOperand,
  AgentComponentFindingsRatioUnknownReason,
  agentComponentFindingsCarriedRate,
  agentComponentFindingsPrecision,
  agentComponentRefutedFindingWaste,
} from "./agent-component-findings-ratios.ts";
import {
  AGENT_COMPONENT_INVOCATION_MAX_COST,
  AgentComponentInvocationUsageMeasurement,
} from "./agent-component-invocation.ts";

const UNKNOWN_FUNNEL: AgentComponentFindingsFunnelReading = {
  state: AgentComponentFindingsFunnelState.Unknown,
};

function measured(
  findingsEmitted: number,
  findingsInvalidated: number
): AgentComponentFindingsFunnelReading {
  return readAgentComponentFindingsFunnel({
    findingsEmitted,
    findingsInvalidated,
  });
}

describe("agentComponentFindingsPrecision", () => {
  it("tells two components with the same confirmed count apart by their emitted population", () => {
    // The ticket's whole point: 3 confirmed out of 3 and 3 out of 30 are not
    // the same component, and a confirmed count alone cannot say so.
    const careful = agentComponentFindingsPrecision(measured(3, 0));
    const noisy = agentComponentFindingsPrecision(measured(30, 27));
    if (!(careful.known && noisy.known)) {
      throw new Error("both funnels are measured and must read known");
    }
    expect(careful.findingsConfirmed).toBe(noisy.findingsConfirmed);
    expect(careful.precision).toBe(1);
    expect(careful.falsePositiveRate).toBe(0);
    expect(noisy.precision).toBe(0.1);
    expect(noisy.falsePositiveRate).toBe(0.9);
    expect(noisy.findingsEmitted).toBe(30);
  });

  it("reads 0% precise, not unknown, when every emitted finding was refuted", () => {
    const result = agentComponentFindingsPrecision(measured(4, 4));
    if (!result.known) {
      throw new Error(
        "a fully refuted funnel is a measurement, not an absence"
      );
    }
    expect(result.precision).toBe(0);
    expect(result.falsePositiveRate).toBe(1);
  });

  it("reads unknown naming findingsEmitted with no funnel, and unknown with an empty one", () => {
    const absent = agentComponentFindingsPrecision(UNKNOWN_FUNNEL);
    expect(absent).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsEmitted,
    });
    expect(agentComponentFindingsPrecision(measured(0, 0))).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.NoEmittedFindings,
      absentOperand: null,
    });
  });
});

describe("agentComponentFindingsCarriedRate", () => {
  it("reads unknown naming findingsConfirmed when there is no funnel at all", () => {
    expect(agentComponentFindingsCarriedRate(UNKNOWN_FUNNEL, 2)).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsConfirmed,
    });
  });

  it("reads unknown naming findingsCarried when no producer supplies it", () => {
    expect(agentComponentFindingsCarriedRate(measured(10, 3))).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.CarriedNotProduced,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsCarried,
    });
  });

  it("computes carried over confirmed once an operand exists", () => {
    const result = agentComponentFindingsCarriedRate(measured(10, 2), 2);
    if (!result.known) {
      throw new Error("both operands are present");
    }
    expect(result.findingsConfirmed).toBe(8);
    expect(result.carriedRate).toBe(0.25);
    // Every confirmed finding carried is the boundary of the admissible range,
    // not past it: a rate of exactly 1 is a real answer.
    const all = agentComponentFindingsCarriedRate(measured(10, 2), 8);
    if (!all.known) {
      throw new Error("carried may equal confirmed");
    }
    expect(all.carriedRate).toBe(1);
  });

  it("refuses a carried count that cannot describe a real run", () => {
    const tooMany = agentComponentFindingsCarriedRate(measured(10, 2), 9);
    const fractional = agentComponentFindingsCarriedRate(measured(10, 2), 1.5);
    const negative = agentComponentFindingsCarriedRate(measured(10, 2), -1);
    const oversized = agentComponentFindingsCarriedRate(
      measured(10, 2),
      Number.MAX_SAFE_INTEGER + 1
    );
    const infinite = agentComponentFindingsCarriedRate(
      measured(10, 2),
      Number.POSITIVE_INFINITY
    );
    for (const result of [tooMany, fractional, negative, oversized, infinite]) {
      expect(result).toEqual({
        known: false,
        reason: AgentComponentFindingsRatioUnknownReason.CarriedInadmissible,
        absentOperand: AgentComponentFindingsRatioOperand.FindingsCarried,
      });
    }
  });

  it("reads unknown rather than dividing by zero confirmed findings", () => {
    expect(agentComponentFindingsCarriedRate(measured(4, 4), 0)).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.NoConfirmedFindings,
      absentOperand: null,
    });
  });
});

const MEASURED_SPEND = {
  estimatedCost: 2,
  measurement: AgentComponentInvocationUsageMeasurement.Measured,
} as const;
const ESTIMATED_SPEND = {
  estimatedCost: 5,
  measurement: AgentComponentInvocationUsageMeasurement.Estimated,
} as const;

/**
 * Every entry lands in exactly one bucket, so this sum IS the population — a
 * reader never has to recover a bucket by subtracting the others.
 */
function bucketedTotal(
  result: ReturnType<typeof agentComponentRefutedFindingWaste>
): number {
  return (
    (result.known ? result.reportingInvocations : 0) +
    result.invocationsWithUnknownFunnel +
    result.invocationsWithoutSpend +
    result.invocationsWithInadmissibleSpend
  );
}

describe("agentComponentRefutedFindingWaste", () => {
  it("names only a wholly refuted invocation as waste and bounds the rest separately", () => {
    const result = agentComponentRefutedFindingWaste([
      { funnel: measured(3, 3), spend: MEASURED_SPEND, fullyAdjudicated: true },
      {
        funnel: measured(10, 1),
        spend: { ...MEASURED_SPEND, estimatedCost: 7 },
        fullyAdjudicated: true,
      },
      {
        funnel: measured(2, 0),
        spend: { ...MEASURED_SPEND, estimatedCost: 9 },
        fullyAdjudicated: true,
      },
    ]);
    if (!result.known) {
      throw new Error("three invocations reported both operands");
    }
    expect(result.whollyRefutedInvocations).toBe(1);
    expect(result.whollyRefutedCostMeasured).toBe(2);
    expect(result.boundedWasteInvocations).toBe(1);
    expect(result.boundedWasteCostMeasured).toBe(7);
    expect(result.invocationsAwaitingVerdict).toBe(0);
    expect(result.reportingInvocations).toBe(3);
    expect(result.populationInvocations).toBe(3);
    expect(bucketedTotal(result)).toBe(result.populationInvocations);
  });

  it("refuses to settle an outstanding verdict in EITHER direction", () => {
    // Unadjudicated findings sit in neither stored count, so the first funnel
    // reads confirmed 0 while findings of its own may yet be confirmed — and
    // the mirror case, which has refuted nothing YET, is no more a measured $0
    // of waste than the first is wholly refuted. Both land on the bound.
    const result = agentComponentRefutedFindingWaste([
      {
        funnel: measured(3, 3),
        spend: MEASURED_SPEND,
        fullyAdjudicated: false,
      },
      {
        funnel: measured(4, 0),
        spend: { ...MEASURED_SPEND, estimatedCost: 6 },
        fullyAdjudicated: false,
      },
    ]);
    if (!result.known) {
      throw new Error("both invocations reported both operands");
    }
    expect(result.whollyRefutedInvocations).toBe(0);
    expect(result.whollyRefutedCostMeasured).toBe(0);
    expect(result.boundedWasteInvocations).toBe(2);
    expect(result.boundedWasteCostMeasured).toBe(8);
    expect(result.invocationsAwaitingVerdict).toBe(2);
    expect(bucketedTotal(result)).toBe(result.populationInvocations);
  });

  it("keeps measured and estimated spend in separate columns on both classifications", () => {
    const result = agentComponentRefutedFindingWaste([
      { funnel: measured(1, 1), spend: MEASURED_SPEND, fullyAdjudicated: true },
      {
        funnel: measured(1, 1),
        spend: ESTIMATED_SPEND,
        fullyAdjudicated: true,
      },
      {
        funnel: measured(9, 1),
        spend: { ...MEASURED_SPEND, estimatedCost: 3 },
        fullyAdjudicated: true,
      },
      {
        funnel: measured(9, 1),
        spend: ESTIMATED_SPEND,
        fullyAdjudicated: true,
      },
    ]);
    if (!result.known) {
      throw new Error("all four invocations reported both operands");
    }
    expect(result.whollyRefutedInvocations).toBe(2);
    expect(result.whollyRefutedCostMeasured).toBe(2);
    expect(result.whollyRefutedCostEstimated).toBe(5);
    expect(result.boundedWasteInvocations).toBe(2);
    expect(result.boundedWasteCostMeasured).toBe(3);
    expect(result.boundedWasteCostEstimated).toBe(5);
  });

  it("counts an absent, impossible or funnel-less entry instead of folding it in as zero dollars", () => {
    const result = agentComponentRefutedFindingWaste([
      { funnel: measured(1, 1), spend: MEASURED_SPEND, fullyAdjudicated: true },
      { funnel: measured(1, 1), fullyAdjudicated: true },
      {
        funnel: measured(1, 1),
        spend: { ...MEASURED_SPEND, estimatedCost: Number.NaN },
        fullyAdjudicated: true,
      },
      {
        funnel: measured(1, 1),
        spend: { ...MEASURED_SPEND, estimatedCost: -1 },
        fullyAdjudicated: true,
      },
      {
        funnel: measured(1, 1),
        spend: {
          ...MEASURED_SPEND,
          estimatedCost: AGENT_COMPONENT_INVOCATION_MAX_COST + 1,
        },
        fullyAdjudicated: true,
      },
      // Spend present, funnel missing: the entry that used to leave the fold
      // recoverable only by subtracting the other three from the population.
      { funnel: UNKNOWN_FUNNEL, spend: MEASURED_SPEND, fullyAdjudicated: true },
    ]);
    if (!result.known) {
      throw new Error("one invocation reported both operands");
    }
    expect(result.invocationsWithoutSpend).toBe(1);
    expect(result.invocationsWithInadmissibleSpend).toBe(3);
    expect(result.invocationsWithUnknownFunnel).toBe(1);
    expect(result.reportingInvocations).toBe(1);
    expect(result.whollyRefutedCostMeasured).toBe(2);
    expect(result.populationInvocations).toBe(6);
    expect(bucketedTotal(result)).toBe(result.populationInvocations);
  });

  it("reports a measured zero of waste when nothing was refuted", () => {
    const clean = agentComponentRefutedFindingWaste([
      { funnel: measured(4, 0), spend: MEASURED_SPEND, fullyAdjudicated: true },
    ]);
    if (!clean.known) {
      throw new Error("a run that refuted nothing has measured zero waste");
    }
    expect(clean.whollyRefutedCostMeasured).toBe(0);
    expect(clean.boundedWasteCostMeasured).toBe(0);
    expect(clean.reportingInvocations).toBe(1);
  });

  it("carries the shortfall counts into the unknown, so it is never a bare population", () => {
    expect(
      agentComponentRefutedFindingWaste([
        { funnel: measured(3, 3), fullyAdjudicated: true },
        {
          funnel: measured(3, 3),
          spend: { ...MEASURED_SPEND, estimatedCost: Number.NaN },
          fullyAdjudicated: true,
        },
      ])
    ).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.NoAttributedCost,
      absentOperand: AgentComponentFindingsRatioOperand.EstimatedCost,
      invocationsWithUnknownFunnel: 0,
      invocationsWithoutSpend: 1,
      invocationsWithInadmissibleSpend: 1,
      populationInvocations: 2,
    });
  });

  it("names the FUNNEL as the missing operand when no entry had one, cost or not", () => {
    // Every entry carried a real cost, so reporting "no attributed cost" would
    // send a reader after the wrong data gap entirely.
    expect(
      agentComponentRefutedFindingWaste([
        {
          funnel: UNKNOWN_FUNNEL,
          spend: MEASURED_SPEND,
          fullyAdjudicated: true,
        },
        {
          funnel: UNKNOWN_FUNNEL,
          spend: ESTIMATED_SPEND,
          fullyAdjudicated: true,
        },
      ])
    ).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsEmitted,
      invocationsWithUnknownFunnel: 2,
      invocationsWithoutSpend: 0,
      invocationsWithInadmissibleSpend: 0,
      populationInvocations: 2,
    });
  });

  it("reads unknown rather than rounding an aggregate past the safe-integer range", () => {
    // The column's maximum is ~1e14 once scaled to its six decimals, so a
    // little over ninety of them leave the safe-integer range. Ninety-one of
    // them is a real population, and a rounded total would render as a
    // confident measurement.
    const maxed = Array.from({ length: 91 }, () => ({
      funnel: measured(1, 1),
      spend: {
        estimatedCost: AGENT_COMPONENT_INVOCATION_MAX_COST,
        measurement: AgentComponentInvocationUsageMeasurement.Measured,
      },
      fullyAdjudicated: true,
    }));
    const result = agentComponentRefutedFindingWaste(maxed);
    expect(result.known).toBe(false);
    if (result.known) {
      throw new Error("the aggregate is not representable");
    }
    expect(result.reason).toBe(
      AgentComponentFindingsRatioUnknownReason.CostAccumulatorOverflow
    );
    expect(result.populationInvocations).toBe(91);
    // One fewer still reconciles exactly, so the guard is the aggregate's
    // range and not a blanket refusal of large populations.
    const representable = agentComponentRefutedFindingWaste(maxed.slice(0, 90));
    if (!representable.known) {
      throw new Error("ninety max-cost invocations are still representable");
    }
    expect(representable.whollyRefutedCostMeasured).toBe(
      AGENT_COMPONENT_INVOCATION_MAX_COST * 90
    );
  });
});

describe("the ratio discriminators a surface renders", () => {
  it("pins the wire spelling of every reason and operand", () => {
    // Deliberately non-circular: built from literals, not from the const under
    // test, so deleting or renaming a member reddens this rather than agreeing
    // with the change.
    expect(AgentComponentFindingsRatioUnknownReason).toEqual({
      FunnelUnknown: "funnel_unknown",
      NoEmittedFindings: "no_emitted_findings",
      NoConfirmedFindings: "no_confirmed_findings",
      CarriedNotProduced: "carried_not_produced",
      CarriedInadmissible: "carried_inadmissible",
      NoAttributedCost: "no_attributed_cost",
      CostAccumulatorOverflow: "cost_accumulator_overflow",
    });
    expect(AgentComponentFindingsRatioOperand).toEqual({
      FindingsEmitted: "findingsEmitted",
      FindingsConfirmed: "findingsConfirmed",
      FindingsCarried: "findingsCarried",
      EstimatedCost: "estimatedCost",
    });
  });
});
