/**
 * @file transcript-byte-progress.ts
 * @description ISS-8506 - move progress against a byte inventory without ever
 * letting the bar lie.
 *
 * TWO LANES, TWO POLICIES, and the difference is not inconsistency:
 *
 *  - **Parse** compares raw bytes to raw bytes. Numerator and denominator come
 *    out of the same enumeration in the same unit, so a numerator that outruns
 *    its total is genuinely impossible and means the producer is wrong. It is
 *    REJECTED to indeterminate, following the ruling recorded in
 *    `maintenance-progress-state.ts`: clamping `101/100` to `100/100`
 *    manufactures exactly the false completion the state exists to prevent.
 *  - **Upload** compares the server's acked cursor over the REDACTED object to
 *    the raw on-disk size. Those differ by construction, so an over-total ratio
 *    is expected noise rather than corruption. It is CLAMPED for display. The
 *    inventory is never invalidated by it - rejecting a legitimately completing
 *    upload would manufacture a false failure, which is the same defect wearing
 *    the other mask.
 *
 * Clamping is not a licence to launder bad input. A row whose cursor is
 * negative, fractional or past the safe-integer range is DROPPED and counted,
 * never summed: that is a corrupt record, not redaction noise.
 *
 * MONOTONICITY. The acceptance criterion is "monotonic within one inventory
 * revision and never exceeding their applicable totals", and both halves hold:
 *
 *  - A stale revision no-ops entirely (`collector-manager-pass-scan.ts`'s
 *    `isImportActive` generation guard), so a superseded sweep cannot write.
 *  - Each lane keeps a HIGH-WATER mark scoped to the revision. Rejection
 *    withdraws the stated number without lowering the mark, so the sequence
 *    100 -> indeterminate -> 50 reports 100, never 50. Without the mark,
 *    "withdraw then re-state lower" is a decrease wearing a disguise.
 *  - A new revision resets the mark, which is what "within one revision" means.
 */

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { isCountablePopulation } from "../../shared/maintenance-progress-contract.js";
import {
  type TranscriptByteInventory,
  TranscriptInventoryCompleteness,
} from "./transcript-byte-inventory-types.js";
import {
  transcriptCursorMatchesComputeTarget,
  transcriptQueueKey,
} from "./transcript-sync-types.js";
import {
  projectUploadBytes,
  UploadProjectionKind,
} from "./transcript-upload-projection.js";

export const ByteProgressKind = {
  /** A real ratio over a real population. */
  Measured: "measured",
  /**
   * The population is genuinely zero - nothing to parse or send.
   *
   * A distinct state rather than `0 / 0`, deliberately. `isCountablePopulation`
   * refuses `total === 0` because a zero population cannot honestly render as a
   * percentage, and that judgement is right: showing 0% understates (there is
   * nothing outstanding) and 100% overstates (nothing was done). "Nothing to do"
   * is a third fact, so it gets a third state instead of a widened predicate.
   */
  Empty: "empty",
  /** We had a number and no longer trust it, or never had one. */
  Indeterminate: "indeterminate",
  /** This level sends no transcripts, so upload progress does not apply. */
  NotApplicable: "not-applicable",
} as const;
export type ByteProgressKind =
  (typeof ByteProgressKind)[keyof typeof ByteProgressKind];

export type ParseProgressState =
  | {
      kind: typeof ByteProgressKind.Measured;
      processedBytes: number;
      totalBytes: number;
      ratio: number;
    }
  | { kind: typeof ByteProgressKind.Empty }
  | { kind: typeof ByteProgressKind.Indeterminate };

/** One `TranscriptSyncState` row, projected to what progress needs. */
export type TranscriptUploadCursor = {
  externalSessionId: string;
  fileKey: string;
  /**
   * The server's acked byte offset for this file - a cache of server truth, not
   * a local guess, so it is safe to read as "how much has actually landed".
   */
  syncedByteOffset: number;
  /**
   * Whether the executor considers this file caught up
   * (`syncedByteOffset >= planEndOffset`). Carried rather than recomputed
   * because `planEndOffset` is not persisted per file - and it does not need to
   * be, since the per-file caught-up state plus the cursor is enough.
   */
  caughtUp: boolean;
  /**
   * Which compute target the cached cursor belongs to.
   *
   * Load-bearing, not decoration. The persisted cursor is target-scoped
   * precisely "so an account/machine switch never reuses another target's
   * offset" (`schema.prisma`), so summing rows keyed only on
   * `(externalSessionId, fileKey)` would credit THIS machine with bytes a
   * different one uploaded - a progress bar that starts part-full on a fresh
   * install.
   */
  syncedComputeTargetId: string | null;
};

