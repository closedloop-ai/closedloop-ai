/**
 * ISS-10727 — the findings funnel on the invocation READ contract, with the
 * population every rate must carry.
 *
 * WHY THIS IS NOT IN `agent-component-invocation.ts`. That file is the whole
 * invocation contract and is already past the 500-line smell; the findings
 * projection is one cohesive concern with its own folds, so it lives beside the
 * funnel it projects. The read row imports the field shape from here.
 *
 * OMISSION IS THE UNKNOWN STATE, STRUCTURALLY. `findingsState` cannot be
 * serialized as `"unknown"` — the field's type excludes that member — so an
 * absent field is the ONLY spelling of "not measured". That is what makes an
 * older peer that has never heard of these fields degrade to exactly the right
 * answer instead of to a plausible zero, and it is why the three states are
 * distinguishable on the wire:
 *
 * | state          | `findingsState`    | counts   |
 * | -------------- | ------------------ | -------- |
 * | measured       | `"measured"`       | present  |
 * | not measured   | OMITTED            | absent   |
 * | not applicable | `"not_applicable"` | absent   |
 *
 * A measured-ZERO is `findingsState: "measured"` with both counts `0`, which is
 * a different row from either absent case. Consumers must not hand-read those
 * keys: {@link readAgentComponentInvocationFindings} folds them back into the
 * canonical {@link AgentComponentFindingsFunnelReading}, so the not-applicable
 * signal arrives as a state rather than being inferred from a kind check.
 *
 * `findingsConfirmed` IS NEVER ON THE WIRE. It is derived by that fold from the
 * two stored counts, so it cannot disagree with its operands and cannot be
 * persisted by a producer that copied the read row's shape.
 *
 * NO DOLLARS PER FINDING (PRD-753 R3/R8). `estimatedCost` and these counts ride
 * the same row and this module computes no quotient between them.
 * {@link AGENT_COMPONENT_INVOCATION_FINDINGS_READ_KEYS} is the whole of what the
 * read path adds, as a value, so a test can hold the projection to it.
 *
 * ROOM LEFT DELIBERATELY. Every key here is additive and optional, so ISS-10718
 * (per-invocation telemetry plus a cloud `succeeded`), ISS-10739
 * (`findingsProvenance` — which source produced the count, to be carried
 * alongside `findingsState` and folded into the reading beside it) and ISS-10730
 * (`linesAdded`/`linesRemoved`) each widen the same row without changing the
 * meaning of anything below.
 */

import {
  type AgentComponentFindingsIngestDisposition,
  isAgentComponentFindingsDispositionConsistentWithFunnel,
  isAgentComponentFindingsIngestDisposition,
} from "./agent-component-findings-disposition.ts";
import {
  type AgentComponentFindingsFunnelReading,
  AgentComponentFindingsFunnelState,
  type AgentComponentFindingsInvalidationRate,
  type AgentComponentFindingsProvenanceBreakdown,
  type AgentComponentFindingsStoredFunnel,
  agentComponentFindingsInvalidationRate,
  readAgentComponentFindingsFunnel,
} from "./agent-component-findings-funnel.ts";

/**
 * The states a producer may put ON the wire. `Unknown` is absent on purpose:
 * it is spelled by omitting the field, per the table above.
 */
export type AgentComponentInvocationFindingsState =
  | typeof AgentComponentFindingsFunnelState.Measured
  | typeof AgentComponentFindingsFunnelState.NotApplicable;

/** The findings projection of the invocation read row, and the whole of it. */
export type AgentComponentInvocationFindingsReadFields = {
  findingsState?: AgentComponentInvocationFindingsState;
  findingsEmitted?: number;
  findingsInvalidated?: number;
  /**
   * ISS-11325: WHY this row reads what it reads — which is the one thing the
   * table above cannot say. `findingsState` separates measured from absent;
   * this separates a count measured by THIS run from one carried forward, and an
   * absence caused by the fold budget from one caused by the byte gate from one
   * caused by evidence nobody could read.
   *
   * OMISSION IS `unrecorded`, STRUCTURALLY, exactly as omission is `unknown`
   * above: the field is typed over the INGEST-ONLY union, which excludes that
   * member, so an older peer that never heard of this field degrades to "nobody
   * said" instead of to a statement it never made. A consumer that wants the
   * absence spelled as the `unrecorded` member resolves it at the render, with
   * the fold that render needs; there is no reader here until there is one.
   */
  findingsDisposition?: AgentComponentFindingsIngestDisposition;
};

/**
 * The keys this projection adds to the read row, as a value, keyed by `keyof`
 * so a field added to the type without being declared here fails `tsc`.
 */
export const AGENT_COMPONENT_INVOCATION_FINDINGS_READ_KEYS = [
  "findingsState",
  "findingsEmitted",
  "findingsInvalidated",
  "findingsDisposition",
] as const satisfies readonly (keyof AgentComponentInvocationFindingsReadFields)[];

