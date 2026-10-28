/**
 * ISS-7797 — the RATIOS. These are quotients, not measurements: each divides a
 * number the ISS-7796 funnel produces by another the funnel or the ISS-7795
 * cost capture produces. Both operands sit at the `agent_component_invocations`
 * grain, which is the whole reason they divide (PRD-753 R8).
 *
 * PRECISION IS NOT THE ONLY RATE, AND THE FALSE-POSITIVE RATE IS NOT A
 * CORRECTION TO IT. Two components with identical confirmed counts are not
 * equivalent if one emitted three candidates and the other thirty: the second
 * burned ten times the tokens and will burn a reviewer's attention too. So
 * {@link agentComponentFindingsPrecision} returns the false-positive rate as a
 * named value beside the precision and carries `findingsEmitted` with both —
 * a confirmed count quoted without the population it came out of is exactly
 * the comparison ISS-6360 warns is gameable.
 *
 * AN UNADJUDICATED FINDING IS NOT A REFUTED ONE, AND IT IS NOT A ZERO EITHER.
 * A finding awaiting a verdict is in NEITHER stored count (ISS-10724), so it
 * can neither inflate the false-positive rate's denominator nor be booked as
 * waste. The waste fold below therefore refuses to settle an invocation with an
 * outstanding verdict in EITHER direction: it is not wholly refuted, and it is
 * not a measured $0 of waste either, because the verdict that has not arrived
 * could go either way. Both cases land on the explicit upper bound instead.
 *
 * UNKNOWN IS NEVER ZERO, AND NEVER A SILENT BLANK (PRD-753 R1/R9). Every
 * unknown reading below carries a {@link AgentComponentFindingsRatioUnknownReason}
 * and, where one operand is genuinely missing, names it in `absentOperand` so a
 * surface can say WHICH half it does not have where the value would have
 * rendered. A zero denominator is unknown — not 0%, and not a throw.
 *
 * `carried ÷ confirmed` HAS NO PRODUCER TODAY, AND IS SHIPPED ANYWAY.
 * ISS-7796 retired the third funnel stage: `findingsCarried` is not stored, and
 * no ticket in the current decomposition emits it. The ratio is defined here
 * regardless, because the capability is the product and a slot that was never
 * built is invisible forever. With no operand it reads unknown naming
 * `findingsCarried`; the moment a producer exists it is passed in and the same
 * function answers. See {@link agentComponentFindingsCarriedRate}.
 *
 * NO DOLLARS PER FINDING (PRD-753 R3/R8). The tokens a single finding cost are
 * not separable from the rest of the invocation's turn. That is why
 * {@link agentComponentRefutedFindingWaste} is defined at the INVOCATION grain —
 * the spend of an invocation whose every adjudicated finding was refuted is
 * nameable; a share of an invocation's spend attributed to three of its ten
 * findings is not. An invocation that was only PARTIALLY refuted is counted and
 * its spend reported as an explicit upper bound, never as waste.
 *
 * MEASURED AND ESTIMATED SPEND ARE NOT SUMMED. ISS-7795 labels how a cost was
 * arrived at precisely so a reader never sees a bracketed count and a share of
 * a session average in one undifferentiated column, so the waste result reports
 * the two populations side by side and folds neither into the other.
 *
 * DOLLARS ARE ACCUMULATED IN EXACT SCALED UNITS, NOT IN FLOATS. The column's
 * six-decimal scale puts its maximum single value near 1e14 scaled, so a little
 * over ninety of them leave the safe-integer range; past that a total is
 * already rounded and quoting it would be a fabricated measurement. Each arm
 * therefore sums integer units and the whole result reads unknown when one of
 * them overflows, the same call ISS-7801 made on its own aggregate.
 */

