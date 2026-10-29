/**
 * ISS-7795 / ISS-10725: carry a prior stored row's MEASUREMENTS onto a candidate
 * that could not take them.
 *
 * Both lanes exist for the same reason, which is why they live together. The
 * stored-row rebuild bridge DELETEs and re-inserts a session's whole invocation
 * set from events and command metadata rather than the transcript, and the
 * insert's ON CONFLICT copies `excluded.*` over every column. So without a
 * carry-forward the first rebuild after a transcript rotates away replaces a
 * real measurement with NULL — and NULL is the value both contracts spend their
 * docblocks arguing means "nothing ever measured this", so the erasure is
 * indistinguishable from a component nobody measured.
 *
 * Both are ONE-DIRECTIONAL: a candidate that did measure keeps its own value, so
 * a re-import with better evidence still updates the row.
 *
 * ISS-10736 extended the telemetry half here rather than in a second module:
 * the footprint shares `usage_measurement` with the turn counts, so the rule for
 * carrying that label forward and the rule for the footprint it also describes
 * cannot live apart.
 */

import { AgentComponentFindingsDisposition } from "@repo/api/src/types/agent-component-findings-disposition";
import { storedAgentComponentFindingsFunnel } from "@repo/api/src/types/agent-component-findings-funnel";
import type { PriorInvocationEvidenceRow } from "./component-invocation-identity-restore.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

/**
 * ISS-7795: carry a prior row's MEASURED telemetry onto a candidate that could
 * not measure.
 *
 * The rebuild bridge deletes and re-inserts a session's whole invocation set
 * from stored rows, and it reads events and command metadata rather than the
 * transcript — so it can never recompute the per-turn attribution stamp the
 * measurement comes from. Without this, the first rebuild after a transcript
 * rotates away replaces real counts with NULL, and NULL is the value that means
 * "never measured". The consumer could not tell an unmeasured invocation from
 * one whose measurement a rebuild erased, which is the distinction the label
 * exists to keep.
 *
 * One-directional by design: a candidate that DID measure keeps its own value,
 * so a re-import with a better transcript still updates the row.
 *
 * ISS-10736: "did measure" is read off the COUNTS, not off `usageMeasurement`.
 * That label used to be non-null if and only if `invocationTelemetryColumns` had
 * just written real counts — it is all-or-nothing by construction — so the label
 * was a faithful proxy. It stopped being one the moment a derived FOOTPRINT
 * started carrying the same column: a candidate that measured nothing now labels
 * itself `estimated` purely because a footprint resolved, and reading the label
 * here would let that disarm this guard and replace the prior row's real counts
 * with NULL, the value that means "never measured". `usage_measurement` is
 * promoted with the counts it describes, not consulted to decide whether to.
 *
 * ISS-10736 (tamsinb + whitlockk review): promoting that label is also what forces
 * the FOOTPRINT decision here. The candidate reached this function having
 * already been through `invocationFootprintColumns`, which folded a resolved
 * footprint and its own `estimated` label into the two columns together. Writing
 * a prior `measured` label over the second column leaves the first one holding a
 * derived count under a measurement's name — the exact row shape that fold
 * refuses to produce, arrived at one step later. The same refusal is applied
 * here: the footprint is WITHHELD and the refusal recorded, never relabelled.
 */
export function preserveMeasuredTelemetry(
  candidate: AgentComponentInvocationCandidate,
  previous: PriorInvocationEvidenceRow
): void {
  if (
    candidateMeasuredTurnUsage(candidate) ||
    !priorMeasuredTurnUsage(previous)
  ) {
    return;
  }
  candidate.model = previous.model;
  candidate.inputTokens = optionalStoredCount(previous.input_tokens);
  candidate.outputTokens = optionalStoredCount(previous.output_tokens);
  candidate.cacheReadTokens = optionalStoredCount(previous.cache_read_tokens);
  candidate.cacheWriteTokens = optionalStoredCount(previous.cache_write_tokens);
  candidate.estimatedCost = previous.estimated_cost;
  withholdFootprintUnderForeignLabel(candidate, previous.usage_measurement);
  candidate.usageMeasurement = previous.usage_measurement;
}

