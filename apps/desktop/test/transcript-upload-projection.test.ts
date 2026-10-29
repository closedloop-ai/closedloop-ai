/**
 * @file transcript-upload-projection.test.ts
 * @description ISS-8506 — the applicable upload total per data-sync level.
 * Pins the two refusals that keep it honest: a short measurement states no
 * total at any level, and a level that sends no transcripts does not inherit
 * the full-session number.
 */
import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import {
  type TranscriptByteInventory,
  TranscriptByteLane,
  TranscriptExclusionReason,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { ARCHIVE_CAPABLE_HARNESSES } from "../src/main/transcript-sync/transcript-harness-probe.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  projectUploadBytes,
  UploadProjectionKind,
  UploadTotalUnavailableReason,
} from "../src/main/transcript-sync/transcript-upload-projection.js";

function inventory(
  overrides: Partial<TranscriptByteInventory> = {}
): TranscriptByteInventory {
  return {
    inventoryRevision: 1,
    parseCompleteness: TranscriptInventoryCompleteness.Complete,
    uploadCompleteness: TranscriptInventoryCompleteness.Complete,
    evidence: [
      {
        harness: TranscriptSourceHarness.Claude,
        outcome: TranscriptHarnessOutcome.Measured,
      },
    ],
    impairments: [],
    enumeratedHarnesses: ARCHIVE_CAPABLE_HARNESSES,
    discoveredBytes: 1000,
    eligibleParseBytes: 1000,
    excludedBytes: 0,
    exclusionsByReason: {
      [TranscriptExclusionReason.Unreadable]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Symlink]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.NotRegularFile]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Unstable]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Empty]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.ImplausibleSize]: { files: 0, bytes: 0 },
    },
    physicalBytes: 1000,
    attributableRawBytes: 1000,
    sessionsByHarness: [],
    uploadExclusionsByReason: {
      [TranscriptExclusionReason.Unreadable]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Symlink]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.NotRegularFile]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Unstable]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.Empty]: { files: 0, bytes: 0 },
      [TranscriptExclusionReason.ImplausibleSize]: { files: 0, bytes: 0 },
    },
    eligibleFiles: [
      {
        externalSessionId: "sess-1",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        bytes: 1000,
      },
    ],
    ...overrides,
  };
}

test("Full projects the measured attributable raw bytes", () => {
  const projection = projectUploadBytes(inventory(), DataSyncLevel.Full);

  assert.equal(projection.kind, UploadProjectionKind.Measured);
  assert.equal(
    projection.kind === UploadProjectionKind.Measured
      ? projection.totalBytes
      : null,
    1000
  );
});

test("levels that send no transcripts state no total and do not inherit Full's", () => {
  // "Metadata-only" has no transcript upload, so there is no upload for a total
  // to be a total OF. Reporting Full's number here would tell a metadata-only
  // user that a gigabyte is queued to leave their machine.
  for (const level of [
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Redacted,
  ]) {
    const projection = projectUploadBytes(inventory(), level);
    assert.equal(
      projection.kind,
      UploadProjectionKind.NotApplicable,
      `expected ${level} to project no total`
    );
    assert.notEqual(projection.kind, UploadProjectionKind.Measured);
  }
});

test("a partial inventory states no total at ANY level, Full included", () => {
  // The fabricated-total defect one layer down: returning the measured PREFIX
  // of a truncated or permission-blocked sweep as a confident total.
  const partial = inventory({
    uploadCompleteness: TranscriptInventoryCompleteness.Partial,
    impairments: [
      {
        reason: TranscriptImpairmentReason.RootBlocked,
        harness: TranscriptSourceHarness.Codex,
        path: "~/.codex/sessions",
      },
    ],
  });

  const projection = projectUploadBytes(partial, DataSyncLevel.Full);

  assert.equal(projection.kind, UploadProjectionKind.Unknown);
  assert.equal(
    projection.kind === UploadProjectionKind.Unknown ? projection.reason : null,
    UploadTotalUnavailableReason.IncompleteInventory
  );
});

test("an unavailable inventory states no total at Full", () => {
  const unavailable = inventory({
    uploadCompleteness: TranscriptInventoryCompleteness.Unavailable,
  });

  assert.equal(
    projectUploadBytes(unavailable, DataSyncLevel.Full).kind,
    UploadProjectionKind.Unknown
  );
});

test("a short PARSE lane alone does not withhold the upload total", () => {
  // The two lanes read different files for OpenCode, so their completeness is
  // independent. A parse-only gap (an unreadable `opencode.db`) says nothing
  // about what the archive lane can send.
  const projection = projectUploadBytes(
    inventory({ parseCompleteness: TranscriptInventoryCompleteness.Partial }),
    DataSyncLevel.Full
  );

  assert.equal(projection.kind, UploadProjectionKind.Measured);
});

test("an unmaterialized OpenCode projection withholds the upload total", () => {
  // The pre-consent machine with OpenCode installed, as a hand-built fixture:
  // the projection is not measured, so this must not state a total the
  // sweeper has not yet made knowable. (That the parse lane stays complete on
  // that machine is the inventory suite's assertion, not this one's.)
  const preConsent = inventory({
    parseCompleteness: TranscriptInventoryCompleteness.Complete,
    uploadCompleteness: TranscriptInventoryCompleteness.Partial,
    impairments: [
      {
        reason: TranscriptImpairmentReason.OpencodeUnmaterialized,
        harness: TranscriptSourceHarness.OpenCode,
        path: "~/state/transcript-materialized/opencode",
        lane: TranscriptByteLane.Upload,
      },
    ],
  });

  const projection = projectUploadBytes(preConsent, DataSyncLevel.Full);

  assert.equal(projection.kind, UploadProjectionKind.Unknown);
  assert.equal(
    projectUploadBytes(preConsent, DataSyncLevel.Metadata).kind,
    UploadProjectionKind.Unknown,
    "unknown outranks not-applicable, as for every other short upload lane"
  );
});

test("the gate follows dataSyncLevelToBooleans rather than a second policy map", () => {
  // Redacted currently derives Metadata's booleans because the redaction lane is
  // not plumbed. When it flips in that one SSOT function this projection must
  // follow with no edit here, which is only true if it reads the gate rather
  // than restating it.
  const measured = projectUploadBytes(inventory(), DataSyncLevel.Full);
  const redacted = projectUploadBytes(inventory(), DataSyncLevel.Redacted);

  assert.equal(measured.kind, UploadProjectionKind.Measured);
  assert.equal(redacted.kind, UploadProjectionKind.NotApplicable);
});
