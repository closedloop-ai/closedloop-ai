/**
 * @file sync-lane-stall-telemetry.ts
 * @description ISS-5387 — emit the "a sync lane is working but not recording
 * progress" signal on the EXISTING desktop telemetry transport.
 *
 * ## Why it is not a method on `Observability`
 *
 * Two reasons, and both matter.
 *
 * 1. `Observability` sits at the 1,000-line ceiling (`noExcessiveLinesPerFile`)
 *    and is deliberately NOT grandfathered, so a new static there would have to
 *    displace an existing one.
 * 2. The obvious host, {@link Observability.storeIntegrityResult}, owns a
 *    four-state cadence machine over `storeIntegrityState`
 *    (detected/persistent/recovered/healthy). Feeding an unrelated condition
 *    into it would corrupt the SQLite probe's own transitions — the next healthy
 *    probe would report `recovered` from a failure that was never its own.
 *
 * So this rides the public {@link Observability.getTelemetryEmitter} escape
 * hatch, which is the same `TelemetryService` every other desktop signal goes
 * through. It is a new CATEGORY on an existing pipeline, not a new sink.
 *
 * ## Why a raw log would not be enough
 *
 * A lane whose durable cursor stops advancing keeps logging successful uploads —
 * ISS-5347 ran that way for three days behind 1,713 reassuring log lines, and
 * nothing in the lane raised a failure because, from the lane's point of view,
 * nothing failed. The condition is only visible by CORRELATION, so it needs a
 * monitored signal rather than a line someone might read.
 *
 * Content-free by construction: a lane id, a unit count, and an age. No session
 * ids, file paths, payload bodies, or credentials.
 */

import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import {
  SyncLaneDeadLetteredBasis,
  SyncLaneStallKind,
} from "../../shared/sync-burndown-contract.js";
import { buildDesktopClientVersionTrace } from "./desktop-client-version.js";
import { Observability } from "./observability.js";
import {
  SYNC_LANE_STALL_UNKNOWN,
  type SyncLaneStallDiagnostics,
} from "./telemetry-protocol.js";

/** What the burn-down reporter knows about a stalled lane. */
export type SyncLaneStallTelemetryInput = {
  /** The lane id (`session_metadata`, `component_inventory`, …). */
  lane: string;
  /** Units the lane completed while the cursor did not move. */
  workCompletedSincePrevious: number;
  /** Age of the durable cursor's last write, or null when it never persisted one. */
  durableCursorAgeMs: number | null;
  /**
   * Items this lane is holding in an abandoned state right now, reported
   * alongside so the alert is actionable. Read it with
   * {@link deadLetteredBasis}: it is never a running loss total.
   */
  deadLetteredCount: number;
  /**
   * ISS-9744: what {@link deadLetteredCount} counted
   * (`SyncLaneDeadLetteredBasis`). OPTIONAL, and an absent or unrecognised value
   * stays absent — unlike {@link kind}, which folds onto a real member, because
   * naming a basis this build did not receive would assert exactly the meaning
   * this field exists to stop assuming.
   */
  deadLetteredBasis?: string;
  /**
   * ISS-5973: which stall this is. OPTIONAL, and an unrecognised value is
   * treated exactly like an absent one — both fall back to the cursor-frozen
   * wording. The alert is never dropped over a `kind` this build cannot read:
   * losing the signal is strictly worse than describing it imprecisely.
   */
  kind?: string;
  /** Items still owed when the stall was raised, where the lane counts a queue. */
  itemsRemaining?: number | null;
  /**
   * True when {@link itemsRemaining} is a FLOOR — the producing probe is bounded
   * and hit its cap. Absent means EXACT, which is the safe default for a
   * version-skewed producer that predates this field: a missing `>=` costs
   * precision, whereas defaulting to "lower bound" would decorate every exact
   * count with a qualifier it has not earned.
   */
  itemsRemainingIsLowerBound?: boolean;
  /**
   * ISS-7401: rows the lane reported clearing since the previous sample, or
   * `null`/absent when unmeasured. Reported, never acted on.
   */
  queueRowsClearedSincePrevious?: number | null;
};

