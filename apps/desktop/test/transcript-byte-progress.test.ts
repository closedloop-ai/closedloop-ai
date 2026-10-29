/**
 * @file transcript-byte-progress.test.ts
 * @description ISS-8506 — the two progress lanes and why they disagree on
 * purpose. Parse rejects an impossible value; upload clamps an over-total one.
 * Both keep a high-water mark so a withdrawal cannot become a decrease.
 */
import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import {
  type TranscriptByteInventory,
  TranscriptExclusionReason,
  TranscriptHarnessOutcome,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import {
  ByteProgressKind,
  createParseProgress,
  createUploadProgress,
  summarizeUploadProgress,
  type TranscriptUploadCursor,
} from "../src/main/transcript-sync/transcript-byte-progress.js";
import { ARCHIVE_CAPABLE_HARNESSES } from "../src/main/transcript-sync/transcript-harness-probe.js";
import {
  redactedArchiveCursorTargetId,
  subagentFileKey,
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
  transcriptQueueKey,
} from "../src/main/transcript-sync/transcript-sync-types.js";

const REVISION = 4;

function inventory(
  overrides: Partial<TranscriptByteInventory> = {}
): TranscriptByteInventory {
  return {
    inventoryRevision: REVISION,
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
        bytes: 600,
      },
      {
        externalSessionId: "sess-2",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        bytes: 400,
      },
    ],
    ...overrides,
  };
}

const COMPUTE_TARGET = "compute-target-1";
// The persisted cursor records the REDACTED-domain target id, not the bare one:
// a bare id is a pre-FEA-3735 raw-domain cursor the executor treats as stale.
const SYNCED_TARGET = redactedArchiveCursorTargetId(COMPUTE_TARGET);

function cursor(
  externalSessionId: string,
  syncedByteOffset: number,
  caughtUp = false,
  fileKey = TRANSCRIPT_MAIN_FILE_KEY,
  syncedComputeTargetId: string | null = SYNCED_TARGET
): TranscriptUploadCursor {
  return {
    externalSessionId,
    fileKey,
    syncedByteOffset,
    caughtUp,
    syncedComputeTargetId,
  };
}

test("parse progress ignores a report carrying a superseded revision", () => {
  const fold = createParseProgress(inventory());

  fold.report(REVISION, 500);
  const stale = fold.report(REVISION - 1, 900);

  assert.equal(
    stale.kind === ByteProgressKind.Measured ? stale.processedBytes : null,
    500
  );
});

test("parse progress rejects an impossible value instead of clamping it", () => {
  // Numerator and denominator are the same unit here, so an over-total value is
  // genuinely impossible and means the producer is wrong. Clamping 1001/1000 to
  // 1000/1000 would manufacture the false completion the state exists to catch.
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 1001]) {
    const fold = createParseProgress(inventory());
    const state = fold.report(REVISION, bad);
    assert.equal(
      state.kind,
      ByteProgressKind.Indeterminate,
      `expected ${bad} to be rejected`
    );
  }
});

test("parse progress rejects a value past the safe-integer range", () => {
  const fold = createParseProgress(
    inventory({ eligibleParseBytes: Number.MAX_SAFE_INTEGER })
  );

  assert.equal(
    fold.report(REVISION, Number.MAX_SAFE_INTEGER + 2).kind,
    ByteProgressKind.Indeterminate
  );
});

test("a withdrawn parse claim cannot be re-stated lower within one revision", () => {
  // The high-water mark. Without it, "withdraw then re-state lower" is a
  // decrease wearing a disguise and the AC's monotonicity is not held.
  const fold = createParseProgress(inventory());

  fold.report(REVISION, 900);
  assert.equal(fold.report(REVISION, -5).kind, ByteProgressKind.Indeterminate);
  const recovered = fold.report(REVISION, 500);

  assert.equal(
    recovered.kind === ByteProgressKind.Measured
      ? recovered.processedBytes
      : null,
    900
  );
});

test("a new inventory revision starts a fresh high-water mark", () => {
  // Monotonicity is scoped WITHIN a revision, per the acceptance criterion, so
  // a re-measured corpus is allowed to start over.
  const first = createParseProgress(inventory());
  first.report(REVISION, 900);
  const second = createParseProgress(
    inventory({ inventoryRevision: REVISION + 1 })
  );

  const state = second.report(REVISION + 1, 100);

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.processedBytes : null,
    100
  );
});