export type UploadProgressState =
  | {
      kind: typeof ByteProgressKind.Measured;
      sentBytes: number;
      totalBytes: number;
      ratio: number;
      /** True when every eligible file is caught up, whatever the ratio says. */
      complete: boolean;
    }
  | { kind: typeof ByteProgressKind.Empty }
  | {
      kind: typeof ByteProgressKind.Indeterminate;
      /**
       * Cursor rows discarded as corrupt, when that is WHY this is
       * indeterminate.
       *
       * It lives on this member and not on `Measured` because a dropped row
       * cannot coexist with a stated numerator: the sum is short by an amount
       * nobody can know, so there is no honest `sentBytes` to carry it beside.
       * Omitted when the indeterminacy has another cause, so absence means "not
       * this reason" rather than "zero corrupt rows".
       */
      droppedRows?: number;
    }
  | { kind: typeof ByteProgressKind.NotApplicable };

/** A revision-scoped fold. `report` no-ops on a superseded revision. */
export type ParseProgressFold = {
  report: (revision: number, processedBytes: number) => ParseProgressState;
  current: () => ParseProgressState;
};

export type UploadProgressFold = {
  report: (
    revision: number,
    cursors: readonly TranscriptUploadCursor[]
  ) => UploadProgressState;
  current: () => UploadProgressState;
};

/**
 * Parse-byte progress against one inventory.
 *
 * A `partial` PARSE lane MEASURES, over the bytes it did see (ISS-8346 ruling
 * of 2026-09-04). `eligibleParseBytes` is an honest total of the measured set
 * and the numerator comes from parsing that same set, so the ratio describes a
 * real population; the shortfall travels beside it as the inventory's own
 * completeness rather than by withholding every number. Refusing here instead
 * cost an ordinary machine its whole byte figure over one impaired probe.
 *
 * The short denominator is still not laundered. An impaired file that settles
 * and gets parsed anyway drives the numerator past the total, and
 * `isCountablePopulation` withdraws to indeterminate at that point - the
 * refusal fires when the overrun actually happens rather than pre-emptively.
 *
 * Only `unavailable` is permanently indeterminate. The upload lane's
 * completeness is not consulted — an unmaterialized OpenCode projection is an
 * upload-lane gap and must not withhold the parse number.
 */
export function createParseProgress(
  inventory: TranscriptByteInventory
): ParseProgressFold {
  const usable = canStateParseTotal(inventory);
  const totalBytes = inventory.eligibleParseBytes;
  let highWaterBytes = 0;
  let state: ParseProgressState = initialParseState(usable, totalBytes);

  const report = (revision: number, processedBytes: number) => {
    if (revision !== inventory.inventoryRevision || !usable) {
      return state;
    }
    if (totalBytes === 0) {
      // Nothing to parse, so 0 is the only honest report. A producer claiming
      // it processed bytes from an empty corpus has reported something
      // impossible, and swallowing that would sweep a real corrupt-input signal
      // under the rug just because the population happens to be zero.
      if (processedBytes !== 0) {
        state = { kind: ByteProgressKind.Indeterminate };
      }
      return state;
    }
    if (!isCountablePopulation(processedBytes, totalBytes)) {
      // The claim is withdrawn, not lowered. The high-water mark survives, so a
      // later valid report cannot come back below what was already stated.
      state = { kind: ByteProgressKind.Indeterminate };
      return state;
    }
    highWaterBytes = Math.max(highWaterBytes, processedBytes);
    state = {
      kind: ByteProgressKind.Measured,
      processedBytes: highWaterBytes,
      totalBytes,
      ratio: highWaterBytes / totalBytes,
    };
    return state;
  };

  return { report, current: () => state };
}