function describeCursorAge(durableCursorAgeMs: number | null): string {
  if (durableCursorAgeMs === null) {
    // Never persisted at all — the `buildComponentCursorPersist(null)` case,
    // which is a different (and worse) failure than a merely stale write.
    return "never persisted";
  }
  return `${Math.round(durableCursorAgeMs / 1000)}s stale`;
}

/**
 * Report that `lane` completed work while its durable cursor stood still.
 *
 * Emission is rate-limited by the CALLER (the burn-down reporter reports a lane
 * once per stall episode and re-arms only after a genuine advance), so this
 * function stays a dumb emit with no cadence state of its own.
 */
export function reportSyncLaneStall(input: SyncLaneStallTelemetryInput): void {
  // ISS-8590: without this the event cannot say which build produced it, so a
  // residual stall cannot be attributed to a pre-fix client rather than a live
  // defect. Note the version is only a BUILD identifier for release clients — a
  // client run from source reports the bare series anchor in the manifest, which
  // every source build shares regardless of commit.
  const trace = buildDesktopClientVersionTrace();
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "sync.durable_cursor.stalled",
    message: describeStall(input),
    diagnostics: { syncLaneStall: buildStallDiagnostics(input) },
    trace,
  });
}

/**
 * ISS-7401: the same facts the message states, as fields a monitor can GROUP BY.
 *
 * The message is unchanged — an operator reads prose, a dashboard cannot. Before
 * this, `lane` and `kind` existed ONLY inside that prose, so the panel could
 * count stalls and could not say which lane or which failure dominated: a
 * session lane at healthy flat queue depth and a transcript lane sitting on
 * thousands of dead-letters were one undifferentiated number.
 *
 * ISS-8589: the breakdown OBJECT is unconditional — a lane outside the closed
 * set coarsens to {@link SYNC_LANE_STALL_UNKNOWN} rather than taking `kind`,
 * both counts and the cursor age with it, which is what the receiving schema
 * already does with that same value.
 *
 * Unconditional is a claim about the OBJECT and never about every field in it.
 * `durableCursorAgeMs`, `itemsRemaining` and their siblings stay OMITTED when
 * the lane cannot measure them, because the receiver declares each one optional
 * and NOT nullable: a `null` fails that field's own parse, and `diagnostics` is
 * parsed as a whole, so the stall event would be dropped entirely. The
 * guaranteed shape is therefore exactly `lane`, `kind`,
 * `workCompletedSincePrevious` and `deadLetteredCount` — a floor the suite pins
 * on a stall whose every optional measurement is absent.
 *
 * What this does NOT close: the ~690/week unattributable stalls PRD-699 §2b
 * counted. The dropped-breakdown branch replaced here never fired on a shipped
 * build — its only caller passes a `SyncLaneId`, and `sync-lane-cloud-health`
 * pins that set equal to `SyncLane`. This is skew hardening: a future
 * vocabulary divergence now costs one field instead of the whole breakdown.
 */
function buildStallDiagnostics(
  input: SyncLaneStallTelemetryInput
): SyncLaneStallDiagnostics {
  const diagnostics: SyncLaneStallDiagnostics = {
    lane: resolveStallLane(input.lane),
    kind: resolveStallKind(input.kind),
    workCompletedSincePrevious: input.workCompletedSincePrevious,
    deadLetteredCount: input.deadLetteredCount,
  };
  const deadLetteredBasis = resolveDeadLetteredBasis(input.deadLetteredBasis);
  if (deadLetteredBasis !== null) {
    // Omitted, never defaulted: absent means "this producer did not say", and a
    // dashboard must be able to tell that from a stated basis.
    diagnostics.deadLetteredBasis = deadLetteredBasis;
  }
  if (input.durableCursorAgeMs !== null) {
    // Omitted, never zeroed: a never-persisted cursor is a WORSE condition than
    // a freshly-written one, and `0` would report it as the best possible read.
    diagnostics.durableCursorAgeMs = input.durableCursorAgeMs;
  }
  if (typeof input.queueRowsClearedSincePrevious === "number") {
    // Omitted when unmeasured. A `0` here is meaningful and DIFFERENT: it says
    // the lane cleared nothing, which is the shape worth paging on.
    diagnostics.queueRowsClearedSincePrevious =
      input.queueRowsClearedSincePrevious;
  }
  if (typeof input.itemsRemaining === "number") {
    diagnostics.itemsRemaining = input.itemsRemaining;
    diagnostics.itemsRemainingIsLowerBound =
      input.itemsRemainingIsLowerBound ?? false;
  }
  return diagnostics;
}

