/**
 * ISS-7796 — the findings funnel: a component kind's OUTCOME signal, at the
 * same grain (`agent_component_invocations`) the cost denominator already sits
 * at, so numerator and denominator divide.
 *
 * TWO VALUES ARE STORED AND ONE IS DERIVED. `findingsEmitted` and
 * `findingsInvalidated` are the stored pair; `findingsConfirmed` is computed at
 * read as `emitted - invalidated` and is never persisted, so a third number
 * cannot go stale against the two it is derived from.
 *
 * A FINDING AWAITING A VERDICT IS IN NEITHER COUNT. `pending_verification` has
 * not been refuted and has not survived validation either, so it is excluded
 * from `findingsEmitted` as well as from `findingsInvalidated` — otherwise the
 * derived `confirmed` would silently claim every un-adjudicated finding. A run
 * that ended with pending findings is a COMPLETENESS CAVEAT the ingest result
 * states separately (see `@repo/lib/code-review/findings-funnel-attribution`).
 *
 * UNKNOWN IS NEVER ZERO. A component with no ingested funnel reads
 * {@link AgentComponentFindingsFunnelState.Unknown}. "0 findings" and "we do
 * not measure findings for this component" are different facts and must not
 * render identically — which is why the absent case is a state rather than a
 * zeroed funnel. ISS-10727 added the THIRD state,
 * {@link AgentComponentFindingsFunnelState.NotApplicable}: a kind that declares
 * it has no findings output at all. Its input is ISS-10728's output-declaration
 * vocabulary, which this module consumes as a boolean rather than restating — a
 * `none` ruling reads NotApplicable, an `unclassified` kind reads Unknown. That
 * vocabulary now exists: `agent-component-output-declaration.ts` is where a
 * caller resolves the ruling it passes in, and the composition runs one way —
 * a reading's `findingsConfirmed` is the `measuredCount` that contract resolves
 * a `critique`-family subject with, so a consumer calls one function rather
 * than reconciling two contracts at the same grain.
 *
 * NO DOLLARS PER FINDING. The tokens a finding cost are not separable from the
 * rest of the invocation's turn, so a per-finding cost is not a field here, not
 * a derived value here, and not something a consumer may ask this contract for
 * (PRD-753 R3/R8). Spend and counts sit beside each other at the invocation
 * grain and the reader does the judgement. Do not add a helper that divides an
 * `estimatedCost` by any value on this type.
 *
 * A RATE CARRIES ITS POPULATION (PRD-753 R2): see
 * {@link agentComponentFindingsInvalidationRate}, which never returns a bare
 * percentage.
 *
 * A COUNT CARRIES HOW IT WAS OBTAINED (ISS-10739, PRD-753 R7). Every stored
 * funnel is labelled with the ingest route that produced it
 * ({@link AgentComponentFindingsProvenance}); an ingest that cannot say is
 * rejected rather than defaulted, and a legacy row that never recorded one
 * reads `Unresolved`. The rate above carries a per-source breakdown for the
 * same reason a bare percentage is refused: a mixed-fidelity population is a
 * real number over a mix, and the mix has to be sayable beside it.
 */

import { z } from "zod";
import type { AgentComponentFindingsIngestDisposition } from "./agent-component-findings-disposition.ts";
import {
  isAgentComponentFindingsDispositionConsistentWithFunnel,
  isAgentComponentFindingsIngestDisposition,
} from "./agent-component-findings-disposition.ts";
import {
  AgentComponentFindingsProvenance,
  isAgentComponentFindingsIngestRoute,
  isAgentComponentFindingsProvenance,
} from "./agent-component-findings-provenance.ts";

/**
 * The stored pair, and the whole of it. Adding a third stored number here
 * re-creates exactly the drift the derived `confirmed` exists to prevent.
 */
