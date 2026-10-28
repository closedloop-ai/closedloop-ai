/**
 * @file transcript-terminal-skip.ts
 * @description The archive lane's TERMINAL-SKIP classification: which reason a
 * dead-letter-eligible row is abandoned with, how the server's answer to that
 * skip settles it, and what the batch-health span says about a failure that did
 * not end in one.
 *
 * Split out of `transcript-drain-queue.ts` (ISS-9884, PLN-1986 §4), which had no
 * headroom left for the lane give-up. A real seam rather than a line-count
 * slice: everything here answers "what does the cloud's reply to a terminal
 * skip mean", and nothing here touches the claim set, the batch flush, or the
 * retry ladder the drain owns.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { TranscriptSyncClientError } from "../transcript/desktop-transcripts-client.js";
import { transcriptFailureSyncReason } from "./transcript-failure-classification.js";
import type { TranscriptSyncExecutor } from "./transcript-sync-executor.js";
import type { TranscriptFingerprint } from "./transcript-sync-types.js";

/**
 * ISS-4621: log suffix for the consecutive-failure ladder. Distinguishes a
 * completed dead-letter (cloud acknowledged the terminal skip) from one held
 * back because the ack failed — the row stays `failed` and the transition
 * re-runs next drain, which the operator should be able to see in the logs.
 */
export function deadLetterLogSuffix(
  deadEligible: boolean,
  dead: boolean
): string {
  if (!deadEligible) {
    return "";
  }
  return dead ? ", dead-lettered" : ", dead-letter pending cloud ack";
}

/**
 * ISS-4695 (Item 1): emit the caller's terminal skip and classify the server's
 * authoritative answer into the same three outcomes the executor's
 * `settleTerminalSkip` uses, so this terminal path and the per-attempt
 * terminal path cannot drift:
 *  - `skipped`: the cloud RECORDED the terminal skip (`acked`, status
 *    `skipped`) → the caller may dead-letter the local row. Carries the reason
 *    the server reported PERSISTING, which the version-skew fallback or the
 *    server's own precedence rule can have substituted for the one passed in,
 *    and which is `null` when it kept a label this build cannot name
 *    (ISS-9884).
 *  - `uploaded`: a verified archive already exists — the server refused to mask
 *    readable bytes with a late skip. NOT a failure: the caller settles the row
 *    readable rather than keeping it on the retry ladder (dead-lettering would
 *    project `failedPermanent` for a synced transcript, the ISS-4695 lie).
 *  - `unacknowledged`: `{ acked: false }` (offline / transport error / an
 *    attempt snapshotted under no target, which no cloud is told of) OR any
 *    other version-skewed non-terminal status — ambiguous, so the caller keeps
 *    the row on the retry ladder.
 */
export async function classifyTerminalSkip(
  executor: TranscriptSyncExecutor,
  fp: TranscriptFingerprint,
  attemptComputeTargetId: string | null,
  reason: TranscriptSkipReason
): Promise<TerminalSkipOutcome> {
  const emit = await executor.notifyPermanentSkip(
    fp,
    reason,
    attemptComputeTargetId
  );
  if (!emit.acked) {
    return { kind: "unacknowledged" };
  }
  if (emit.status === TranscriptUploadStatus.Skipped) {
    // ISS-9884: the reason the server RECORDED, which the version-skew fallback
    // or its precedence rule can have substituted for the one we asked for.
    return { kind: "skipped", reason: emit.reason };
  }
  if (emit.status === TranscriptUploadStatus.Uploaded) {
    return { kind: "uploaded" };
  }
  return { kind: "unacknowledged" };
}

/**
 * ISS-9884 (PLN-1986 §9) — which BOUND dead-lettered this row, and therefore
 * which reason the cloud is told.
 *
 * `recordFailure` has already computed the only fact that decides it. The two
 * bounds are not two thresholds on one ladder; they are different claims:
 *
 * - the consecutive-failure LADDER ran out → `retries_exhausted`, byte for byte
 *   as before. Something about the ATTEMPTS kept failing and the budget is
 *   spent.
 * - the lane-wide WALL CLOCK ran out → `environment_unavailable`. Every attempt
 *   was refused by a condition that had nothing to do with this file (the
 *   bucket unset, the org policy off, the cloud unreachable), the retry count
 *   was deliberately never advanced, and the file is presumed present because
 *   the transport was never available to prove otherwise. Calling that
 *   `retries_exhausted` is the "Sync failed" lie this ticket exists to end.
 *
 * It reads the SAME `laneWide` the ceiling itself is selected by, so a row can
 * never be dead-lettered by one bound and labelled with the other's reason.
 */
export function terminalSkipReasonForBound(
  laneWide: boolean
): TranscriptSkipReason {
  return laneWide
    ? TranscriptSkipReason.EnvironmentUnavailable
    : TranscriptSkipReason.RetriesExhausted;
}

/**
 * ISS-9884: the three outcomes of {@link classifyTerminalSkip}, widened from a
 * bare string union so the `skipped` arm can carry the reason the server
 * actually recorded — the caller has to persist THAT, not the one it asked
 * for, or a version-skewed desktop's local verdict contradicts the cloud's.
 * `null` when the cloud acknowledged a terminal this build cannot name.
 */
export type TerminalSkipOutcome =
  | { kind: "skipped"; reason: TranscriptSkipReason | null }
  | { kind: "uploaded" }
  | { kind: "unacknowledged" };

/**
 * ISS-8599: the batch-health reason for a failure that did NOT end in an
 * acknowledged terminal skip — the status the server actually answered with,
 * when it answered one.
 */
export function attemptFailureSyncReason(error: unknown): SyncReason {
  return error instanceof TranscriptSyncClientError
    ? transcriptFailureSyncReason(error)
    : SyncReason.TransportError;
}
