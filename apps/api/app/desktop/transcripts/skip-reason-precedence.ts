/**
 * @file skip-reason-precedence.ts
 * @description ISS-4820 item 2 — precedence between transcript skip reasons.
 *
 * Extracted from `service.ts` rather than appended to it: that file sits just
 * under the 1,000-line ceiling, and this is a self-contained pure decision with
 * its own tests.
 */
import {
  isRecoverableTranscriptSkipReason,
  type TranscriptSkipReason,
  TranscriptUploadStatus,
  toKnownTranscriptSkipReason,
} from "@repo/api/src/types/desktop-transcripts";

/**
 * ISS-4820 item 2 — reason PRECEDENCE for a skip landing on an existing row.
 *
 * `markPermanentlySkipped`'s update branch was last-writer-wins. That is wrong
 * across the desktop's 30s per-file lock release: a changed OpenCode projection
 * can requeue and settle a NEWER hard reason (e.g. `too_large`) while a stale
 * in-flight `materialized_source_unavailable` request is still finishing. The
 * late recoverable write then clobbered the hard reason and the read path
 * flipped the row back to a `syncing` disposition — a dead row reading "still
 * uploading" forever, with nothing on any queue to advance it.
 *
 * Rule: a RECOVERABLE reason never overwrites an already-recorded HARD terminal
 * reason. Everything else keeps last-writer-wins (a hard reason may still
 * upgrade a recoverable one — that direction is the correct settle).
 *
 * Scoped to a row that is ALREADY `skipped`. An UNRECOGNIZED persisted reason
 * is only reachable by rolling the API back behind a desktop that wrote a newer
 * label — and it is NOT a licence to overwrite (codex review). Every read path
 * normalizes an unknown reason to `null` and maps that to the HARD
 * `failedPermanent` (`dispositionForTerminalSkipReason`,
 * `terminalUnavailablePresentation`), so letting the recoverable reason win
 * would flip a row this build classifies as dead back to `syncing` — the exact
 * resurrection this precedence rule exists to prevent, just via a label the
 * rolled-back build cannot name. So an unrecognized reason is treated as HARD
 * and PRESERVED verbatim: the newer build that wrote it can still read it, and
 * this one neither ranks it nor destroys it.
 *
 * Returns the value to PERSIST, which is why it is a `string` rather than a
 * {@link TranscriptSkipReason} — the preserved case is by definition a label
 * outside this build's enum.
 */
export function resolveSkipReasonPrecedence(
  existingStatus: string | undefined,
  existingReason: string | null | undefined,
  requestedReason: TranscriptSkipReason
): string {
  if (!isRecoverableTranscriptSkipReason(requestedReason)) {
    return requestedReason;
  }
  if (existingStatus !== TranscriptUploadStatus.Skipped) {
    return requestedReason;
  }
  const recordedReason = toKnownTranscriptSkipReason(existingReason);
  if (recordedReason === null) {
    // Distinguish "no reason recorded at all" (the requested reason is strictly
    // more information, so it wins) from "a reason recorded that this build does
    // not recognize" (conservatively HARD — preserve it).
    return existingReason ? existingReason : requestedReason;
  }
  if (isRecoverableTranscriptSkipReason(recordedReason)) {
    return requestedReason;
  }
  return recordedReason;
}
