import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { describe, expect, it } from "vitest";
import { deriveTranscriptArchiveProgress } from "./transcript-archive-progress";

const row = (syncedByteOffset: bigint, rawByteSize: bigint | null) => ({
  syncedByteOffset,
  rawByteSize,
  uploadStatus: TranscriptUploadStatus.Uploaded,
  permanentFailureReason: null,
});

/** A file still on its way: the denominator it owes is coming (ISS-11089 AC2). */
const inFlightRow = (
  syncedByteOffset: bigint,
  uploadStatus:
    | typeof TranscriptUploadStatus.Pending
    | typeof TranscriptUploadStatus.Uploading
    | typeof TranscriptUploadStatus.Failed = TranscriptUploadStatus.Uploading
) => ({
  syncedByteOffset,
  rawByteSize: null,
  uploadStatus,
  permanentFailureReason: null,
});

/** A file the desktop terminally skipped: its size is never coming. */
const unrecoverableRow = (
  syncedByteOffset: bigint,
  permanentFailureReason: string | null = TranscriptSkipReason.TooLarge,
  rawByteSize: bigint | null = null
) => ({
  syncedByteOffset,
  rawByteSize,
  uploadStatus: TranscriptUploadStatus.Skipped,
  permanentFailureReason,
});

describe("deriveTranscriptArchiveProgress", () => {
  it("returns null when the session has no archive rows at all", () => {
    // Distinct from a zero: no rows means nothing is KNOWN about this session's
    // archive, and the caller omits the field rather than claiming an empty one.
    expect(deriveTranscriptArchiveProgress([])).toBeNull();
  });

  it("sums verified and observed bytes across every file of the session", () => {
    // Two files, not one: a per-file figure and a session-wide figure are
    // indistinguishable on a single-row fixture.
    expect(
      deriveTranscriptArchiveProgress([row(100n, 400n), row(250n, 250n)])
    ).toEqual({
      archivedByteOffset: 350,
      observedByteSize: 650,
      fileCount: 2,
      reportingFileCount: 2,
      unrecoverableFileCount: 0,
    });
  });

  it("reports a real zero when rows exist and no byte is verified yet", () => {
    expect(deriveTranscriptArchiveProgress([row(0n, 900n)])).toEqual({
      archivedByteOffset: 0,
      observedByteSize: 900,
      fileCount: 1,
      reportingFileCount: 1,
      unrecoverableFileCount: 0,
    });
  });

  it("withholds observedByteSize when any row has not reported its size", () => {
    // Summing only the rows that report would understate the denominator and
    // make the archive look MORE complete than it is — a bias, not a shortfall.
    // The verified half still publishes: its column is NOT NULL.
    const progress = deriveTranscriptArchiveProgress([
      row(100n, 400n),
      row(50n, null),
    ]);
    expect(progress).toEqual({
      archivedByteOffset: 150,
      observedByteSize: null,
      fileCount: 2,
      // One of the two DID report, and the count SAYS so — which is what
      // `reportingFileCount` is for. It explains the withholding; it is not a
      // population the figure gets re-based onto.
      reportingFileCount: 1,
      unrecoverableFileCount: 0,
    });
  });

  it("withholds a total past the safe-integer range instead of rounding it", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER);
    const progress = deriveTranscriptArchiveProgress([
      row(huge, huge),
      row(2n, 2n),
    ]);
    expect(progress?.archivedByteOffset).toBeNull();
    expect(progress?.observedByteSize).toBeNull();
    expect(progress?.fileCount).toBe(2);
  });
  it("does not throw when a row hands over a number instead of a BigInt", () => {
    // Regression: the columns are `BigInt` in the schema, so bare `+=` READ as
    // safe — and a persisted-row boundary constrains nothing at runtime. A
    // caller whose `select` predates these two columns, or a row that crossed a
    // JSON hop, hands over a `number` or an `undefined`, and `0n + number`
    // throws `Cannot mix BigInt and other types` — a 500 on the WHOLE
    // session-detail read for one optional disclosure on it.
    const mixed = [
      { syncedByteOffset: 100, rawByteSize: 400 },
      row(250n, 250n),
    ] as unknown as Parameters<typeof deriveTranscriptArchiveProgress>[0];
    expect(() => deriveTranscriptArchiveProgress(mixed)).not.toThrow();
    expect(deriveTranscriptArchiveProgress(mixed)).toEqual({
      archivedByteOffset: 350,
      observedByteSize: 650,
      fileCount: 2,
      reportingFileCount: 2,
      unrecoverableFileCount: 0,
    });
  });

  it("serves the response with the figures withheld when a row carries neither field", () => {
    // The shape a `select` that predates ISS-10721 returns. Degrade, never
    // throw: `fileCount` is still a real measurement of this session's archive.
    const partial = [{}, row(250n, 250n)] as unknown as Parameters<
      typeof deriveTranscriptArchiveProgress
    >[0];
    expect(deriveTranscriptArchiveProgress(partial)).toEqual({
      archivedByteOffset: null,
      observedByteSize: null,
      fileCount: 2,
      reportingFileCount: 1,
      unrecoverableFileCount: 0,
    });
  });

  it("withholds the NUMERATOR rather than understating it when one offset is unusable", () => {
    // The mirror of the denominator rule. Skipping the bad row and summing the
    // rest makes the archive look LESS complete than it is, which is a confident
    // wrong measurement in the other direction, not a narrower one.
    const corrupt = [
      { syncedByteOffset: -1n, rawByteSize: 400n },
      row(250n, 250n),
    ] as unknown as Parameters<typeof deriveTranscriptArchiveProgress>[0];
    expect(deriveTranscriptArchiveProgress(corrupt)).toEqual({
      archivedByteOffset: null,
      observedByteSize: 650,
      fileCount: 2,
      reportingFileCount: 2,
      unrecoverableFileCount: 0,
    });
  });

  it("refuses a fractional byte count rather than treating it as a measurement", () => {
    const fractional = [
      { syncedByteOffset: 1.5, rawByteSize: 400n },
    ] as unknown as Parameters<typeof deriveTranscriptArchiveProgress>[0];
    expect(
      deriveTranscriptArchiveProgress(fractional)?.archivedByteOffset
    ).toBeNull();
  });
});