/**
 * Uploaded-byte progress for one data-sync level.
 *
 * Pre-consent is a first-class case, not an edge case: with no rows at all,
 * `sent` is 0 and `total` is the eligible raw bytes. "0 of 2.4 GB" is TRUE
 * before consent - nothing has been sent - and reporting `unknown` there would
 * hide a number we actually have.
 *
 * That "0 of N" is conditional on a complete UPLOAD lane, and one ordinary
 * machine does not have one before consent: OpenCode installed, projection not
 * yet materialized. Only the sync sweeper writes that projection
 * (`transcript-discovery-sweep.ts`, behind the FEA-3463 tier gate), so its size
 * is unknowable until the user has chosen a policy - at which point the sweep
 * runs and the next inventory has it. Under `Full` this function returns
 * `Indeterminate` on that machine, and a consumer (ISS-8346, ISS-8376) must
 * treat that as a REACHABLE state for a healthy machine, not an error path.
 * The parse lane is unaffected: the "we found N GB" number counts
 * `opencode.db` directly and stays complete (ruling of 2026-09-02 on #6451).
 */
export function summarizeUploadProgress(
  inventory: TranscriptByteInventory,
  cursors: readonly TranscriptUploadCursor[],
  level: DataSyncLevel,
  computeTargetId: string
): UploadProgressState {
  const projection = projectUploadBytes(inventory, level);
  if (projection.kind === UploadProjectionKind.NotApplicable) {
    return { kind: ByteProgressKind.NotApplicable };
  }
  if (projection.kind === UploadProjectionKind.Unknown) {
    return { kind: ByteProgressKind.Indeterminate };
  }
  if (projection.eligibleFiles.length === 0 || projection.totalBytes === 0) {
    return { kind: ByteProgressKind.Empty };
  }

  const eligibleKeys = new Set(
    projection.eligibleFiles.map((file) =>
      transcriptQueueKey(file.externalSessionId, file.fileKey)
    )
  );
  const caughtUpKeys = new Set<string>();
  let sentBytes = 0;
  let droppedRows = 0;
  for (const cursor of cursors) {
    const key = transcriptQueueKey(cursor.externalSessionId, cursor.fileKey);
    if (!eligibleKeys.has(key)) {
      // A row for a file outside this revision's eligible set. Not corrupt -
      // just not part of this measurement's population.
      continue;
    }
    if (
      !transcriptCursorMatchesComputeTarget(
        cursor.syncedComputeTargetId,
        computeTargetId
      )
    ) {
      // Another compute target's cursor, or a pre-redaction one the executor
      // already treats as stale. Neither is progress THIS machine has made, and
      // neither is corrupt - so it contributes nothing and is not a dropped row.
      continue;
    }
    if (!isUsableCursor(cursor.syncedByteOffset)) {
      droppedRows += 1;
      continue;
    }
    sentBytes += cursor.syncedByteOffset;
    if (cursor.caughtUp) {
      caughtUpKeys.add(key);
    }
  }

  if (droppedRows > 0) {
    // A corrupt row is dropped from the sum, so the numerator is short by an
    // amount that is unknowable by construction - the offset we refused to
    // trust IS the missing quantity. Stating the short sum anyway would be the
    // silently-understated total this ticket exists to refuse, and it is what
    // the inventory already refuses when ONE file fails to `lstat`.
    return { kind: ByteProgressKind.Indeterminate, droppedRows };
  }

  // Completion is a STATE, not arithmetic. Every eligible file acked by the
  // server means the upload is finished, whatever the raw-vs-redacted byte
  // ratio reads - 99.99% with everything caught up is 100%.
  const complete = caughtUpKeys.size === eligibleKeys.size;
  // BOTH renderable numbers follow that state, not just the ratio, and they
  // follow it in BOTH directions. The acked cursor is over the REDACTED object
  // while the total is raw on-disk size, so the sum overshoots and undershoots
  // for the same reason - and the undershoot is the common case, because
  // redaction and the executor's cut-at-last-newline usually leave the acked
  // object smaller. Raising the ratio alone leaves a consumer rendering this
  // module's own "N of M" framing as "998 B of 1000 B" beside a full bar and a
  // complete flag, which is the same lie as "1.2 KB of 1000 B".
  const ratio = complete
    ? 1
    : Math.min(1, Math.max(0, sentBytes / projection.totalBytes));
  const renderableSentBytes = complete
    ? projection.totalBytes
    : Math.min(projection.totalBytes, Math.max(0, sentBytes));
  return {
    kind: ByteProgressKind.Measured,
    sentBytes: renderableSentBytes,
    totalBytes: projection.totalBytes,
    ratio,
    complete,
  };
}