import { z } from "zod";
import {
  type AgentComponentFindingsFunnelReading,
  AgentComponentFindingsFunnelState,
} from "./agent-component-findings-funnel.ts";
import {
  AGENT_COMPONENT_INVOCATION_COST_FACTOR,
  AgentComponentInvocationUsageMeasurement,
  canonicalAgentComponentInvocationCost,
  isCanonicalAgentComponentInvocationCost,
} from "./agent-component-invocation.ts";

/**
 * The operand a ratio could not get. Spelled exactly as the field it names, so
 * a surface rendering "no <operand>" is naming something the reader can find.
 */
export const AgentComponentFindingsRatioOperand = {
  FindingsEmitted: "findingsEmitted",
  FindingsConfirmed: "findingsConfirmed",
  FindingsCarried: "findingsCarried",
  EstimatedCost: "estimatedCost",
} as const;
export type AgentComponentFindingsRatioOperand =
  (typeof AgentComponentFindingsRatioOperand)[keyof typeof AgentComponentFindingsRatioOperand];

export const AgentComponentFindingsRatioUnknownReason = {
  /** No funnel was ingested for this invocation. NOT a zero. */
  FunnelUnknown: "funnel_unknown",
  /** The funnel is measured and reports no adjudicated finding at all. */
  NoEmittedFindings: "no_emitted_findings",
  /** Measured, and every emitted finding was refuted: the denominator is 0. */
  NoConfirmedFindings: "no_confirmed_findings",
  /** No producer in the current decomposition emits `findingsCarried`. */
  CarriedNotProduced: "carried_not_produced",
  /** A supplied `findingsCarried` cannot describe a real run. */
  CarriedInadmissible: "carried_inadmissible",
  /** No invocation in the population carried both a funnel and a usable cost. */
  NoAttributedCost: "no_attributed_cost",
  /** Costs were present and their total left the safe-integer range. */
  CostAccumulatorOverflow: "cost_accumulator_overflow",
} as const;
export type AgentComponentFindingsRatioUnknownReason =
  (typeof AgentComponentFindingsRatioUnknownReason)[keyof typeof AgentComponentFindingsRatioUnknownReason];

/** The shape every unknown reading shares: why, and which operand is missing. */
export type AgentComponentFindingsRatioUnknown = {
  known: false;
  reason: AgentComponentFindingsRatioUnknownReason;
  /** `null` when both operands are present and the quotient is simply undefined. */
  absentOperand: AgentComponentFindingsRatioOperand | null;
};

/**
 * Precision and its inseparable twin, measured over one component's funnel.
 *
 * `precision` and `falsePositiveRate` are each computed from the stored integer
 * pair rather than one from the other, so neither inherits the other's floating
 * point error; they sum to 1 in exact arithmetic by construction.
 */
export type AgentComponentFindingsPrecision =
  | AgentComponentFindingsRatioUnknown
  | {
      known: true;
      /** 0..1, `confirmed ÷ emitted`. Multiply at the render. */
      precision: number;
      /** 0..1, `invalidated ÷ emitted`. A first-class rate, not a residual. */
      falsePositiveRate: number;
      findingsEmitted: number;
      findingsConfirmed: number;
      findingsInvalidated: number;
    };

/** Did confirmation actually mean anything: `carried ÷ confirmed`. */
export type AgentComponentFindingsCarriedRate =
  | AgentComponentFindingsRatioUnknown
  | {
      known: true;
      /** 0..1, `carried ÷ confirmed`. */
      carriedRate: number;
      findingsCarried: number;
      findingsConfirmed: number;
    };

/**
 * One invocation's spend, with ISS-7795's label on how it was arrived at.
 *
 * `estimatedCost` IS THE PERSISTED VALUE, VERBATIM. It is held to the same
 * predicate the invocation ingest boundary applies, which includes being
 * already at the column's six-decimal scale — so a value this module refuses is
 * exactly a value that could not have been stored on the row it claims to
 * describe. A caller must hand over the number it read, never a figure it
 * derived: an apportioned or averaged estimate that happens to carry a seventh
 * decimal place is not corrupt data, but this module cannot tell the two apart,
 * so it would be counted as though it were. Canonicalize at the producer that
 * owns the derivation, where the rounding is a decision rather than a guess.
 */