describe("deriveTranscriptArchiveProgress — counting a size that is never coming (ISS-11089)", () => {
  it("STILL WITHHOLDS the denominator past a dead file, and counts the file instead", () => {
    // Three files: two reported, one the desktop terminally skipped for a hard
    // reason. The denominator does NOT re-base onto the two that reported
    // (marisolashgrove, 2026-09-27: "we should not be changing denominators for
    // anything") — publishing `650` here would be a different measurement under
    // the same name, and `650/650` would read complete when the truth is
    // `650/unknown`. The figure stays `null` and the two counts carry the whole
    // disclosure: one row short of reporting, and that row will never report.
    const progress = deriveTranscriptArchiveProgress([
      row(400n, 400n),
      row(250n, 250n),
      unrecoverableRow(0n, TranscriptSkipReason.TooLarge),
    ]);
    expect(progress).toEqual({
      archivedByteOffset: 650,
      observedByteSize: null,
      fileCount: 3,
      // What a bare `null` never said: 2 of 3 rows reported, and the missing
      // one is gone for good rather than still uploading. That pair is the
      // advance ISS-11089 makes over withholding in silence.
      reportingFileCount: 2,
      unrecoverableFileCount: 1,
    });
  });

  it("counts every hard terminal reason, including an unknown one", () => {
    // `dispositionForTerminalSkipReason` degrades an unknown/absent reason to
    // the conservative hard verdict, and this must agree with it rather than
    // treat the row as still coming.
    const progress = deriveTranscriptArchiveProgress([
      row(400n, 400n),
      unrecoverableRow(0n, TranscriptSkipReason.SourceGone),
      unrecoverableRow(0n, TranscriptSkipReason.RetriesExhausted),
      unrecoverableRow(0n, null),
      unrecoverableRow(0n, "a_reason_this_build_does_not_know"),
    ]);
    // Withheld, as four unreported sizes require; the COUNT is what this case
    // pins, and a derivation that counted `skipped` alone would read 4 here too
    // — hence the recoverable-skip sibling below.
    expect(progress?.observedByteSize).toBeNull();
    expect(progress?.unrecoverableFileCount).toBe(4);
    expect(progress?.fileCount).toBe(5);
    // 1 of 5 rows reported: the gap says four operands are missing.
    expect(progress?.reportingFileCount).toBe(1);
  });

  it("keeps today's behaviour for an in-flight upload, with nothing counted", () => {
    // AC2. An in-flight row withholds, and so does every other unreported size
    // — the counts are the only thing this change added, so a zero-unrecoverable
    // session behaves EXACTLY as it did before it.
    for (const status of [
      TranscriptUploadStatus.Pending,
      TranscriptUploadStatus.Uploading,
      TranscriptUploadStatus.Failed,
    ] as const) {
      expect(
        deriveTranscriptArchiveProgress([
          row(400n, 400n),
          inFlightRow(50n, status),
        ])
      ).toEqual({
        archivedByteOffset: 450,
        observedByteSize: null,
        fileCount: 2,
        reportingFileCount: 1,
        unrecoverableFileCount: 0,
      });
    }
  });

  it("does NOT count a RECOVERABLE skip, which is still coming", () => {
    // ISS-9884 / ISS-4695 item 3: `skipped` alone is not terminal. A
    // re-materializing source and a lane whose transport comes back both still
    // owe a size, so they withhold like any in-flight row and are not
    // disclosed as unrecoverable.
    for (const reason of [
      TranscriptSkipReason.MaterializedSourceUnavailable,
      TranscriptSkipReason.EnvironmentUnavailable,
    ] as const) {
      expect(
        deriveTranscriptArchiveProgress([
          row(400n, 400n),
          unrecoverableRow(0n, reason),
        ])
      ).toEqual({
        archivedByteOffset: 400,
        observedByteSize: null,
        fileCount: 2,
        reportingFileCount: 1,
        unrecoverableFileCount: 0,
      });
    }
  });

  it("still withholds when an in-flight row sits beside an unrecoverable one", () => {
    // The mixed case: one row still uploading, one gone for good. The figure is
    // withheld for either reason alone, and the two counts distinguish them —
    // 1 of 3 reported, and exactly 1 of the 2 missing is never coming.
    const progress = deriveTranscriptArchiveProgress([
      row(400n, 400n),
      inFlightRow(10n),
      unrecoverableRow(0n),
    ]);
    expect(progress).toEqual({
      archivedByteOffset: 410,
      observedByteSize: null,
      fileCount: 3,
      reportingFileCount: 1,
      unrecoverableFileCount: 1,
    });
  });

  it("sums an unrecoverable file that DID report a size, and counts it WITHOUT claiming the denominator is short", () => {
    // Reachable, not hypothetical: the skip write does not clear `rawByteSize`
    // (`app/desktop/transcripts/service.ts`), so a file that completed once and
    // was later hard-skipped carries both a real size and a hard terminal
    // reason. A terminal skip does not erase a measurement, so those bytes
    // belong IN the denominator — and the count still publishes, because it
    // counts FILES THAT WILL NEVER BE ARCHIVED, not operands missing from the
    // sum. The denominator is whole here — every row reported — so it publishes
    // under the unchanged all-or-nothing rule, not by any exclusion.
    //
    // THE FIXTURE IS THE SHAPE THE SERVICE CAN ACTUALLY WRITE (review). One
    // write produces both byte columns — `complete` sets `rawByteSize` and
    // `syncedByteOffset` to the same `planEndOffset` — and neither the re-plan
    // upsert nor `markPermanentlySkipped` touches either, so a file that
    // completed once and was later hard-skipped carries `synced === raw`. An
    // offset of `0` beside a reported size is not producible, and pinning that
    // gap would have shown a reader something production never serves.
    //
    // So this is what the reader actually gets: 1300/1300, which by itself
    // reads as FULLY ARCHIVED even though one of these files will never be
    // archived again. That is precisely why `unrecoverableFileCount` has to
    // publish — the byte pair cannot carry this, and a reader deriving "the
    // denominator is short by 1 file" from the count would be wrong too.
    expect(
      deriveTranscriptArchiveProgress([
        row(400n, 400n),
        unrecoverableRow(900n, TranscriptSkipReason.TooLarge, 900n),
      ])
    ).toEqual({
      archivedByteOffset: 1300,
      observedByteSize: 1300,
      fileCount: 2,
      // Every row reported, so nothing is missing and `reportingFileCount`
      // equals `fileCount` — yet one file is unrecoverable. The two counts are
      // independent: `fileCount - unrecoverableFileCount` would say 1 reported
      // and be wrong, which is why each is published rather than inferred.
      reportingFileCount: 2,
      unrecoverableFileCount: 1,
    });
  });

  it("withholds a CORRUPT size on an unrecoverable row instead of dropping it", () => {
    // A stored value that is not a measurement is a data defect, and it must not
    // reach the sum: adding `-1` would publish a confidently WRONG denominator
    // rather than withhold. The row is also not counted as reporting, so the
    // counts do not claim an operand the fold never got.
    const corrupt = [
      row(400n, 400n),
      unrecoverableRow(0n, TranscriptSkipReason.TooLarge, -1n),
    ] as unknown as Parameters<typeof deriveTranscriptArchiveProgress>[0];
    const progress = deriveTranscriptArchiveProgress(corrupt);
    expect(progress?.observedByteSize).toBeNull();
    expect(progress?.archivedByteOffset).toBe(400);
    expect(progress?.unrecoverableFileCount).toBe(1);
    // The corrupt row is NOT counted as having reported: only the healthy one is.
    expect(progress?.reportingFileCount).toBe(1);
  });

  it("refuses every impossible size on an unrecoverable row, not just the two everyone remembers", () => {
    // The whole impossible set for this domain: fractional (half a byte is not
    // a measurement), non-finite, a blank string a JSON hop left in the column
    // (`Number("")` is 0, and a 0 would render as a real measurement), and a
    // magnitude past the safe-integer range, which is already wrong before it
    // is converted. None of them may join the sum, and none of them counts as a
    // reported size.
    for (const bad of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "",
      Number.MAX_SAFE_INTEGER + 1,
    ] as const) {
      const rows = [
        row(400n, 400n),
        unrecoverableRow(
          0n,
          TranscriptSkipReason.TooLarge,
          bad as unknown as bigint
        ),
      ] as unknown as Parameters<typeof deriveTranscriptArchiveProgress>[0];
      const progress = deriveTranscriptArchiveProgress(rows);
      expect(progress?.observedByteSize).toBeNull();
      // Positive siblings: the rest of the fold still publishes, so a
      // derivation that returned nothing at all would not satisfy this.
      expect(progress?.archivedByteOffset).toBe(400);
      expect(progress?.unrecoverableFileCount).toBe(1);
      expect(progress?.reportingFileCount).toBe(1);
    }
  });

  it("withholds rather than publishing a 0 when NO file reported a size", () => {
    // Every row unrecoverable and none reporting. No `0` is published — it would
    // claim a measured empty archive and read as 100% complete — and the counts
    // are the entire disclosure: nothing reported, and nothing ever will.
    expect(
      deriveTranscriptArchiveProgress([
        unrecoverableRow(0n),
        unrecoverableRow(0n),
      ])
    ).toEqual({
      archivedByteOffset: 0,
      observedByteSize: null,
      fileCount: 2,
      reportingFileCount: 0,
      unrecoverableFileCount: 2,
    });
  });
});