/**
 * ISS-11325 keys-covered guard, because `satisfies readonly keyof[]` above is a
 * membership check and NOT a completeness one: every name in the list has to be
 * a key of the type, and a key the list omits passes it silently. The docblock
 * over the list claimed otherwise, which is how a field could be added to the
 * projection and left out of the value a test holds the projection to. This
 * mapped type is the completeness half — a new read field fails `tsc` here until
 * it is listed.
 */
type UnlistedFindingsReadKey = Exclude<
  keyof AgentComponentInvocationFindingsReadFields,
  (typeof AGENT_COMPONENT_INVOCATION_FINDINGS_READ_KEYS)[number]
>;
/** Resolves only while `T` is `never`, so a leftover key fails the constraint. */
type AssertNoUnlistedFindingsReadKey<T extends never> = T;
export type FindingsReadKeysAreCovered =
  AssertNoUnlistedFindingsReadKey<UnlistedFindingsReadKey>;

/**
 * What a read path hands this module.
 *
 * `kindDeclaresNoFindingsOutput` is ISS-10728's `none` ruling, to be resolved
 * by the caller from its own output-declaration read. It is deliberately a
 * boolean rather than a second copy of that vocabulary: `none` is a ruling and
 * `unclassified` is an unanswered question, and only the ruling belongs here —
 * an `unclassified` kind passes `false` and reads Unknown, which is the honest
 * answer to a question nobody has answered.
 *
 * NO PRODUCER SETS IT YET, AND THAT IS THE CURRENT STATE, NOT AN OVERSIGHT
 * (whitlockk review). ISS-10728's output-declaration vocabulary does not exist in
 * this repo, so both read paths leave this `false` and NO row ships
 * `not_applicable` today — every non-measured row is OMITTED, which reads
 * Unknown. The seam and the wire state ship ahead of the producer on purpose:
 * the fields are additive and optional, so a peer that gets ISS-10728 first is
 * understood by a reader that has not, rather than having its `not_applicable`
 * degrade to a plausible zero. Wiring it is ISS-10728's, and it is one
 * argument at each of the two mappers.
 */
export type AgentComponentInvocationFindingsSource = {
  /**
   * ISS-10739: the STORED shape, not the ingest one. What a read path holds
   * came out of a column, so it may predate the provenance label or carry one
   * this build has no descriptor for; gating it on the ingest contract would
   * discard two good counts over a label the read side never needed.
   */
  funnel?: AgentComponentFindingsStoredFunnel | null;
  kindDeclaresNoFindingsOutput?: boolean;
  /**
   * ISS-11325: the stored disposition cell, UNVALIDATED, because it came out of
   * a TEXT column that may hold a legacy NULL or a member only a newer build
   * describes. Both resolve to `unrecorded` at the projection rather than taking
   * two good counts down with them.
   */
  disposition?: unknown;
};

/**
 * Project a stored funnel — or its absence — onto the read row.
 *
 * A REAL MEASUREMENT OUTRANKS A DECLARATION. When a kind declares no findings
 * output and a funnel was nonetheless ingested for it, the measurement wins and
 * the row reads `measured`. The declaration describes what the kind is supposed
 * to produce; the funnel is what it did produce, and discarding a measurement
 * because a declaration disagrees would delete the only evidence that the
 * declaration is wrong.
 */
export function agentComponentInvocationFindingsFields(
  source: AgentComponentInvocationFindingsSource
): AgentComponentInvocationFindingsReadFields {
  const { funnel, kindDeclaresNoFindingsOutput = false } = source;
  // One admissibility rule, owned by the read fold, rather than a second copy
  // here that could drift from it. The fold already ranks a real measurement
  // above the declaration, so the precedence above needs no restating.
  const reading = readAgentComponentFindingsFunnel(
    funnel,
    kindDeclaresNoFindingsOutput
  );
  const measured = reading.state === AgentComponentFindingsFunnelState.Measured;
  const disposition = projectedFindingsDisposition(
    source.disposition,
    measured
  );
  if (measured) {
    return {
      findingsState: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: reading.findingsEmitted,
      findingsInvalidated: reading.findingsInvalidated,
      ...disposition,
    };
  }
  if (reading.state === AgentComponentFindingsFunnelState.NotApplicable) {
    return {
      findingsState: AgentComponentFindingsFunnelState.NotApplicable,
      ...disposition,
    };
  }
  /* ISS-11325: the absent case is the one that MOST needs the disposition. This
     is the row that used to read "not measured" and nothing more, while the
     ingest knew perfectly well whether the evidence was too big, too large to
     fold, or unreadable. The counts stay absent — they were never measured — and
     the reason travels beside the absence. */
  return { ...disposition };
}

/**
 * The disposition as it may be PUBLISHED, or no key at all.
 *
 * Two rows are refused and they are the same defect mirrored: a withheld label
 * beside real counts, and a measured or carried-forward label on a row holding
 * none. This build's writer cannot produce either, and a version-skewed peer can
 * — so the rule here is the module's existing one, that A REAL MEASUREMENT
 * OUTRANKS A DECLARATION: the counts are evidence and the contradicting label is
 * a claim, so the claim is dropped and the row reads `unrecorded` rather than
 * publishing a sentence its own numbers refute.
 *
 * `unrecorded` itself is never published as a value: it is spelled by omitting
 * the key, so a legacy row, a row this build cannot place, and a row from a peer
 * that never had the field are one shape rather than three.
 */