test("a corpus with nothing to parse is empty, not zero of zero", () => {
  // `isCountablePopulation` refuses total === 0 because it cannot honestly
  // render as a percentage. That judgement is right, so this is a third state
  // rather than a widened predicate: 0% understates, 100% overstates.
  const fold = createParseProgress(inventory({ eligibleParseBytes: 0 }));

  assert.equal(fold.current().kind, ByteProgressKind.Empty);
  assert.equal(fold.report(REVISION, 0).kind, ByteProgressKind.Empty);
});

test("a short measurement still measures over the bytes it did see", () => {
  // ISS-8346 ruling 2026-09-04: partial measures over `eligibleParseBytes`.
  // One impaired probe used to cost the whole figure on an ordinary machine.
  const fold = createParseProgress(
    inventory({ parseCompleteness: TranscriptInventoryCompleteness.Partial })
  );

  const state = fold.report(REVISION, 500);

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.deepEqual(
    state.kind === ByteProgressKind.Measured
      ? {
          processedBytes: state.processedBytes,
          ratio: state.ratio,
          totalBytes: state.totalBytes,
        }
      : null,
    { processedBytes: 500, ratio: 0.5, totalBytes: 1000 }
  );
});

test("a measurement that saw nothing at all never yields a parse ratio", () => {
  // The half of the old rule the ISS-8346 ruling of 2026-09-04 keeps: nothing
  // was measured, so there is no population to state a ratio over.
  const fold = createParseProgress(
    inventory({
      parseCompleteness: TranscriptInventoryCompleteness.Unavailable,
    })
  );

  assert.equal(fold.current().kind, ByteProgressKind.Indeterminate);
  assert.equal(fold.report(REVISION, 500).kind, ByteProgressKind.Indeterminate);
});

test("a short measurement holding zero eligible bytes is indeterminate, not empty", () => {
  // The ISS-8346 ruling of 2026-09-04 covers a lane where bytes WERE measured.
  // None were here and something was missed, so `empty` would read as "no
  // transcripts to analyse, finished" on a machine whose only probe failed.
  const fold = createParseProgress(
    inventory({
      eligibleParseBytes: 0,
      parseCompleteness: TranscriptInventoryCompleteness.Partial,
    })
  );

  assert.equal(fold.current().kind, ByteProgressKind.Indeterminate);
  assert.equal(fold.report(REVISION, 0).kind, ByteProgressKind.Indeterminate);
});

test("a short measurement still rejects a numerator that outruns it", () => {
  // The short denominator is not laundered by measuring: an impaired file that
  // settles and gets parsed anyway pushes the numerator past the total, and the
  // refusal fires then rather than pre-emptively on every impaired machine.
  const fold = createParseProgress(
    inventory({ parseCompleteness: TranscriptInventoryCompleteness.Partial })
  );

  // Measuring first is load-bearing: without it this case reads as green on a
  // fold that refuses every partial report, which is the behaviour it exists to
  // distinguish itself from.
  assert.equal(fold.report(REVISION, 500).kind, ByteProgressKind.Measured);
  assert.equal(
    fold.report(REVISION, 1001).kind,
    ByteProgressKind.Indeterminate
  );
});

test("pre-consent reports a true zero against the real total, not unknown", () => {
  // Nothing has been sent yet, and that is a fact we measured. "0 of 1000" is
  // TRUE before consent; reporting unknown would hide a number we have.
  const state = summarizeUploadProgress(
    inventory(),
    [],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.deepEqual(
    state.kind === ByteProgressKind.Measured
      ? { sent: state.sentBytes, total: state.totalBytes, ratio: state.ratio }
      : null,
    { sent: 0, total: 1000, ratio: 0 }
  );
});

test("uploaded bytes past the raw total clamp to 100 percent", () => {
  // The numerator is the server's cursor over the REDACTED object; the
  // denominator is raw on-disk size. They differ by construction, so an
  // over-total ratio is expected noise, not corruption.
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 700), cursor("sess-2", 500)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.ratio : null,
    1
  );
});