export type AgentComponentFindingsFunnel = {
  findingsEmitted: number;
  findingsInvalidated: number;
  /**
   * ISS-10739: the ingest route the two counts above came from. Mandatory
   * whenever a count is set — the same both-or-neither rule ISS-7795 applies to
   * `usageMeasurement` — so the pair can never be half-populated and no reader
   * has to guess which route a number took.
   */
  findingsProvenance: AgentComponentFindingsProvenance;
};

/**
 * A funnel as it may be found in STORAGE, which includes rows written before
 * ISS-10739 and rows written by a build that knows a label this one does not.
 * The label is `unknown` here and only here — an ingest must supply a member of
 * the union, a read must survive anything a column actually holds — so the type
 * says what is true rather than making every caller cast to admit it.
 */
export type AgentComponentFindingsStoredFunnel = Omit<
  AgentComponentFindingsFunnel,
  "findingsProvenance"
> & {
  findingsProvenance?: unknown;
};

export const AgentComponentFindingsFunnelState = {
  /** No funnel has been ingested for this invocation. NOT a zero. */
  Unknown: "unknown",
  /** A funnel was ingested; the counts below are real measurements. */
  Measured: "measured",
  /**
   * ISS-10727: this kind declares no findings output at all, so there is
   * nothing to ingest and never will be. Distinct from {@link Unknown}, which
   * is an unanswered question about a kind that COULD report — collapsing the
   * two is the thing this member exists to stop. The declaration itself is
   * ISS-10728's vocabulary (`none` is a ruling, `unclassified` is an
   * unanswered question); this member is what a `none` ruling reads as here,
   * and an `unclassified` kind keeps reading {@link Unknown}.
   */
  NotApplicable: "not_applicable",
} as const;
export type AgentComponentFindingsFunnelState =
  (typeof AgentComponentFindingsFunnelState)[keyof typeof AgentComponentFindingsFunnelState];

/** What a read surface gets. `confirmed` exists only here, never in storage. */
export type AgentComponentFindingsFunnelReading =
  | { state: typeof AgentComponentFindingsFunnelState.Unknown }
  | { state: typeof AgentComponentFindingsFunnelState.NotApplicable }
  | {
      state: typeof AgentComponentFindingsFunnelState.Measured;
      findingsEmitted: number;
      findingsInvalidated: number;
      findingsConfirmed: number;
      /**
       * Per reading, never per population: two components in one fold can have
       * been ingested by different routes and each keeps its own label.
       */
      findingsProvenance: AgentComponentFindingsProvenance;
    };

/** What one ingest route contributed to a population. */
export type AgentComponentFindingsProvenanceTally = {
  reportingComponents: number;
  findingsEmitted: number;
  findingsInvalidated: number;
  /**
   * False when this bucket's own total left the safe-integer range, where the
   * number is already rounded. The count is still published — a shortfall is a
   * caveat, not a reason to withhold the figure — but it is published saying
   * so, the same judgement the aggregate arm makes when it declines to quote a
   * rate over an unrepresentable total.
   */
  representable: boolean;
};

/**
 * The mix behind an aggregate, keyed by the union so a fourth provenance fails
 * `tsc` at every site that builds one. There is no default bucket and no
 * "other" key: an unhandled member cannot quietly land somewhere.
 */
export type AgentComponentFindingsProvenanceBreakdown = Record<
  AgentComponentFindingsProvenance,
  AgentComponentFindingsProvenanceTally
>;

/**
 * An invalidation rate that cannot be quoted without the population it was
 * measured over — "62% across 4 reporting components", never a bare "62%".
 *
 * `known: false` is returned when no reporting component emitted an
 * adjudicated finding, because 0 emitted findings has no invalidation rate at
 * all — and equally when the aggregate leaves the safe-integer range, where a
 * rounded total would be quoted as a measurement. It still carries both
 * population counts, so the caller can say what it looked at rather than
 * rendering nothing.
 */