/**
 * Narrow a reported value onto one of the closed vocabularies this event
 * carries, or `null` when a version-skewed producer named something this build
 * has never heard of. Each caller then decides what an unrecognised value costs.
 */
function narrowToClosedSet<T extends string>(
  vocabulary: Record<string, T>,
  reported: string | undefined
): T | null {
  for (const value of Object.values(vocabulary)) {
    if (value === reported) {
      return value;
    }
  }
  return null;
}

/**
 * Narrow a reported lane onto the closed set, coarsening one this build cannot
 * type onto the shared unknown bucket.
 *
 * Scoped to the structured FIELD, and only it: `syncLaneStall.lane` stays a
 * literal this module owns, so a drifted vocabulary cannot widen the value a
 * dashboard groups by. {@link describeStall} still renders the reported string
 * verbatim into `message` on the same event, deliberately — the prose is where
 * the name an operator needs to chase the drift survives.
 */
function resolveStallLane(
  lane: string
): SyncLane | typeof SYNC_LANE_STALL_UNKNOWN {
  return narrowToClosedSet(SyncLane, lane) ?? SYNC_LANE_STALL_UNKNOWN;
}

/**
 * Narrow a reported kind onto the closed set. An absent or unrecognised value
 * resolves to `cursor_frozen`, matching the wording {@link describeStall} falls
 * back to for the same input, so the grouped field and the sentence can never
 * disagree about what a skewed producer reported.
 */
function resolveStallKind(kind: string | undefined): SyncLaneStallKind {
  return (
    narrowToClosedSet(SyncLaneStallKind, kind) ?? SyncLaneStallKind.CursorFrozen
  );
}

/**
 * Narrow a reported dead-letter basis onto the closed set, or `null` when it is
 * absent or a value this build has never heard of.
 *
 * Deliberately NOT folded onto a member the way {@link resolveStallKind} folds
 * an unknown kind onto `cursor_frozen`: a wrong KIND costs the sentence some
 * precision, whereas a wrong BASIS states that a live status count is a durable
 * ledger (or the reverse), which is the exact claim ISS-9744 removed.
 */
function resolveDeadLetteredBasis(
  basis: string | undefined
): SyncLaneDeadLetteredBasis | null {
  return narrowToClosedSet(SyncLaneDeadLetteredBasis, basis);
}

/**
 * ISS-9744: the dead-letter clause the operator reads.
 *
 * It used to be a bare `(15 dead-lettered)`, which an operator reasonably read
 * as "15 items are lost, go get them". Two of the lanes cannot support that
 * reading: their count is a `GROUP BY status` row count that a redrive lowers
 * — it was observed going 13 -> 7 -> 5 on `invocation_parts` — and a number
 * that decreases is not a count of permanently-lost items. So the clause states
 * the instant it describes and the population it counted, and never claims a
 * total.
 */
function describeDeadLettered(
  count: number,
  basis: string | undefined
): string {
  const resolved = resolveDeadLetteredBasis(basis);
  if (resolved === SyncLaneDeadLetteredBasis.NoDeadLetterState) {
    // This lane has no give-up state, so the `0` is structural. Printing
    // "0 dead-lettered" invites the reader to treat it as a measurement that
    // could have been non-zero.
    return "no dead-letter state on this lane";
  }
  if (resolved === SyncLaneDeadLetteredBasis.Unmeasured) {
    // The count is a placeholder the store returned without querying anything.
    // Rendering it would be the fabricated zero in its purest form — and this is
    // the gate-shut alert, whose whole subject is a machine with no source key.
    return "dead-lettered not measured this sample";
  }
  const source = describeDeadLetteredSource(resolved);
  return `${count} dead-lettered right now (${source}, not a cumulative loss total)`;
}

