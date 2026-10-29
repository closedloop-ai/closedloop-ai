import type { TranscriptArchiveProgress } from "@repo/api/src/types/session-activity-metrics";
import type { SessionTranscript } from "@repo/database";
import { isPermanentlyUnrecoverableTranscript } from "./transcript-availability";

/**
 * ISS-10721 — byte-level completeness of a session's archived transcripts.
 *
 * The desktop's `transcript_sync_state.synced_byte_offset` had no cloud reader,
 * although its twin `session_transcript.synced_byte_offset` has been written all
 * along. This derives the session-scoped figure from those rows so a web surface
 * can say how much of the evidence behind a view has actually landed, rather
 * than only whether it is expected to (`TranscriptDisposition`).
 */

/** The fields the derivation reads — a structural subset of `SessionTranscript`. */
export type TranscriptArchiveProgressInput = Pick<
  SessionTranscript,
  | "syncedByteOffset"
  | "rawByteSize"
  // ISS-11089: the two fields that separate a size that is still coming from
  // one that never is. A retry count or an elapsed time would be a heuristic;
  // this is the desktop's own terminal verdict. It changes no byte figure — it
  // is what `unrecoverableFileCount` is counted from.
  | "uploadStatus"
  | "permanentFailureReason"
>;

/**
 * Sum the verified and observed byte figures across a session's archive rows.
 *
 * Returns `null` for an empty row set, and the caller OMITS the field rather
 * than serializing zeros: no rows means nothing is known about this session's
 * archive, which is a different claim from rows existing with no verified byte.
 *
 * `rawByteSize` is per-row nullable (it is set on complete), so `observedByteSize`
 * is withheld — `null` — unless EVERY row reports one. A sum over the subset
 * that happens to report would not narrow the measurement, it would understate
 * the denominator and make the archive look more complete than it is, which is
 * the one shape a caveat cannot fix. `archivedByteOffset` has no such hazard:
 * the column is NOT NULL with a real `0` default, so its sum is always whole.
 *
 * ISS-11089 — AND THAT RULE HOLDS FOR A SIZE THAT IS NEVER COMING TOO. A file
 * the desktop terminally skipped for a hard reason
 * ({@link isPermanentlyUnrecoverableTranscript}) owes a size that will never
 * arrive, so the withholding is permanent rather than temporary. That is a
 * reason to SAY SO beside the withheld figure, never a licence to re-base the
 * denominator on the rows that did report. marisolashgrove ruled on 2026-09-27:
 * "we should not be changing denominators for anything." A shrunken denominator
 * is not a caveated partial figure, it is a DIFFERENT MEASUREMENT under the same
 * name — `650/650` reads complete when the truth is `650/unknown`. The two
 * halves are deliberately not symmetric: a partial NUMERATOR understates and is
 * honest, a partial DENOMINATOR overstates completion, and no caveat repairs
 * that.
 *
 * WHAT ISS-11089 ADDS IS THE TWO COUNTS, and they are the whole advance. Before
 * them `observedByteSize` went `null` and said nothing about why, so a reader
 * could not tell "still uploading" from "one file's size is gone for good".
 *
 * `reportingFileCount` is how many rows reported a READABLE size. It is NOT the
 * denominator's population — the denominator is over all `fileCount` rows or it
 * is withheld — it is the EXPLANATION of a withholding: `reportingFileCount <
 * fileCount` is exactly when `observedByteSize` is `null` for want of an
 * operand, and the gap says how many rows are missing. A row whose stored size
 * is CORRUPT is not counted as reporting either, because a value that is not a
 * measurement is not a reported size.
 *
 * `unrecoverableFileCount` counts FILES THAT WILL NEVER BE ARCHIVED, and is
 * what makes a withholding readable as permanent rather than in-flight. It is a
 * plain row count, so it publishes even when both byte figures are withheld —
 * which is the ordinary shape for such a session, since the skipped file
 * normally never reported a size. It is NOT a shortfall in either byte figure:
 * the skip write does not clear `rawByteSize`
 * (`app/desktop/transcripts/service.ts`), so a file that completed once and was
 * later hard-skipped reports a size, is counted here, and leaves the denominator
 * whole and published.
 *
 * SO THE BYTE PAIR CANNOT CARRY THIS, WHICH IS WHY THE COUNT SHIPS BESIDE IT.
 * One write produces both columns — `complete` sets `rawByteSize` and
 * `syncedByteOffset` to the same `planEndOffset` (`service.ts`), and nothing
 * else writes either — so a row either reported a size and its offset already
 * equals that size, or reported none and withheld the whole denominator. When
 * `observedByteSize` publishes, every row is of the first kind, and
 * `archivedByteOffset` EQUALS it — for a healthy session and for one holding a
 * hard-skipped file that had completed, alike. Do not read equality as "nothing
 * is missing", and never derive a shortfall from the difference.
 *
 * BigInt is narrowed to `number` at the contract boundary. A file past
 * `Number.MAX_SAFE_INTEGER` bytes (~9 PB) cannot round-trip, so the figure is
 * withheld rather than reported imprecisely.
 *
 * EVERY OPERAND IS RE-VALIDATED, and the columns being `BigInt` in the schema is
 * exactly why. `Prisma.SessionTranscript` types both fields as `bigint`, so
 * `archivedTotal += row.syncedByteOffset` reads as safe and is not: this is a
 * PERSISTED-ROW boundary, where the types constrain nothing at runtime. A caller
 * whose `select` predates these two columns, a row that crossed a JSON hop (where
 * a BigInt does not survive), or any other structural match for the `Pick` above
 * hands this a `number` or an `undefined` — and bare `+=` then throws
 * `Cannot mix BigInt and other types`, which is not a wrong figure but a 500 on
 * the WHOLE session-detail read, for a disclosure that is one optional field of
 * it. Degrading is the contract (root AGENTS.md -> Handling Bad or Nonsensical
 * Data): an unusable operand withholds its own total and the rest of the
 * response is served.
 *
 * THE NUMERATOR IS ALL-OR-NOTHING FOR THE MIRROR OF THE DENOMINATOR'S REASON.
 * Skipping a row whose offset is unreadable and summing the others understates
 * `archivedByteOffset`, which makes the archive look LESS complete than it is —
 * a confident wrong measurement in the other direction. One unusable offset
 * therefore withholds the numerator, not the row.
 */