function projectedFindingsDisposition(
  cell: unknown,
  funnelPresent: boolean
): Pick<AgentComponentInvocationFindingsReadFields, "findingsDisposition"> {
  if (!isAgentComponentFindingsIngestDisposition(cell)) {
    return {};
  }
  return isAgentComponentFindingsDispositionConsistentWithFunnel(
    cell,
    funnelPresent
  )
    ? { findingsDisposition: cell }
    : {};
}

/**
 * Fold the wire fields back into the canonical reading, deriving
 * `findingsConfirmed`.
 *
 * A row claiming `measured` without an admissible pair of counts reads Unknown:
 * a peer that sent a state it could not back with numbers has told us nothing,
 * and coercing its counts to zero would mint a measurement.
 */
export function readAgentComponentInvocationFindings(
  row: AgentComponentInvocationFindingsReadFields
): AgentComponentFindingsFunnelReading {
  // The wire carries no provenance label today, so the fold resolves one to
  // `Unresolved` — the honest reading of a count whose route was never
  // recorded, and not a claim that some route produced it.
  //
  // A REAL MEASUREMENT OUTRANKS A DECLARATION, on the read side too. This
  // repo's producer never emits `not_applicable` beside a count pair, but a
  // version-skewed peer can, and discarding its counts would drop a reporting
  // invocation out of the rate's numerator AND its population — the same
  // measurement-over-declaration rule `agentComponentInvocationFindingsFields`
  // applies one hop earlier, stated once for both directions. The admissibility
  // test is the STORED fold, not `isAgentComponentFindingsFunnel`: that guard is
  // the INGEST contract and requires a label the wire row does not carry, so
  // gating the read on it would read every wire row as Unknown.
  if (
    row.findingsEmitted !== undefined &&
    row.findingsInvalidated !== undefined
  ) {
    const reading = readAgentComponentFindingsFunnel({
      findingsEmitted: row.findingsEmitted,
      findingsInvalidated: row.findingsInvalidated,
    });
    if (reading.state === AgentComponentFindingsFunnelState.Measured) {
      return reading;
    }
  }
  if (row.findingsState === AgentComponentFindingsFunnelState.NotApplicable) {
    return { state: AgentComponentFindingsFunnelState.NotApplicable };
  }
  return { state: AgentComponentFindingsFunnelState.Unknown };
}

/**
 * The population this rate carries is INVOCATIONS, not components. Both read
 * paths page rows for one component kind+key, so N rows here are N runs of the
 * same component and "62% across 40 reporting components" would be a false
 * statement of what was looked at. The counts also move with page size, which
 * `reportingInvocations` says honestly and `reportingComponents` would not.
 * A component-grained rate is {@link agentComponentFindingsInvalidationRate},
 * fed one reading per component.
 */
export type AgentComponentInvocationFindingsInvalidationRate =
  | {
      known: false;
      reportingInvocations: number;
      populationInvocations: number;
      bySource: AgentComponentFindingsProvenanceBreakdown;
    }
  | {
      known: true;
      /** 0..1. Multiply at the render, so the stored form stays a ratio. */
      rate: number;
      findingsEmitted: number;
      findingsInvalidated: number;
      reportingInvocations: number;
      populationInvocations: number;
      /**
       * ISS-10739: required on BOTH arms at this grain too. Re-labelling the
       * population from components to invocations must not drop the mix it was
       * measured over — a breakdown the component-grained rate carries and this
       * one did not would leave the grain both read paths actually consume
       * unable to say what fidelities went into its number.
       */
      bySource: AgentComponentFindingsProvenanceBreakdown;
    };

/**
 * The invalidation rate across a page of read rows, carrying the population it
 * was measured over. Folds each row and defers to the canonical rate — so the
 * "a rate is never bare" contract, and its unsafe-aggregate guard, have one
 * implementation and not two — then re-labels the population at this grain.
 */
export function agentComponentInvocationFindingsInvalidationRate(
  rows: readonly AgentComponentInvocationFindingsReadFields[]
): AgentComponentInvocationFindingsInvalidationRate {
  const rate: AgentComponentFindingsInvalidationRate =
    agentComponentFindingsInvalidationRate(
      rows.map(readAgentComponentInvocationFindings)
    );
  const population = {
    reportingInvocations: rate.reportingComponents,
    populationInvocations: rate.populationComponents,
    bySource: rate.bySource,
  };
  if (!rate.known) {
    return { known: false, ...population };
  }
  return {
    known: true,
    rate: rate.rate,
    findingsEmitted: rate.findingsEmitted,
    findingsInvalidated: rate.findingsInvalidated,
    ...population,
  };
}
