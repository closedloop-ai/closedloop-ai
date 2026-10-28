/**
 * @file transcript-failure-classification.ts
 * @description What a failed transcript upload MEANS: whether it is the lane's
 * fault or the row's, what the log line calls it, and what the monitored lane
 * reports. Split out of `transcript-drain-queue.ts` (ISS-8608), which was
 * approaching the file-size ceiling.
 *
 * The three answers live together because they read ONE error and must never
 * disagree about it — the retry budget freezing for an expired presign while the
 * telemetry pages `target_not_owned` is precisely the collapse
 * `transcriptFailureSyncReason` exists to prevent. Keeping them in one module
 * puts that agreement in front of the next reader instead of across a file.
 *
 * Every function here is pure and takes the error alone; the drain owns the
 * ladder, the ceiling, and the ack-gated terminal path.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { TranscriptForbiddenCode } from "@repo/api/src/types/desktop-transcripts";
import { syncReasonForHttpStatus } from "../agent-sync/sync-lane-cloud-health.js";
import { TranscriptSyncClientError } from "../transcript/desktop-transcripts-client.js";
import {
  classifyS3PutFailure,
  S3PutFailureClass,
  s3PutSyncReason,
} from "./transcript-s3-put-classification.js";
import {
  isLaneWideHttpStatus,
  isLaneWideTranscriptForbidden,
} from "./transcript-sync-types.js";

/**
 * ISS-7097: is this the CLOUD failing, or this row being wrong? A failure that
 * hits every row identically is fixed by neither re-planning nor giving up on
 * the file, so per `sync/AGENTS.md` invariant 4 it must not burn the per-row
 * budget — otherwise one outage marches healthy transcripts to a
 * `retries_exhausted` skip the cloud then believes.
 *
 * ISS-9693 / ISS-9695: `isLaneWideHttpStatus` answers lane-wide for every status
 * the shared classification module does not call ITEM (ISS-8614). A deploy-skew
 * 404 and any status this build has never seen freeze the counter instead of
 * spending it, which is Appendix A's hardwired unknown default. (ISS-8608 added a second way to reach the
 * environmental arm — an S3 `<Code>` on the upload arm — so a status the
 * standard names row-attributable is no longer the ONLY thing that can take
 * `retryCount + 1`; it is now the only thing that can take it on the CONTROL
 * plane.)
 *
 * ISS-8599: a CODED 403 is lane-wide too. Ownership and org policy are both
 * conditions of the target/org, never of these bytes, so neither is
 * "attributable to the item". A BARE 403 is not admitted here — without the code
 * the two are indistinguishable, and unchanged is the only safe answer against a
 * server that predates the split.
 *
 * ISS-8608: the third arm is the PRESIGNED UPLOAD. Everything above reasons from
 * the control plane, but S3's rejections arrive here too, and an expired presign
 * or a socket that stalled mid-part is a condition of the URL or the link rather
 * than of these bytes. `classifyS3PutFailure` answers `undefined` outside the
 * 400/403 the standard scopes it to, so a 409 `StaleUpload` and a 413 keep the
 * ladder exactly as they do today — this arm can only ever ADD an environmental
 * verdict, never remove one.
 */
export function isLaneWideTranscriptFailure(error: unknown): boolean {
  return (
    error instanceof TranscriptSyncClientError &&
    (isLaneWideHttpStatus(error.status) ||
      isLaneWideTranscriptForbidden(error.forbiddenCode) ||
      (error.s3Upload === true &&
        classifyS3PutFailure(error.status, error.s3ErrorCode) ===
          S3PutFailureClass.Environmental))
  );
}

/**
 * ISS-7097: the failure log line, which has to say WHICH bound is running.
 *
 * A lane-wide stall does not advance the attempt counter, so printing
 * "attempt N" for one would show the same N on the lane-stall schedule for a day
 * and read as a stuck lane rather than a deliberately-frozen budget. Name the
 * stall instead, and keep the attempt ladder's wording for the row-attributable
 * case it actually describes.
 */
export function laneWideFailureLog(
  label: "failed" | "force-sync",
  fileKey: string,
  message: string,
  laneWide: boolean,
  retryCount: number,
  deadLetterSuffix: string
): string {
  if (label === "force-sync") {
    return `transcript ${fileKey} force-sync failed: ${message}`;
  }
  if (laneWide) {
    return `transcript ${fileKey} failed (cloud unavailable; retry budget held${deadLetterSuffix}): ${message}`;
  }
  return `transcript ${fileKey} failed (attempt ${retryCount}${deadLetterSuffix}): ${message}`;
}

/**
 * ISS-8599: the batch-health reason for ONE failed transcript upload.
 *
 * `syncReasonForHttpStatus` folds every 403 to `target_not_owned`, which was the
 * only honest answer while the two 403s were indistinguishable. Now that the
 * server spells them apart, continuing to fold by status alone would ASSERT the
 * wrong cause on the monitored lane: an org whose session-sync policy is off
 * would page as a device holding a stale compute target, and the two want
 * different responses — an org-admin setting versus an identity the desktop can
 * re-resolve itself. Reading the discriminator for the retry budget and then
 * discarding it for the telemetry is exactly the collapse the split removed.
 *
 * No new wire value: `feature_disabled` is already in the shared reason enum and
 * is already what the SESSION lane emits for this condition, so the two lanes
 * now name an org-policy denial the same way.
 *
 * Every uncoded and unrecognized case falls through to the status fold, so the
 * bare-403 reason is unchanged for an older server exactly as its budget is.
 */
export function transcriptFailureSyncReason(
  error: TranscriptSyncClientError
): SyncReason {
  // ISS-8608: the upload arm reads the SAME table the budget decision reads.
  // This sits ahead of the `forbiddenCode` read below and not merely ahead of
  // the switch: S3 never sends a `forbiddenCode`, so the `undefined` branch
  // catches every S3 error and anything placed after it would be dead code.
  // Without this the two decisions disagree — an expired presign frozen as
  // environmental for the budget while paging the lane `target_not_owned`,
  // which is the collapse this function exists to prevent, one arm over.
  const s3Reason =
    error.s3Upload === true
      ? s3PutSyncReason(error.status, error.s3ErrorCode)
      : undefined;
  if (s3Reason !== undefined) {
    return s3Reason;
  }
  const code = error.forbiddenCode;
  if (code === undefined) {
    return syncReasonForHttpStatus(error.status);
  }
  // Exhaustive over the closed union, like `isLaneWideTranscriptForbidden`: a
  // new code must decide what it is CALLED as well as what it COSTS. Verified by
  // probe — adding a third member fails `tsc` here, it does not fall through.
  // biome-ignore lint/style/useDefaultSwitchClause: a default would silently re-fold a new code onto the status, which is the defect this function exists to remove.
  switch (code) {
    case TranscriptForbiddenCode.PolicyDisabled:
      return SyncReason.FeatureDisabled;
    case TranscriptForbiddenCode.NotOwned:
      return SyncReason.TargetNotOwned;
  }
}