export type AgentComponentFindingsInvalidationRate =
  | {
      known: false;
      reportingComponents: number;
      populationComponents: number;
      bySource: AgentComponentFindingsProvenanceBreakdown;
    }
  | {
      known: true;
      /** 0..1. Multiply at the render, so the stored form stays a ratio. */
      rate: number;
      findingsEmitted: number;
      findingsInvalidated: number;
      reportingComponents: number;
      populationComponents: number;
      /**
       * ISS-10739: the mix the rate was measured over. Required on BOTH arms,
       * so a consumer cannot construct or destructure a rate without having
       * been handed the breakdown that says what fidelities went into it —
       * "62% across 4 reporting components" becomes sayable as "of which N
       * plugin-emitted, M transcript-recovered".
       */
      bySource: AgentComponentFindingsProvenanceBreakdown;
    };

/**
 * A count this contract accepts. The impossible set for a finding count is
 * wider than "negative": a fractional count, a non-finite one, and a magnitude
 * past the safe-integer range all render as confident real measurements.
 */
const agentComponentFindingsCountSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

/**
 * A route an ingest may DECLARE, validated through the provenance module's own
 * guard. Narrower than the full union by one member on purpose:
 * {@link AgentComponentFindingsProvenance.Unresolved} is what the read boundary
 * coalesces an absent or unreadable label to, so accepting it here would let a
 * producer write the fallback and make a fresh unplaceable row
 * indistinguishable from a legacy unlabelled one.
 */
const agentComponentFindingsProvenanceSchema =
  z.custom<AgentComponentFindingsProvenance>((value) =>
    isAgentComponentFindingsIngestRoute(value)
  );

/**
 * Keyed by `keyof`, so a further stored value added to the type fails `tsc`
 * here rather than slipping past a boundary that never learned to validate it.
 */
const agentComponentFindingsFunnelShape: {
  [Key in keyof AgentComponentFindingsFunnel]: z.ZodType<
    AgentComponentFindingsFunnel[Key]
  >;
} = {
  findingsEmitted: agentComponentFindingsCountSchema,
  findingsInvalidated: agentComponentFindingsCountSchema,
  findingsProvenance: agentComponentFindingsProvenanceSchema,
};

/**
 * The keys an INGEST must carry for this contract, as a value, so a schema can
 * be checked against the set rather than against a hand-copied list of names.
 * DERIVED from the shape above — a list written out beside it would silently
 * stay two names long when a third is stored.
 *
 * Named for the ingest and not for storage on purpose: this set is the STRICT
 * shape, where the label is mandatory, while {@link
 * AgentComponentFindingsStoredFunnel} is the tolerant read shape where it is
 * not. A row already in storage may be missing `findingsProvenance`; a row
 * entering through the ingest may not.
 */
export const AGENT_COMPONENT_FINDINGS_FUNNEL_INGEST_KEYS: readonly (keyof AgentComponentFindingsFunnel)[] =
  Object.keys(
    agentComponentFindingsFunnelShape
  ) as readonly (keyof AgentComponentFindingsFunnel)[];

/**
 * The COUNT keys alone — the ingest set minus the ISS-10739 label. ISS-10725's
 * invocation sync item carries the two counts and NOT the label (ISS-10727
 * widens the wire row), so that boundary checks against this set; substituting
 * the ingest set there would let a label-only item declare itself
 * findings-carrying on a wire that has no such field. Derived by excluding one
 * key by name rather than by respelling the pair, so a THIRD stored count is
 * picked up here automatically while the label never is.
 */
export const AGENT_COMPONENT_FINDINGS_FUNNEL_COUNT_KEYS: readonly Exclude<
  keyof AgentComponentFindingsFunnel,
  "findingsProvenance"
>[] = AGENT_COMPONENT_FINDINGS_FUNNEL_INGEST_KEYS.filter(
  (key) => key !== "findingsProvenance"
) as readonly Exclude<
  keyof AgentComponentFindingsFunnel,
  "findingsProvenance"
>[];

/** A negative derived `confirmed` cannot describe any real run. */
function invalidatedWithinEmitted(funnel: {
  findingsEmitted: number;
  findingsInvalidated: number;
}): boolean {
  return funnel.findingsInvalidated <= funnel.findingsEmitted;
}