test("an over-total sum clamps the sent bytes too, not only the ratio", () => {
  // Clamping only the ratio leaves the two renderable numbers contradicting
  // each other, and a consumer rendering this module's own "N of M" framing
  // prints "1.2 KB of 1000 B".
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 700), cursor("sess-2", 500)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
    1000
  );
  assert.equal(
    state.kind === ByteProgressKind.Measured
      ? state.sentBytes <= state.totalBytes
      : null,
    true
  );
});

test("an impossible report against an empty corpus is not swallowed", () => {
  // A producer claiming it parsed bytes from a corpus with none has reported
  // something impossible. Answering "empty" would sweep a real corrupt-input
  // signal under the rug just because the population happens to be zero.
  const fold = createParseProgress(inventory({ eligibleParseBytes: 0 }));

  assert.equal(fold.report(REVISION, 500).kind, ByteProgressKind.Indeterminate);
});

test("clamping an over-total ratio never invalidates the measurement", () => {
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 5000)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.notEqual(state.kind, ByteProgressKind.Indeterminate);
});

test("every eligible file caught up reports complete whatever the ratio says", () => {
  // Completion is a STATE, not arithmetic: 99.99% with everything server-acked
  // is 100%.
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 599, true), cursor("sess-2", 399, true)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.ratio : null,
    1
  );
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.complete : null,
    true
  );
});

test("one file short of caught up is not complete", () => {
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 600, true), cursor("sess-2", 200, false)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.complete : null,
    false
  );
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.ratio : null,
    0.8
  );
});

test("a corrupt cursor makes the whole numerator indeterminate", () => {
  // BEHAVIOUR CHANGE, and the expectation is what changed, not the code under
  // it: this used to return `Measured` with the corrupt row merely subtracted
  // and counted. Clamping absorbs redaction noise; it is not a licence to state
  // a sum that is short by an amount nobody can know — the offset we refused to
  // trust IS the missing quantity. The inventory already refuses this when ONE
  // file fails to `lstat`, and stating it here was the asymmetry.
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const state = summarizeUploadProgress(
      inventory(),
      [cursor("sess-1", bad), cursor("sess-2", 400)],
      DataSyncLevel.Full,
      COMPUTE_TARGET
    );
    assert.equal(
      state.kind,
      ByteProgressKind.Indeterminate,
      `expected ${bad} to make the sum indeterminate`
    );
    assert.equal(
      state.kind === ByteProgressKind.Indeterminate ? state.droppedRows : null,
      1,
      "the reason travels with the state, so it cannot be rendered as decoration"
    );
  }
});

test("indeterminate for another reason omits droppedRows rather than saying 0", () => {
  // Absence means "not this reason", not "zero corrupt rows" — the same
  // omit-don't-null contract the inventory impairments follow.
  const partial = { ...inventory(), uploadCompleteness: "partial" as const };
  const state = summarizeUploadProgress(
    partial,
    [],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Indeterminate);
  assert.equal("droppedRows" in state, false);
});

test("a cursor for a file outside the eligible set contributes nothing", () => {
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 600, true), cursor("other-session", 999, true)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
    600
  );
  // A stray row must not complete the set either.
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.complete : null,
    false
  );
});

test("a level that sends no transcripts has no upload progress at all", () => {
  for (const level of [
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Redacted,
  ]) {
    const state = summarizeUploadProgress(
      inventory(),
      [cursor("sess-1", 600, true)],
      level,
      COMPUTE_TARGET
    );
    assert.equal(
      state.kind,
      ByteProgressKind.NotApplicable,
      `expected ${level} to have no upload progress`
    );
  }
});

test("an unmaterialized OpenCode projection blocks upload progress and nothing else", () => {
  // The ordinary pre-consent machine with OpenCode installed, after the
  // 2026-09-02 ruling: the parse lane counts `opencode.db` and states its
  // number; the upload lane has no projection to size yet and says so under
  // Full. Under a level that sends nothing the existing precedence holds — an
  // unknown total outranks not-applicable, as for every short upload lane.
  const preConsent = inventory({
    parseCompleteness: TranscriptInventoryCompleteness.Complete,
    uploadCompleteness: TranscriptInventoryCompleteness.Partial,
  });

  const parse = createParseProgress(preConsent).report(REVISION, 250);
  assert.equal(parse.kind, ByteProgressKind.Measured);
  assert.equal(
    parse.kind === ByteProgressKind.Measured ? parse.processedBytes : null,
    250
  );

  const full = summarizeUploadProgress(
    preConsent,
    [],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );
  assert.equal(full.kind, ByteProgressKind.Indeterminate);
  assert.equal("droppedRows" in full, false, "not a corrupt-cursor cause");

  const metadata = summarizeUploadProgress(
    preConsent,
    [],
    DataSyncLevel.Metadata,
    COMPUTE_TARGET
  );
  assert.equal(metadata.kind, ByteProgressKind.Indeterminate);
});