export type AgentComponentInvocationSpend = {
  estimatedCost: number;
  measurement: AgentComponentInvocationUsageMeasurement;
};

/** One invocation considered by the waste fold: its funnel and its spend. */
export type AgentComponentRefutedFindingWasteEntry = {
  funnel: AgentComponentFindingsFunnelReading;
  /** Omitted — never `null` and never `0` — when no cost was captured. */
  spend?: AgentComponentInvocationSpend;
  /**
   * False when this invocation left a finding awaiting a verdict.
   *
   * REQUIRED, because there is no safe default. An unadjudicated finding is in
   * NEITHER stored count (ISS-10724), so an invocation with 3 emitted, 3
   * invalidated and 5 outstanding reads `confirmed === 0` while five of its
   * findings may still be confirmed. Defaulting an omitted answer to `true`
   * would book that invocation's whole turn as wholly refuted on the strength
   * of a caveat its producer never reported — a plausible-but-wrong number.
   * Defaulting it to `false` would caveat invocations that have nothing
   * outstanding. A producer that has not computed the answer cannot call this
   * function; one that has says so here.
   */
  fullyAdjudicated: boolean;
};

/**
 * The shortfall counts both arms carry, so an unknown is never a bare count.
 *
 * THESE RECONCILE EXACTLY. `populationInvocations` equals `reportingInvocations`
 * plus the three shortfall counters below, so a reader never has to recover a
 * bucket by subtraction and no entry can fall out of the fold unnamed.
 */
export type AgentComponentRefutedFindingWasteShortfall = {
  /** No funnel ingested. Named separately: a missing funnel is not a missing cost. */
  invocationsWithUnknownFunnel: number;
  /** Measured funnel, no spend captured. Named, never folded in as $0. */
  invocationsWithoutSpend: number;
  /** Measured funnel, spend present and impossible. Counted, never used. */
  invocationsWithInadmissibleSpend: number;
  /** Everything looked at, reporting or not (PRD-753 R2). */
  populationInvocations: number;
};

/**
 * Token waste at the invocation grain, in dollars.
 *
 * `whollyRefuted*` IS the waste: the invocation reached a verdict on every
 * finding it produced and every one of them was refuted, so its whole turn
 * bought nothing.
 *
 * `boundedWaste*` IS NOT WASTE and must never be rendered as though it were. It
 * is the FULL spend of invocations that cannot be settled either way — because
 * they refuted something and also confirmed something, or because a finding of
 * theirs is still awaiting a verdict — which makes it an upper bound on any
 * further waste. The true figure would need a per-finding cost, which does not
 * exist (R3): the shortfall here BIASES rather than narrows, so the
 * apportionment is withheld and the counts and the bound are published in its
 * place rather than a blank. `invocationsAwaitingVerdict` says how many of them
 * are the outstanding-verdict case, so the caveat is attributable to these
 * dollars rather than to the whole run set.
 */
export type AgentComponentRefutedFindingWaste =
  | (AgentComponentFindingsRatioUnknown &
      AgentComponentRefutedFindingWasteShortfall)
  | ({
      known: true;
      whollyRefutedInvocations: number;
      whollyRefutedCostMeasured: number;
      whollyRefutedCostEstimated: number;
      boundedWasteInvocations: number;
      /** Upper bound on further waste, NOT waste. See the type docstring. */
      boundedWasteCostMeasured: number;
      /** Upper bound on further waste, NOT waste. See the type docstring. */
      boundedWasteCostEstimated: number;
      /** Of `boundedWasteInvocations`, how many are still awaiting a verdict. */
      invocationsAwaitingVerdict: number;
      /** Invocations contributing to the figures above. */
      reportingInvocations: number;
    } & AgentComponentRefutedFindingWasteShortfall);