const agentComponentFindingsFunnelObject = z.object(
  agentComponentFindingsFunnelShape
);

/**
 * The INGEST boundary. Deliberately NOT `.strict()`: a stored row carries
 * columns beyond these, and refusing the whole funnel because a sibling column
 * rode along would throw away a real measurement.
 *
 * `findingsProvenance` is REQUIRED here, and must name a route a producer can
 * actually declare. A producer that cannot say how it obtained a count is
 * rejected rather than defaulted — defaulting to the stronger label is the
 * specific failure this prevents, because it would silently upgrade every
 * unlabelled row to plugin-emitted. This schema is the contract the sync
 * boundary will validate against; the funnel is not on the sync item yet, so
 * ISS-10726 owns wiring it into one and nothing calls it from a sync path
 * today.
 */
const agentComponentFindingsFunnelSchema =
  agentComponentFindingsFunnelObject.refine(invalidatedWithinEmitted);

/**
 * The READ boundary, which is deliberately more tolerant than the ingest one,
 * and tolerant of the LABEL rather than only of its absence. Two rows reach it
 * that an ingest would refuse: one persisted before ISS-10739, carrying counts
 * and no label, and one whose label this build has no descriptor for — a
 * member added later, or a newer peer's write. Both carry real counts, and
 * neither may be discarded: a row the derivation cannot place is LISTED, never
 * dropped. Both read {@link AgentComponentFindingsProvenance.Unresolved}, which
 * is a different fact from a known-weak label (PRD-753 R1) and is not a real
 * source. The counts are therefore validated here and the label is not, so an
 * unreadable label can never take two good numbers down with it.
 */
const agentComponentFindingsStoredFunnelSchema =
  agentComponentFindingsFunnelObject
    .omit({ findingsProvenance: true })
    .extend({ findingsProvenance: z.unknown() })
    .refine(invalidatedWithinEmitted);

/**
 * Whether `value` is a funnel an ingest may accept, in either sync direction.
 * This is the gate ISS-10726 calls when the funnel reaches the sync item; the
 * funnel is not on it yet, so today the label is enforced at the single
 * producer by `tsc` and this is the contract that boundary will use.
 * `invalidated > emitted` is rejected because the derived `confirmed` would be
 * negative, and a count with no `findingsProvenance` is rejected because a
 * number nobody can place must not enter storage wearing a source it never had.
 */
export function isAgentComponentFindingsFunnel(
  value: unknown
): value is AgentComponentFindingsFunnel {
  return agentComponentFindingsFunnelSchema.safeParse(value).success;
}

/**
 * Whether `value` is an admissible pair as STORAGE and the WIRE hold it — the
 * same count rules as {@link isAgentComponentFindingsFunnel} with the ISS-10739
 * label optional rather than mandatory.
 *
 * The two predicates are the ingest contract and the stored/wire one, and they
 * are deliberately different by exactly one key. A row already in a column, and
 * an invocation sync item, both carry the counts and no label (ISS-10727 widens
 * the wire row); asking them the INGEST question would refuse every real pair
 * as malformed and dead-letter the protocol version that carries it. What the
 * two share is the count rules themselves, so a producer and a reader still
 * cannot disagree about which pairs are real.
 */
export function isAgentComponentFindingsStoredFunnel(
  value: unknown
): value is AgentComponentFindingsStoredFunnel {
  return agentComponentFindingsStoredFunnelSchema.safeParse(value).success;
}

/** The derived third stage. Never store what this returns. */
export function agentComponentFindingsConfirmed(
  funnel: Pick<
    AgentComponentFindingsFunnel,
    "findingsEmitted" | "findingsInvalidated"
  >
): number {
  return funnel.findingsEmitted - funnel.findingsInvalidated;
}

/**
 * Fold a persisted funnel — or its absence — into what a read surface renders.
 * An inadmissible stored pair reads Unknown rather than being coerced into a
 * plausible number.
 *
 * ABSENCE READS UNKNOWN HERE, ALWAYS. This fold sees a stored pair and nothing
 * else, so it cannot tell "nobody measured this" from "this kind declares no
 * findings output" — that question is answered where the declaration is
 * actually read, by `agentComponentInvocationFindingsFields`. A
 * declaration-shaped parameter on this signature would only ever be a second
 * place for the same answer to be given, and no caller passed it.
 */