/** How the count was obtained, or an explicit "the producer did not say". */
function describeDeadLetteredSource(
  basis: SyncLaneDeadLetteredBasis | null
): string {
  if (basis === SyncLaneDeadLetteredBasis.AbandonedIdLedger) {
    return "durable abandoned-id ledger";
  }
  if (basis === SyncLaneDeadLetteredBasis.QueueStatusCount) {
    return "live queue status count";
  }
  return "basis unknown";
}

/**
 * ISS-5973: how many items the lane still owed, or an explicit "unknown".
 *
 * Never renders a fabricated `0` for an unmeasurable queue — a stall alert that
 * says "0 items remaining" reads as the opposite of the condition it reports.
 */
function describeItemsRemaining(
  itemsRemaining: number | null,
  isLowerBound: boolean
): string {
  if (itemsRemaining === null) {
    return "unknown";
  }
  // A bounded probe that capped out knows only "at least this many". Printing
  // the capped value bare is the same reassuring lie as a fabricated zero — a
  // 3,500-session backlog must not page as `200 item(s) still owed`.
  return isLowerBound ? `>=${itemsRemaining}` : String(itemsRemaining);
}

/**
 * ISS-5973: the alert line for whichever stall this is.
 *
 * Each kind this build KNOWS gets its own sentence, because the operator action
 * differs: a frozen cursor means uploads are landing and not being recorded, a
 * no-progress lane means a live queue is not being worked, a shut gate
 * (ISS-8768) means this machine is not delivering AT ALL and the fix is its
 * registration or credential rather than the queue, and a failing resume read
 * (ISS-9823) means a DURABLE READ is broken — most often an unapplied migration
 * — so the queue is never even reached.
 *
 * Only an ABSENT or genuinely unrecognised kind — a value a newer build sends
 * that this one has never heard of — falls through to the original ISS-5387
 * sentence. That default is safe for version skew, where precision is the only
 * thing lost; it is NOT safe for a kind this build can name, because the
 * fallback sentence asserts a motionless durable cursor, which for a gated lane
 * is a claim about a lane that never ran and points triage at the wrong runbook.
 */
function describeStall(input: SyncLaneStallTelemetryInput): string {
  if (input.kind === SyncLaneStallKind.NoProgress) {
    return `Sync lane ${input.lane} is running with ${describeItemsRemaining(input.itemsRemaining ?? null, input.itemsRemainingIsLowerBound ?? false)} item(s) still owed and completed 0 unit(s) across consecutive samples (${describeDeadLettered(input.deadLetteredCount, input.deadLetteredBasis)}). Local data is not reaching the cloud.`;
  }
  if (input.kind === SyncLaneStallKind.GateShutWithBacklog) {
    return `Sync lane ${input.lane} is NOT RUNNING while this machine is consented to deliver, with ${describeItemsRemaining(input.itemsRemaining ?? null, input.itemsRemainingIsLowerBound ?? false)} item(s) still owed (${describeDeadLettered(input.deadLetteredCount, input.deadLetteredBasis)}). Local data is not reaching the cloud, and the lane is not trying — check this machine's compute-target registration and credential.`;
  }
  if (input.kind === SyncLaneStallKind.ResumeReadFailed) {
    // The remainder is stated and then disowned in the same breath, because on
    // the device this alert exists for it is `0`: the abort returns before the
    // enqueue, so nothing is ever written and the count measures the fault
    // rather than the backlog. An unqualified "0 item(s) still owed" on a stall
    // alert reads as the opposite of the condition it reports.
    return `Sync lane ${input.lane} is RUNNING but cannot read its persisted resume state, so every pass is abandoned before it can enqueue anything. Its measured remainder of ${describeItemsRemaining(input.itemsRemaining ?? null, input.itemsRemainingIsLowerBound ?? false)} item(s) is not evidence that it is caught up (${describeDeadLettered(input.deadLetteredCount, input.deadLetteredBasis)}). Local data is not reaching the cloud — a durable read is failing, so check this machine for an unapplied desktop migration.`;
  }
  return `Sync lane ${input.lane} completed ${input.workCompletedSincePrevious} unit(s) with a durable cursor that did not advance (${describeCursorAge(input.durableCursorAgeMs)}, ${describeDeadLettered(input.deadLetteredCount, input.deadLetteredBasis)})`;
}
