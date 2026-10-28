import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  type TranscriptSyncStatusSnapshot,
} from "../../shared/transcript-sync-status-contract.js";

/**
 * @file transcript-sync-lane-absent-status.ts
 * @description The status snapshot served to the renderer when this machine has
 * NO transcript-sync service at all.
 *
 * `TranscriptSyncService` is constructed once at boot and only when
 * `transcriptSyncEnabled` is set, so a machine whose data-sync level keeps
 * transcripts local (`DataSyncLevel.Metadata` persists that flag false), a
 * golden-mode run, or a user who simply turned the toggle off all reach the
 * renderer through this shape instead of through `getStatusSnapshot()`.
 *
 * Extracted from the composition root's IPC wiring so the answer it gives is
 * reachable by a node test. Inlined in `desktop-ipc-registration.ts` it was not:
 * importing that module evaluates Electron bootstrap, so the no-lane branch —
 * which is the branch every metadata-tier machine takes — could only be read,
 * never executed.
 */

/**
 * Every gate reads closed, because nothing can egress: `enabled: false` is what
 * a consumer keys the "you turned it off" state on, and the other two stay
 * closed rather than implying a healthy lane behind a missing service
 * (ISS-4716). The gate is a settled `Denied`, not `Unresolved`: there is no
 * service and no pending policy read here, so nothing is going to arrive later
 * and a consumer must not sit on a skeleton waiting for it (ISS-5348).
 *
 * ISS-7516: `computeTargetId` is the one field that is NOT a statement about the
 * lane — it names the machine — so it is passed in rather than hardcoded null.
 * A metadata-tier machine has no lane and never will, yet it still has a cloud
 * identity, and withholding it here is what made the never-expected verdict
 * unreachable on exactly the tier that verdict exists to describe: the renderer
 * compares this id against the session's to establish "recorded on THIS
 * machine", and a `null` fails that comparison and falls back to the
 * still-syncing copy forever.
 *
 * Pass the SAME accessor the live lane is wired with
 * (`DesktopApplication.onlineComputeTargetId`), so the id a consumer compares
 * against does not depend on whether a lane happens to exist — the transcript
 * lane's own alias for it was collapsed into that accessor so the two cannot be
 * given different rules. `null` remains a truthful
 * "cannot attribute" — offline or signed out — and the consumer withholds the
 * claim, which is the correct answer for an unknown target and is why this does
 * not simply assert the machine matches.
 */
export function transcriptSyncLaneAbsentStatus(
  computeTargetId: string | null
): TranscriptSyncStatusSnapshot {
  return {
    enabled: false,
    online: false,
    tierGate: TranscriptEgressGate.Denied,
    storeReady: false,
    computeTargetId,
    statusCounts: emptyTranscriptStatusCounts(),
  };
}