export function deriveTranscriptArchiveProgress(
  rows: readonly TranscriptArchiveProgressInput[]
): TranscriptArchiveProgress | null {
  if (rows.length === 0) {
    return null;
  }
  let archivedTotal: bigint | null = 0n;
  let observedTotal: bigint | null = 0n;
  let reportingFileCount = 0;
  let unrecoverableFileCount = 0;
  for (const row of rows) {
    const archived = asByteCount(row.syncedByteOffset);
    archivedTotal =
      archivedTotal === null || archived === null
        ? null
        : archivedTotal + archived;
    if (isPermanentlyUnrecoverableTranscript(row)) {
      unrecoverableFileCount += 1;
    }
    // A row that did not report a READABLE size withholds the denominator and
    // is not counted as reporting, whatever its status says. Absent (`null`,
    // still coming or never coming) and corrupt (a stored value that is not a
    // measurement) are one case here: neither may fabricate an operand, and
    // `asByteCount` already answers `null` for both.
    const observed = asByteCount(row.rawByteSize);
    if (observed === null) {
      observedTotal = null;
    } else {
      reportingFileCount += 1;
      observedTotal = observedTotal === null ? null : observedTotal + observed;
    }
  }
  return {
    archivedByteOffset: toSafeByteCount(archivedTotal),
    observedByteSize: toSafeByteCount(observedTotal),
    fileCount: rows.length,
    reportingFileCount,
    unrecoverableFileCount,
  };
}

/**
 * One stored byte figure as a non-negative `bigint`, else null.
 *
 * Accepts the `bigint` the column holds AND the `number` a boundary that lost
 * the BigInt can hand over, because both are reachable and neither may become a
 * `TypeError`. The number arm covers the whole impossible set rather than the
 * two everyone remembers: non-finite, fractional (half a byte is not a
 * measurement), negative, and past the safe-integer range where the value is
 * already wrong before it is converted. Every other type, `null` and `undefined`
 * included, is "not a readable byte figure".
 */
function asByteCount(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value < 0n ? null : value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return BigInt(value);
}

/** A non-negative BigInt byte total as a safe `number`, else null. */
function toSafeByteCount(total: bigint | null): number | null {
  if (total === null || total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(total);
}
