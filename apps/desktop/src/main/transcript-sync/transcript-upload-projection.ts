/**
 * @file transcript-upload-projection.ts
 * @description ISS-8506 - how many raw bytes the SELECTED data-sync level would
 * actually upload.
 *
 * The applicable total is the raw on-disk size of the files the selected policy
 * would send. Raw bytes are the total, full stop. Redaction is not
 * length-preserving - `[REDACTED:<label>]` can be longer than the token it
 * replaces, and the executor cuts at the last newline - so the uploaded object
 * lands on either side of the raw size. That delta is a few bytes per secret
 * plus one partial line; for a progress figure it is noise, and the upload lane
 * absorbs it by clamping rather than by rejecting real data.
 *
 * The gate is `dataSyncLevelToBooleans`, not a second map. That function is
 * already the SSOT for level -> behaviour and is already an exhaustive `switch`
 * over all four members, so a fifth level is already a compile error there. A
 * second policy map keyed on the same enum would be a third declaration of one
 * decision and the two would eventually disagree.
 *
 * The four levels collapse to two answers here, and `Redacted` sharing
 * `Metadata`'s is not an oversight: the redaction lane is not plumbed yet, so
 * `Redacted` honestly behaves as metadata-only today. When it ships, its
 * `transcriptSyncEnabled` flips in ONE place and this projection follows with no
 * edit.
 */
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { dataSyncLevelToBooleans } from "../../shared/data-sync-level.js";
import {
  type TranscriptByteInventory,
  type TranscriptEligibleFile,
  TranscriptInventoryCompleteness,
} from "./transcript-byte-inventory-types.js";

/** Why a projection has no number to state. */
export const UploadTotalUnavailableReason = {
  /** The measurement itself was short, so any total would understate. */
  IncompleteInventory: "incomplete-inventory",
} as const;
export type UploadTotalUnavailableReason =
  (typeof UploadTotalUnavailableReason)[keyof typeof UploadTotalUnavailableReason];

export const UploadProjectionKind = {
  /** A real, complete measurement of what this level would send. */
  Measured: "measured",
  /** This level uploads no transcripts at all, so there is no total to show. */
  NotApplicable: "not-applicable",
  /** We could not measure enough to state a total. */
  Unknown: "unknown",
} as const;
export type UploadProjectionKind =
  (typeof UploadProjectionKind)[keyof typeof UploadProjectionKind];

export type UploadBytesProjection =
  | {
      kind: typeof UploadProjectionKind.Measured;
      totalBytes: number;
      eligibleFiles: readonly TranscriptEligibleFile[];
    }
  | { kind: typeof UploadProjectionKind.NotApplicable }
  | {
      kind: typeof UploadProjectionKind.Unknown;
      reason: UploadTotalUnavailableReason;
    };

/**
 * Project the applicable upload total for one data-sync level.
 *
 * Two refusals, and they mean different things:
 *
 *  - A non-`complete` UPLOAD lane yields `unknown` at EVERY level, `Full`
 *    included. Returning the measured prefix of a truncated or permission-
 *    blocked sweep as a confident total is the same fabricated-total defect one
 *    layer down. It is the upload lane's completeness that is read, not the
 *    parse lane's: an unmaterialized OpenCode projection withholds this total
 *    while the "we found N GB" parse number beside it stays complete.
 *  - A level that sends no transcripts yields `not-applicable`, NOT zero and NOT
 *    `Full`'s total. "Metadata-only" does not inherit the full-session number;
 *    there is no upload for it to be a total OF.
 */
export function projectUploadBytes(
  inventory: TranscriptByteInventory,
  level: DataSyncLevel
): UploadBytesProjection {
  if (
    inventory.uploadCompleteness !== TranscriptInventoryCompleteness.Complete
  ) {
    return {
      kind: UploadProjectionKind.Unknown,
      reason: UploadTotalUnavailableReason.IncompleteInventory,
    };
  }
  if (!dataSyncLevelToBooleans(level).transcriptSyncEnabled) {
    return { kind: UploadProjectionKind.NotApplicable };
  }
  return {
    kind: UploadProjectionKind.Measured,
    totalBytes: inventory.attributableRawBytes,
    eligibleFiles: inventory.eligibleFiles,
  };
}