test("a short upload measurement yields no upload progress", () => {
  const state = summarizeUploadProgress(
    inventory({ uploadCompleteness: TranscriptInventoryCompleteness.Partial }),
    [cursor("sess-1", 600)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Indeterminate);
});

test("upload progress keeps a high-water mark within one revision", () => {
  const fold = createUploadProgress(
    inventory(),
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  fold.report(REVISION, [cursor("sess-1", 600)]);
  const dipped = fold.report(REVISION, [cursor("sess-1", 100)]);

  assert.equal(
    dipped.kind === ByteProgressKind.Measured ? dipped.ratio : null,
    0.6
  );
});

test("upload progress ignores a report from a superseded revision", () => {
  const fold = createUploadProgress(
    inventory(),
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  fold.report(REVISION, [cursor("sess-1", 600)]);
  const stale = fold.report(REVISION - 1, [cursor("sess-1", 1000, true)]);

  assert.equal(
    stale.kind === ByteProgressKind.Measured ? stale.ratio : null,
    0.6
  );
});

test("the archive-row key cannot collide across a separator boundary", () => {
  // Both sides of the upload comparison build this key, and this module reuses
  // the repo's existing `transcriptQueueKey` rather than declaring a third
  // builder for the same identity. A separator that could occur inside either
  // field would let two different files share one key, and the failure would be
  // a silent under-count with every test still green.
  assert.notEqual(
    transcriptQueueKey("a", "b:c"),
    transcriptQueueKey("a:b", "c")
  );
  assert.notEqual(
    transcriptQueueKey("a b", "c"),
    transcriptQueueKey("a", "b c")
  );
});

test("upload matching uses the same key builder as the eligible set", () => {
  // The regression this guards: two independent key builders that disagree by
  // one character each stay internally consistent, match nothing, and report a
  // permanent 0% that no single-module test can see.
  const withOddIds = inventory({
    eligibleFiles: [
      {
        externalSessionId: "sess 1",
        fileKey: subagentFileKey("a b"),
        bytes: 1000,
      },
    ],
    attributableRawBytes: 1000,
  });

  const state = summarizeUploadProgress(
    withOddIds,
    [cursor("sess 1", 1000, true, subagentFileKey("a b"))],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
    1000
  );
});

test("the upload high-water mark stays a whole byte count", () => {
  // Guarding a byte cursor with a RATIO and multiplying back by the total
  // reconstitutes a fractional byte count, which is not a thing a cursor can be.
  const thirds = inventory({
    eligibleFiles: [
      {
        externalSessionId: "sess-1",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        bytes: 3000,
      },
    ],
    attributableRawBytes: 3000,
  });
  const fold = createUploadProgress(thirds, DataSyncLevel.Full, COMPUTE_TARGET);

  fold.report(REVISION, [cursor("sess-1", 1000)]);
  const dipped = fold.report(REVISION, [cursor("sess-1", 10)]);

  const sent =
    dipped.kind === ByteProgressKind.Measured ? dipped.sentBytes : Number.NaN;
  assert.equal(sent, 1000);
  assert.equal(Number.isSafeInteger(sent), true);
});

test("a completed upload does not un-complete within one revision", () => {
  const fold = createUploadProgress(
    inventory(),
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  fold.report(REVISION, [
    cursor("sess-1", 600, true),
    cursor("sess-2", 400, true),
  ]);
  const later = fold.report(REVISION, [cursor("sess-1", 600, true)]);

  assert.equal(
    later.kind === ByteProgressKind.Measured ? later.complete : null,
    true
  );
  assert.equal(
    later.kind === ByteProgressKind.Measured ? later.ratio : null,
    1
  );
});

test("another compute target's cursor is never credited to this machine", () => {
  // The persisted cursor is target-scoped precisely "so an account/machine
  // switch never reuses another target's offset" (schema.prisma). Keying the
  // sum on (externalSessionId, fileKey) alone would start a fresh install's
  // progress bar part-full with bytes a different machine uploaded.
  const state = summarizeUploadProgress(
    inventory(),
    [
      cursor(
        "sess-1",
        600,
        true,
        TRANSCRIPT_MAIN_FILE_KEY,
        redactedArchiveCursorTargetId("other-target")
      ),
      cursor("sess-2", 400, true),
    ],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
    400
  );
  // And it must not complete the set either.
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.complete : null,
    false
  );
});

test("a foreign-target cursor is skipped, not counted as a corrupt row", () => {
  // It is somebody else's valid progress, not bad data — reporting it as a
  // dropped row would raise a false corruption signal.
  const state = summarizeUploadProgress(
    inventory(),
    [
      cursor(
        "sess-1",
        600,
        true,
        TRANSCRIPT_MAIN_FILE_KEY,
        redactedArchiveCursorTargetId("other-target")
      ),
    ],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  // Staying `Measured` IS the assertion now: a row counted as corrupt would
  // have degraded this to `Indeterminate`, so this pins the same contract more
  // tightly than the old `droppedRows === 0` did.
  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.equal(
    state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
    0,
    "somebody else's progress is not this machine's"
  );
});

test("a pre-redaction cursor is not credited", () => {
  // Both shapes of stale cursor: a null target, and a BARE target id, which is
  // the pre-FEA-3735 raw-domain cursor the executor already rewrites. Crediting
  // either would count bytes that are going to be uploaded again.
  for (const staleTarget of [null, COMPUTE_TARGET]) {
    const state = summarizeUploadProgress(
      inventory(),
      [cursor("sess-1", 600, true, TRANSCRIPT_MAIN_FILE_KEY, staleTarget)],
      DataSyncLevel.Full,
      COMPUTE_TARGET
    );

    assert.equal(
      state.kind === ByteProgressKind.Measured ? state.sentBytes : null,
      0,
      `expected ${staleTarget} to be treated as a stale cursor`
    );
  }
});

test("a complete upload reports its total, not the redacted short sum", () => {
  // The undershoot is the COMMON case, not the exotic one: the acked cursor is
  // over the redacted object and the executor cuts at the last newline, so a
  // finished upload routinely lands a few percent under raw on-disk size.
  // Raising the ratio alone renders "998 B of 1000 B" beside a full bar and a
  // complete flag — the same lie as "1.2 KB of 1000 B", in the other direction.
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 599, true), cursor("sess-2", 399, true)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.equal(state.kind, ByteProgressKind.Measured);
  assert.deepEqual(
    state.kind === ByteProgressKind.Measured
      ? {
          sent: state.sentBytes,
          total: state.totalBytes,
          ratio: state.ratio,
          complete: state.complete,
        }
      : null,
    { sent: 1000, total: 1000, ratio: 1, complete: true },
    "every renderable number follows the completion state, or none of them do"
  );
});

test("an incomplete upload still reports the bytes actually acked", () => {
  // The counterfactual: raising sentBytes unconditionally would pass the case
  // above while erasing every real partial reading.
  const state = summarizeUploadProgress(
    inventory(),
    [cursor("sess-1", 400, false)],
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );

  assert.deepEqual(
    state.kind === ByteProgressKind.Measured
      ? { sent: state.sentBytes, complete: state.complete }
      : null,
    { sent: 400, complete: false }
  );
});

test("the sticky completion flag cannot outlive the number beside it", () => {
  // `createUploadProgress` keeps `complete` sticky within a revision, so the
  // same raise has to hold on the high-water path or a later short report
  // renders a complete bar next to a shrinking numerator.
  const fold = createUploadProgress(
    inventory(),
    DataSyncLevel.Full,
    COMPUTE_TARGET
  );
  const revision = inventory().inventoryRevision;

  fold.report(revision, [
    cursor("sess-1", 599, true),
    cursor("sess-2", 399, true),
  ]);
  const after = fold.report(revision, [cursor("sess-1", 100, false)]);

  assert.deepEqual(
    after.kind === ByteProgressKind.Measured
      ? { sent: after.sentBytes, complete: after.complete, ratio: after.ratio }
      : null,
    { sent: 1000, complete: true, ratio: 1 }
  );
});