/** The Measured arm of a reading, so a settlement helper needs no re-narrowing. */
type AgentComponentFindingsFunnelMeasured = Extract<
  AgentComponentFindingsFunnelReading,
  { state: typeof AgentComponentFindingsFunnelState.Measured }
>;

function unknown(
  reason: AgentComponentFindingsRatioUnknownReason,
  absentOperand: AgentComponentFindingsRatioOperand | null
): AgentComponentFindingsRatioUnknown {
  return { known: false, reason, absentOperand };
}

/**
 * A finding count this module accepts. The impossible set is wider than
 * "negative": a fractional count, a non-finite one and a magnitude past the
 * safe-integer range all render as confident real measurements.
 */
const findingsCarriedSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

/**
 * A spend this module will sum. Deliberately the SAME predicate the invocation
 * ingest boundary applies rather than a restatement of its clauses, so a value
 * this module refuses is exactly a value that could not have been stored on the
 * row it claims to describe — finite, non-negative, within the column's range,
 * and already at its persisted scale.
 */
function isAdmissibleSpend(value: unknown): value is number {
  return (
    typeof value === "number" && isCanonicalAgentComponentInvocationCost(value)
  );
}

/**
 * `confirmed ÷ emitted` and `invalidated ÷ emitted` for one component, each
 * carrying the population it was measured over (PRD-753 R2).
 *
 * A component with no ingested funnel is unknown naming `findingsEmitted`; a
 * measured funnel with nothing adjudicated is unknown too, because 0 emitted
 * findings has no precision — it is not 0% precise and not 100%.
 */
export function agentComponentFindingsPrecision(
  reading: AgentComponentFindingsFunnelReading
): AgentComponentFindingsPrecision {
  if (reading.state !== AgentComponentFindingsFunnelState.Measured) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
      AgentComponentFindingsRatioOperand.FindingsEmitted
    );
  }
  if (reading.findingsEmitted === 0) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.NoEmittedFindings,
      null
    );
  }
  return {
    known: true,
    precision: reading.findingsConfirmed / reading.findingsEmitted,
    falsePositiveRate: reading.findingsInvalidated / reading.findingsEmitted,
    findingsEmitted: reading.findingsEmitted,
    findingsConfirmed: reading.findingsConfirmed,
    findingsInvalidated: reading.findingsInvalidated,
  };
}

/**
 * `carried ÷ confirmed` — whether confirming a finding actually changed
 * anything.
 *
 * `findingsCarried` is the retired third funnel stage (ISS-7796). Nothing in
 * the current decomposition produces it, so the normal answer today is unknown
 * naming that operand — which is the honest reading, not a missing feature.
 * Pass a count and the ratio computes; the operand is validated first, and a
 * `carried` greater than `confirmed` is impossible rather than clamped, because
 * a finding cannot have led to a change without having been confirmed.
 */
export function agentComponentFindingsCarriedRate(
  reading: AgentComponentFindingsFunnelReading,
  findingsCarried?: number
): AgentComponentFindingsCarriedRate {
  if (reading.state !== AgentComponentFindingsFunnelState.Measured) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
      AgentComponentFindingsRatioOperand.FindingsConfirmed
    );
  }
  if (findingsCarried === undefined) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.CarriedNotProduced,
      AgentComponentFindingsRatioOperand.FindingsCarried
    );
  }
  if (
    !findingsCarriedSchema.safeParse(findingsCarried).success ||
    findingsCarried > reading.findingsConfirmed
  ) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.CarriedInadmissible,
      AgentComponentFindingsRatioOperand.FindingsCarried
    );
  }
  if (reading.findingsConfirmed === 0) {
    return unknown(
      AgentComponentFindingsRatioUnknownReason.NoConfirmedFindings,
      null
    );
  }
  return {
    known: true,
    carriedRate: findingsCarried / reading.findingsConfirmed,
    findingsCarried,
    findingsConfirmed: reading.findingsConfirmed,
  };
}