/**
 * The revision-scoped, high-water form of {@link summarizeUploadProgress}.
 *
 * The mark is kept in BYTES rather than as a ratio. Carrying it as a ratio and
 * multiplying back by the total reconstitutes a fractional byte count, which is
 * not a thing a byte cursor can be — the mark has to be in the same unit as the
 * value it guards.
 *
 * Completion is sticky within a revision for the same reason the mark is: the
 * inventory is fixed, so a set the server has already acked in full cannot
 * later be less than finished.
 */
export function createUploadProgress(
  inventory: TranscriptByteInventory,
  level: DataSyncLevel,
  computeTargetId: string
): UploadProgressFold {
  let highWaterSentBytes = 0;
  let everComplete = false;
  let state: UploadProgressState = summarizeUploadProgress(
    inventory,
    [],
    level,
    computeTargetId
  );

  const report = (
    revision: number,
    cursors: readonly TranscriptUploadCursor[]
  ) => {
    if (revision !== inventory.inventoryRevision) {
      return state;
    }
    const next = summarizeUploadProgress(
      inventory,
      cursors,
      level,
      computeTargetId
    );
    if (next.kind !== ByteProgressKind.Measured) {
      state = next;
      return state;
    }
    highWaterSentBytes = Math.max(highWaterSentBytes, next.sentBytes);
    everComplete = everComplete || next.complete;
    state = {
      ...next,
      // Same rule as the summary: a complete upload reports its total, so the
      // sticky flag cannot outlive the number beside it.
      sentBytes: everComplete ? next.totalBytes : highWaterSentBytes,
      complete: everComplete,
      ratio: everComplete
        ? 1
        : Math.min(1, Math.max(0, highWaterSentBytes / next.totalBytes)),
    };
    return state;
  };

  return { report, current: () => state };
}

/**
 * Whether a persisted cursor is a real byte count.
 *
 * `Number.isSafeInteger` is the whole guard against fractional, non-finite and
 * precision-lost values in one predicate; negatives are impossible for an
 * offset. A row failing this is corrupt, and summing it would put a fabricated
 * figure into a number a user reads.
 */
function isUsableCursor(syncedByteOffset: number): boolean {
  return Number.isSafeInteger(syncedByteOffset) && syncedByteOffset >= 0;
}

/** A measurable inventory with nothing to parse is `empty`, not zero-of-zero. */
function initialParseState(
  usable: boolean,
  totalBytes: number
): ParseProgressState {
  if (!usable) {
    return { kind: ByteProgressKind.Indeterminate };
  }
  if (totalBytes === 0) {
    return { kind: ByteProgressKind.Empty };
  }
  return {
    kind: ByteProgressKind.Measured,
    processedBytes: 0,
    totalBytes,
    ratio: 0,
  };
}

/**
 * Whether this inventory measured a parse population a fold may state.
 *
 * The ISS-8346 ruling of 2026-09-04 in one predicate, shared with
 * `transcript-analysis-eta.ts` so the two folds cannot drift apart on it. A
 * `partial` lane measured something and states it; an `unavailable` one
 * measured nothing and cannot.
 *
 * A `partial` lane holding ZERO eligible bytes is NOT the measuring case, and
 * the ruling says so in its own words - it covers a lane where bytes WERE
 * measured. Nothing was, and something was missed, so `empty` there would read
 * as "no transcripts to analyse, finished" on a machine whose only probe
 * failed: a false completion, not a real zero. Only a `complete` lane may claim
 * an empty corpus.
 */
export function canStateParseTotal(
  inventory: TranscriptByteInventory
): boolean {
  if (
    inventory.parseCompleteness === TranscriptInventoryCompleteness.Complete
  ) {
    return true;
  }
  return (
    inventory.parseCompleteness === TranscriptInventoryCompleteness.Partial &&
    inventory.eligibleParseBytes > 0
  );
}