export function readAgentComponentFindingsFunnel(
  funnel: AgentComponentFindingsStoredFunnel | null | undefined,
  kindDeclaresNoFindingsOutput = false
): AgentComponentFindingsFunnelReading {
  const parsed = agentComponentFindingsStoredFunnelSchema.safeParse(funnel);
  if (!parsed.success) {
    return {
      state: kindDeclaresNoFindingsOutput
        ? AgentComponentFindingsFunnelState.NotApplicable
        : AgentComponentFindingsFunnelState.Unknown,
    };
  }
  return {
    state: AgentComponentFindingsFunnelState.Measured,
    findingsEmitted: parsed.data.findingsEmitted,
    findingsInvalidated: parsed.data.findingsInvalidated,
    findingsConfirmed: agentComponentFindingsConfirmed(parsed.data),
    findingsProvenance: isAgentComponentFindingsProvenance(
      parsed.data.findingsProvenance
    )
      ? parsed.data.findingsProvenance
      : AgentComponentFindingsProvenance.Unresolved,
  };
}

/**
 * The invalidation rate across a population of components, with the population
 * attached. `readings` is the WHOLE population — components reading Unknown are
 * counted in `populationComponents` and excluded from the numerator and
 * denominator, so a rate is never quoted as if it covered components that do
 * not report.
 */
export function agentComponentFindingsInvalidationRate(
  readings: readonly AgentComponentFindingsFunnelReading[]
): AgentComponentFindingsInvalidationRate {
  let findingsEmitted = 0;
  let findingsInvalidated = 0;
  let reportingComponents = 0;
  const bySource = emptyAgentComponentFindingsProvenanceBreakdown();
  for (const reading of readings) {
    if (reading.state !== AgentComponentFindingsFunnelState.Measured) {
      continue;
    }
    reportingComponents += 1;
    findingsEmitted += reading.findingsEmitted;
    findingsInvalidated += reading.findingsInvalidated;
    // Total over the union: indexing has no default arm, so a new provenance
    // cannot land in an "other" bucket and be read as one of these.
    const tally = bySource[reading.findingsProvenance];
    tally.reportingComponents += 1;
    tally.findingsEmitted += reading.findingsEmitted;
    tally.findingsInvalidated += reading.findingsInvalidated;
    tally.representable =
      Number.isSafeInteger(tally.findingsEmitted) &&
      Number.isSafeInteger(tally.findingsInvalidated);
  }
  const aggregateIsRepresentable =
    Number.isSafeInteger(findingsEmitted) &&
    Number.isSafeInteger(findingsInvalidated);
  // Each addend cleared `isAgentComponentFindingsFunnel` on its own; their sum
  // need not. Past the safe-integer range the total is already rounded, so a
  // rate derived from it would be quoted as measured while being arithmetic
  // noise — unknown is the only honest reading.
  if (!aggregateIsRepresentable || findingsEmitted === 0) {
    return {
      known: false,
      reportingComponents,
      populationComponents: readings.length,
      bySource,
    };
  }
  return {
    known: true,
    rate: findingsInvalidated / findingsEmitted,
    findingsEmitted,
    findingsInvalidated,
    reportingComponents,
    populationComponents: readings.length,
    bySource,
  };
}

/**
 * A bucket per provenance, written out so the object literal itself is the
 * exhaustiveness check. A breakdown built by looping over a derived value list
 * would satisfy the type only through a cast, and a cast is exactly what stops
 * a missing member from failing `tsc`.
 */
function emptyAgentComponentFindingsProvenanceBreakdown(): AgentComponentFindingsProvenanceBreakdown {
  return {
    [AgentComponentFindingsProvenance.PluginEmitted]: emptyProvenanceTally(),
    [AgentComponentFindingsProvenance.TranscriptRecovered]:
      emptyProvenanceTally(),
    [AgentComponentFindingsProvenance.Unresolved]: emptyProvenanceTally(),
  };
}

