/**
 * @file transcript-byte-inventory-parse.ts
 * @description ISS-8376 — the runtime guard for an inventory arriving from the
 * sweep worker.
 *
 * A `worker_threads` reply crosses a structured-clone boundary, so the types
 * that hold inside one thread constrain nothing about what lands in the other:
 * root `AGENTS.md` names IPC/worker payloads alongside JSON and persisted rows
 * as a place malformed input is reachable at runtime and MUST be tested. Before
 * this guard the runner cast the reply and handed it straight on, so an `ok`
 * reply carrying `{}` was stored as a MEASUREMENT and the first read threw on
 * `enumeratedHarnesses.map` — a crash in the IPC handler instead of the
 * `unavailable` answer the design already has a state for.
 *
 * WHAT IS CHECKED, AND WHY NOT EVERYTHING. The eleven fields any consumer
 * downstream of the runner actually reads — the projection in
 * `onboarding-local-state-source.ts` and the three the ETA fold reads
 * (`inventoryRevision`, `eligibleParseBytes`, `parseCompleteness`) — are
 * validated in full, closed enums included, because an unrecognized member
 * survives the projection as `undefined` and blanks the whole measured
 * inventory at the renderer's parse. The four collections nobody downstream
 * reads are checked for container shape only: `eligibleFiles` can hold 20,000
 * rows, and parsing each one on the main thread would re-import the cost this
 * worker exists to move off it.
 */

import { z } from "zod";
import type { TranscriptByteInventory } from "./transcript-byte-inventory-types.js";
import {
  TranscriptHarnessOutcome,
  TranscriptInventoryCompleteness,
} from "./transcript-byte-inventory-types.js";
import { TranscriptSourceHarness } from "./transcript-sync-types.js";

/**
 * A byte or count field that can be believed.
 *
 * The same predicate the wire boundary applies, for the same reason: a bare
 * `z.number()` accepts `-1`, `NaN`, `1.5` and magnitudes past the safe-integer
 * range, every one of which renders downstream as a confident number of GB.
 */
const inventoryByteCount = z
  .number()
  .refine(Number.isSafeInteger)
  .nonnegative();

const harnessValue = z.enum([
  TranscriptSourceHarness.Claude,
  TranscriptSourceHarness.Codex,
  TranscriptSourceHarness.OpenCode,
]);

const completenessValue = z.enum([
  TranscriptInventoryCompleteness.Complete,
  TranscriptInventoryCompleteness.Partial,
  TranscriptInventoryCompleteness.Unavailable,
]);

const outcomeValue = z.enum([
  TranscriptHarnessOutcome.Measured,
  TranscriptHarnessOutcome.Absent,
  TranscriptHarnessOutcome.Disabled,
  TranscriptHarnessOutcome.Impaired,
]);

/**
 * Container-shape only: present and of the right kind, elements unread.
 *
 * Named rather than inlined so the witness below can say, per field, that the
 * looseness is a decision and not an omission.
 */
const unreadCollection = z.array(z.unknown());
const unreadTally = z.record(z.string(), z.unknown());

const inventorySchema = z.looseObject({
  inventoryRevision: inventoryByteCount,
  parseCompleteness: completenessValue,
  uploadCompleteness: completenessValue,
  evidence: z.array(
    z.looseObject({ harness: harnessValue, outcome: outcomeValue })
  ),
  enumeratedHarnesses: z.array(harnessValue),
  discoveredBytes: inventoryByteCount,
  eligibleParseBytes: inventoryByteCount,
  excludedBytes: inventoryByteCount,
  physicalBytes: inventoryByteCount,
  attributableRawBytes: inventoryByteCount,
  // VALIDATED, not container-shape: onboarding renders these counts and sums
  // them into the total it states, so a fractional or negative one arriving
  // from a broken worker reply would be published as a session count.
  sessionsByHarness: z
    .array(
      z.looseObject({
        harness: harnessValue,
        // POSITIVE, not merely non-negative. The producer omits a harness it could
        // not count, so a `0` arriving here is a producer that decided to state
        // an absence it never measured — the one value this field must never
        // carry, and the byte predicate alone would let it through.
        sessionCount: inventoryByteCount.refine((count) => count > 0),
      })
    )
    // One row per harness, which no per-entry check can see. The producer folds
    // over a Map keyed by harness so it cannot emit a duplicate today; this
    // guard exists because the whole point of a boundary validator is not to
    // take the producer's word for it, and downstream both rows would render
    // and both would be summed.
    .refine(
      (rows) => new Set(rows.map((row) => row.harness)).size === rows.length
    ),
  impairments: unreadCollection,
  eligibleFiles: unreadCollection,
  exclusionsByReason: unreadTally,
  uploadExclusionsByReason: unreadTally,
});

/**
 * Compile-time proof that the guard classifies every producer field.
 *
 * Derived from `keyof TranscriptByteInventory` and checked against the schema's
 * own `.shape`, so a field added to the producer fails `tsc` HERE until someone
 * decides whether it is read downstream (validate it) or not (give it a
 * container-shape entry). Without this a new field would arrive unchecked and
 * the guard would keep reporting the payload as sound.
 */
const INVENTORY_GUARD_KEY_WITNESS: Record<
  keyof TranscriptByteInventory,
  z.ZodTypeAny
> = inventorySchema.shape;

/**
 * Whether `value` is an inventory this build can believe.
 *
 * A PREDICATE rather than a parse that returns its own output: `z.looseObject`
 * and the two container-shape entries widen the inferred type away from
 * `TranscriptByteInventory`, and the parsed clone would copy 20,000
 * `eligibleFiles` rows to no purpose. Returning the caller's own object keeps
 * both the type and the identity. Nothing untrusted supplies a KEY here — the
 * tally keys are this module's own constants and the file paths are values —
 * so the prototype-key hazard that makes safeParse-as-predicate unsafe at an
 * ingress boundary does not arise.
 */
export function isTranscriptByteInventory(
  value: unknown
): value is TranscriptByteInventory {
  return inventorySchema.safeParse(value).success;
}

export { INVENTORY_GUARD_KEY_WITNESS };