/**
 * Drop a resolved footprint whose derivation the incoming label contradicts.
 *
 * Mirrors `invocationFootprintColumns` exactly, including its silence when the
 * two derivations AGREE: a prior row whose turn counts were themselves
 * `estimated` states the same derivation the footprint does, so nothing is
 * withheld and the count survives the rebuild. `footprintRefusedUnlabelled` is
 * the transient the row writer reports, so the resulting NULL stays
 * distinguishable from "nothing ever computed one".
 */
function withholdFootprintUnderForeignLabel(
  candidate: AgentComponentInvocationCandidate,
  /* The PRIOR row's label, straight off SQLite, so `string` rather than the
     narrowed union — the comparison below only asks whether it differs. */
  incomingLabel: string | null
): void {
  if (
    candidate.footprintTokens === null ||
    incomingLabel === null ||
    incomingLabel === candidate.usageMeasurement
  ) {
    return;
  }
  candidate.footprintTokens = null;
  candidate.footprintRefusedUnlabelled = true;
}

/**
 * Whether this candidate measured the TURN usage — the population
 * `preserveMeasuredTelemetry` carries forward — rather than merely carrying a
 * label. `invocationTelemetryColumns` writes these columns all-or-nothing, so any
 * one of them answers it; `model` alone does not, because a mixed-model turn
 * measures real counts under a null model.
 */
function candidateMeasuredTurnUsage(
  candidate: AgentComponentInvocationCandidate
): boolean {
  return (
    candidate.model !== null ||
    candidate.inputTokens !== null ||
    candidate.outputTokens !== null ||
    candidate.cacheReadTokens !== null ||
    candidate.cacheWriteTokens !== null
  );
}

/**
 * The same question of the PRIOR row, and asked for the same reason: a stored
 * `usage_measurement` can now describe a footprint alone, and promoting that
 * label onto a candidate with no counts would assert a label about no telemetry —
 * which the wire boundary rejects as `usage_measurement_requires_telemetry`,
 * failing the whole part.
 */
function priorMeasuredTurnUsage(previous: PriorInvocationEvidenceRow): boolean {
  return (
    previous.model !== null ||
    previous.input_tokens !== null ||
    previous.output_tokens !== null ||
    previous.cache_read_tokens !== null ||
    previous.cache_write_tokens !== null
  );
}

/** SQLite hands INTEGER columns back as `bigint`; the candidate carries `number`. */
function optionalStoredCount(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * ISS-10725 review (tamsinb): the findings half, added after the telemetry one
 * because the same erasure applies to a funnel an attributor wrote. An
 * inadmissible stored pair is NOT carried forward — it is not a measurement.
 */
export function preserveMeasuredFindings(
  candidate: AgentComponentInvocationCandidate,
  previous: PriorInvocationEvidenceRow
): void {
  if (
    candidate.findingsEmitted !== null ||
    candidate.findingsInvalidated !== null
  ) {
    return;
  }
  const funnel = storedAgentComponentFindingsFunnel(
    previous.findings_emitted,
    previous.findings_invalidated
  );
  if (funnel === null) {
    return;
  }
  candidate.findingsEmitted = funnel.findingsEmitted;
  candidate.findingsInvalidated = funnel.findingsInvalidated;
  /* ISS-11325: the carry-forward is the whole point of this function and it is
     also the one thing a reader could not previously see. These counts describe
     an EARLIER run, so the row says so — never the prior row's own disposition,
     which may have said `measured-this-run` about a run that is not this one.
     A later pass that re-reads the producer's evidence overwrites both the pair
     and this label (`stampCodeReviewFindingsOnCandidates`), which is correct:
     then the number IS this run's. */
  candidate.findingsDisposition =
    AgentComponentFindingsDisposition.CarriedForward;
}