function emptyProvenanceTally(): AgentComponentFindingsProvenanceTally {
  return {
    reportingComponents: 0,
    findingsEmitted: 0,
    findingsInvalidated: 0,
    representable: true,
  };
}

/**
 * ISS-10725: one stored cell read back as a finding count, or `undefined`.
 *
 * Reached through raw reads where the declared row type does not constrain the
 * runtime value: SQLite hands an INTEGER column back as a `bigint` and a corrupt
 * cell back as TEXT, and Postgres `bigint` arrives as a `bigint` too. That is
 * why a bare `Number(cell)` cannot serve here — it turns a blank or whitespace
 * cell into a MEASURED `0`, which is the one wrong answer this contract exists
 * to prevent, and it turns a corrupt cell into `NaN`, which the `.strict()` wire
 * boundary then rejects, taking the whole part and its generation with it rather
 * than the one field.
 */
function findingsCountFromCell(
  value: number | bigint | string | null | undefined
): number | undefined {
  if (value == null) {
    return;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return;
  }
  const parsed = agentComponentFindingsCountSchema.safeParse(Number(value));
  return parsed.success ? parsed.data : undefined;
}

/**
 * How a stored pair of cells read: nothing was written, something was written
 * that cannot be a funnel, or a real measurement.
 *
 * ISS-10725 review (tamsinb, chatgpt-codex): `Invalid` exists because the two
 * absences are different facts and only one of them is benign. A row nothing
 * ever measured and a row a buggy attributor half-set both degrade to Unknown
 * at the read — that degradation is correct and must stay — but collapsing them
 * here would leave a corrupt write with no trace anywhere, which is the same
 * distinction the telemetry lane keeps with `usageRefusedCorruptCounts`.
 */
export const AgentComponentFindingsCellsReading = {
  /** Neither cell was written. The legitimate "not measured" row. */
  Absent: "absent",
  /**
   * At least one cell was written and the pair is not a funnel: half-set,
   * blank, corrupt, out of range, or `invalidated > emitted`.
   */
  Invalid: "invalid",
  Measured: "measured",
} as const;
export type AgentComponentFindingsCellsReading =
  (typeof AgentComponentFindingsCellsReading)[keyof typeof AgentComponentFindingsCellsReading];

export type AgentComponentFindingsCellsResult =
  | { reading: typeof AgentComponentFindingsCellsReading.Absent }
  | { reading: typeof AgentComponentFindingsCellsReading.Invalid }
  | {
      reading: typeof AgentComponentFindingsCellsReading.Measured;
      /**
       * ISS-10739: the STORED shape. These are two cells, and no column holds
       * the label yet, so what a cell read can honestly produce is a pair whose
       * provenance is absent — which the read fold resolves to `Unresolved`.
       */
      funnel: AgentComponentFindingsStoredFunnel;
    };

/**
 * Read a stored pair of cells, keeping WHY a funnel is absent.
 *
 * Callers that only need the value use
 * {@link storedAgentComponentFindingsFunnel}; a caller that can report — one
 * that knows the session the row came from — uses this so an impossible stored
 * pair reaches a log instead of vanishing into the same `null` a never-measured
 * row produces.
 */
export function readStoredAgentComponentFindingsCells(
  emittedCell: number | bigint | string | null | undefined,
  invalidatedCell: number | bigint | string | null | undefined
): AgentComponentFindingsCellsResult {
  if (emittedCell == null && invalidatedCell == null) {
    return { reading: AgentComponentFindingsCellsReading.Absent };
  }
  const findingsEmitted = findingsCountFromCell(emittedCell);
  const findingsInvalidated = findingsCountFromCell(invalidatedCell);
  if (findingsEmitted === undefined || findingsInvalidated === undefined) {
    return { reading: AgentComponentFindingsCellsReading.Invalid };
  }
  const funnel = { findingsEmitted, findingsInvalidated };
  if (!isAgentComponentFindingsStoredFunnel(funnel)) {
    return { reading: AgentComponentFindingsCellsReading.Invalid };
  }
  return { reading: AgentComponentFindingsCellsReading.Measured, funnel };
}