/** Dollar arms are accumulated as exact integer units of the persisted scale. */
type WasteAccumulator = {
  whollyRefutedInvocations: number;
  whollyRefutedUnitsMeasured: number;
  whollyRefutedUnitsEstimated: number;
  boundedWasteInvocations: number;
  boundedWasteUnitsMeasured: number;
  boundedWasteUnitsEstimated: number;
  invocationsAwaitingVerdict: number;
  invocationsWithUnknownFunnel: number;
  invocationsWithoutSpend: number;
  invocationsWithInadmissibleSpend: number;
  reportingInvocations: number;
};

function emptyWaste(): WasteAccumulator {
  return {
    whollyRefutedInvocations: 0,
    whollyRefutedUnitsMeasured: 0,
    whollyRefutedUnitsEstimated: 0,
    boundedWasteInvocations: 0,
    boundedWasteUnitsMeasured: 0,
    boundedWasteUnitsEstimated: 0,
    invocationsAwaitingVerdict: 0,
    invocationsWithUnknownFunnel: 0,
    invocationsWithoutSpend: 0,
    invocationsWithInadmissibleSpend: 0,
    reportingInvocations: 0,
  };
}

/** A canonical cost times the scale factor is exact, so this never rounds away a cent. */
function costUnits(estimatedCost: number): number {
  return Math.round(estimatedCost * AGENT_COMPONENT_INVOCATION_COST_FACTOR);
}

function addSpend(
  accumulator: WasteAccumulator,
  spend: AgentComponentInvocationSpend,
  wholly: boolean
): void {
  const estimated =
    spend.measurement === AgentComponentInvocationUsageMeasurement.Estimated;
  const units = costUnits(spend.estimatedCost);
  if (wholly) {
    accumulator.whollyRefutedInvocations += 1;
    if (estimated) {
      accumulator.whollyRefutedUnitsEstimated += units;
      return;
    }
    accumulator.whollyRefutedUnitsMeasured += units;
    return;
  }
  accumulator.boundedWasteInvocations += 1;
  if (estimated) {
    accumulator.boundedWasteUnitsEstimated += units;
    return;
  }
  accumulator.boundedWasteUnitsMeasured += units;
}

/**
 * Whether an invocation's whole turn can be settled, and if so which way.
 *
 * An outstanding verdict disqualifies BOTH settlements symmetrically: an
 * invocation with findings still pending is not wholly refuted (a pending
 * finding may yet be confirmed) and is equally not a measured $0 of waste (a
 * pending finding may yet be refuted). Either way its full spend is the bound.
 */
function classifySettlement(
  funnel: AgentComponentFindingsFunnelMeasured,
  fullyAdjudicated: boolean
): { contributes: boolean; wholly: boolean } {
  if (!fullyAdjudicated) {
    return { contributes: true, wholly: false };
  }
  if (funnel.findingsInvalidated === 0) {
    return { contributes: false, wholly: false };
  }
  return { contributes: true, wholly: funnel.findingsConfirmed === 0 };
}

function unitsOverflowed(accumulator: WasteAccumulator): boolean {
  return ![
    accumulator.whollyRefutedUnitsMeasured,
    accumulator.whollyRefutedUnitsEstimated,
    accumulator.boundedWasteUnitsMeasured,
    accumulator.boundedWasteUnitsEstimated,
  ].every(Number.isSafeInteger);
}

function dollars(units: number): number {
  return canonicalAgentComponentInvocationCost(
    units / AGENT_COMPONENT_INVOCATION_COST_FACTOR
  );
}

/**
 * Tokens spent on findings that were later refuted, summed in dollars over a
 * population of invocations.
 *
 * An invocation contributes only when it has a measured funnel AND a usable
 * spend; the ones that fall short are COUNTED (`invocationsWithUnknownFunnel`,
 * `invocationsWithoutSpend`, `invocationsWithInadmissibleSpend`) rather than
 * treated as $0, and the whole population is reported beside the figure. When
 * no invocation reports at all the result is unknown naming the operand that
 * was actually missing — `findingsEmitted` when not one entry had a funnel,
 * `estimatedCost` otherwise — never $0.00.
 */
export function agentComponentRefutedFindingWaste(
  entries: readonly AgentComponentRefutedFindingWasteEntry[]
): AgentComponentRefutedFindingWaste {
  const accumulator = emptyWaste();
  for (const entry of entries) {
    if (entry.funnel.state !== AgentComponentFindingsFunnelState.Measured) {
      accumulator.invocationsWithUnknownFunnel += 1;
      continue;
    }
    const spend = entry.spend;
    if (spend === undefined) {
      accumulator.invocationsWithoutSpend += 1;
      continue;
    }
    if (!isAdmissibleSpend(spend.estimatedCost)) {
      accumulator.invocationsWithInadmissibleSpend += 1;
      continue;
    }
    // Counted before the settlement test: an invocation that refuted nothing
    // and has nothing outstanding is a measured $0 of waste, not an invocation
    // we failed to measure.
    accumulator.reportingInvocations += 1;
    const { contributes, wholly } = classifySettlement(
      entry.funnel,
      entry.fullyAdjudicated
    );
    if (!contributes) {
      continue;
    }
    if (!entry.fullyAdjudicated) {
      accumulator.invocationsAwaitingVerdict += 1;
    }
    addSpend(accumulator, spend, wholly);
  }
  const shortfall: AgentComponentRefutedFindingWasteShortfall = {
    invocationsWithUnknownFunnel: accumulator.invocationsWithUnknownFunnel,
    invocationsWithoutSpend: accumulator.invocationsWithoutSpend,
    invocationsWithInadmissibleSpend:
      accumulator.invocationsWithInadmissibleSpend,
    populationInvocations: entries.length,
  };
  if (accumulator.reportingInvocations === 0) {
    // The shortfall counts travel with the unknown too: "no attributed cost
    // across 40" cannot say whether all 40 lacked a cost or 39 carried a
    // corrupt one, and those are different bugs. When every entry lacked a
    // FUNNEL the missing operand is not the cost at all, so say which gap the
    // reader is actually looking at rather than sending them after the wrong
    // one.
    const everyEntryLackedAFunnel =
      entries.length > 0 &&
      accumulator.invocationsWithUnknownFunnel === entries.length;
    if (everyEntryLackedAFunnel) {
      return {
        ...unknown(
          AgentComponentFindingsRatioUnknownReason.FunnelUnknown,
          AgentComponentFindingsRatioOperand.FindingsEmitted
        ),
        ...shortfall,
      };
    }
    return {
      ...unknown(
        AgentComponentFindingsRatioUnknownReason.NoAttributedCost,
        AgentComponentFindingsRatioOperand.EstimatedCost
      ),
      ...shortfall,
    };
  }
  if (unitsOverflowed(accumulator)) {
    return {
      ...unknown(
        AgentComponentFindingsRatioUnknownReason.CostAccumulatorOverflow,
        null
      ),
      ...shortfall,
    };
  }
  return {
    known: true,
    whollyRefutedInvocations: accumulator.whollyRefutedInvocations,
    whollyRefutedCostMeasured: dollars(accumulator.whollyRefutedUnitsMeasured),
    whollyRefutedCostEstimated: dollars(
      accumulator.whollyRefutedUnitsEstimated
    ),
    boundedWasteInvocations: accumulator.boundedWasteInvocations,
    boundedWasteCostMeasured: dollars(accumulator.boundedWasteUnitsMeasured),
    boundedWasteCostEstimated: dollars(accumulator.boundedWasteUnitsEstimated),
    invocationsAwaitingVerdict: accumulator.invocationsAwaitingVerdict,
    reportingInvocations: accumulator.reportingInvocations,
    ...shortfall,
  };
}