/**
 * Read a stored pair of cells into a funnel, or `null` for "not measured".
 *
 * BOTH-OR-NEITHER, and it is the half-set case that makes this a shared helper
 * rather than two independent cell reads. `findingsInvalidated` without
 * `findingsEmitted` is meaningless — invalidated out of what? — so a row that
 * holds one and not the other yields `null` (Unknown), never a number beside a
 * fabricated companion. `invalidated > emitted` is rejected by the same
 * predicate the wire boundary uses, so a producer and a reader cannot disagree
 * about which stored pairs are real.
 */
export function storedAgentComponentFindingsFunnel(
  emittedCell: number | bigint | string | null | undefined,
  invalidatedCell: number | bigint | string | null | undefined
): AgentComponentFindingsStoredFunnel | null {
  const result = readStoredAgentComponentFindingsCells(
    emittedCell,
    invalidatedCell
  );
  return result.reading === AgentComponentFindingsCellsReading.Measured
    ? result.funnel
    : null;
}

/**
 * ISS-11325: the wire keys a stored findings row projects — the pair, and the
 * statement about the pair.
 */
export type AgentComponentFindingsWireProjection = {
  findingsEmitted?: number;
  findingsInvalidated?: number;
  findingsDisposition?: AgentComponentFindingsIngestDisposition;
};

/**
 * Project a stored row's three findings cells onto the wire.
 *
 * ONE FOLD, CALLED FROM BOTH PRODUCERS, and that is a contract rather than a
 * convenience (@tamsinb review). The Desktop's `storedRowToSyncItem` and the
 * cloud's row→wire projection both rebuild items from persisted rows, and ingest
 * reconstructs a generation id from the cloud's rebuild to reconcile against the
 * hash the Desktop sent. Two copies making the same keep/drop call today is one
 * edit away from a PERMANENT `generation_conflict` — every row in the generation
 * dead-lettered and re-dropped on retry — so the decision lives here, beside
 * {@link storedAgentComponentFindingsFunnel}, which the two already share for
 * exactly this reason.
 *
 * THE DISPOSITION IS DROPPED IN TWO CASES, both because the wire is `.strict()`
 * and a rejection costs the whole part rather than the one field:
 *
 *  - A member this build cannot place. It can only come from a newer producer,
 *    and re-serializing a value that cannot be vouched for is how a round trip
 *    stops reproducing what the producer sent. Omission is already the shape
 *    "nobody recorded one" has always had.
 *  - A member the emitted pair CONTRADICTS. The pair can be dropped above — a
 *    half-set or inverted pair emits neither key — and a `measured-this-run`
 *    label riding beside that omission would claim this run measured a funnel
 *    the item does not carry. Consistency is knowable only after the pair is
 *    resolved, which is why this is one projection and not two.
 */
export function storedAgentComponentFindingsWireProjection(
  emittedCell: number | bigint | string | null | undefined,
  invalidatedCell: number | bigint | string | null | undefined,
  dispositionCell: unknown
): AgentComponentFindingsWireProjection {
  const funnel = storedAgentComponentFindingsFunnel(
    emittedCell,
    invalidatedCell
  );
  const projected: AgentComponentFindingsWireProjection =
    funnel === null
      ? {}
      : {
          findingsEmitted: funnel.findingsEmitted,
          findingsInvalidated: funnel.findingsInvalidated,
        };
  if (!isAgentComponentFindingsIngestDisposition(dispositionCell)) {
    return projected;
  }
  return isAgentComponentFindingsDispositionConsistentWithFunnel(
    dispositionCell,
    projected.findingsEmitted !== undefined
  )
    ? { ...projected, findingsDisposition: dispositionCell }
    : projected;
}
