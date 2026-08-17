/**
 * @file cloud-read-lane-applicability.ts
 * @description ISS-6206 (shafty023 review on #5050): why a sync lane is not
 * applicable to this app's CONFIGURATION, as distinct from why it happens not to
 * be running at this instant.
 *
 * WHY THIS EXISTS. The whole-app backlog needs to know when "every lane owes
 * nothing, but not every lane reached `drained`" is a verdict that can never
 * improve, because that is the only case where a startup surface may stop
 * waiting. It was deriving that permanence from a single stopped SAMPLE, and a
 * sample cannot carry it: {@link SyncLaneDrainState.IdleNotRunning} covers
 * connectivity, credential, org-policy and compute-target gates, every one of
 * which reopens on its own. Reading one of those as permanent let the startup
 * panel latch shut moments before the next burn-down exposed newly eligible
 * work — the panel would have hidden the work rather than reported it.
 *
 * A CONFIGURATION answer is different in kind. "The user switched transcript
 * upload off" is not an observation of the lane; it is the reason the lane
 * exists in a stopped state at all, it is read from the same persisted setting
 * on every sample, and it changes only when the user changes it — at which
 * point the next sample reports the lane as applicable again and the aggregate
 * goes back to waiting. That is what the strict-readiness verdict is allowed to
 * rest on.
 *
 * SILENCE IS NOT A REASON. Any lane this module cannot attribute to a
 * configuration switch answers `null`, and `null` means "still waiting" — the
 * under-claiming direction. A lane stopped for a reason we cannot name must
 * never be counted as permanently unattestable.
 */

import { SyncLaneId } from "./sync-burndown-contract.js";

/**
 * Why a lane cannot run for this app's configuration.
 *
 * Deliberately a reason rather than a boolean: the next member will be an org
 * policy or a build-level exclusion, and a caller that has to explain itself to
 * a user needs to know which.
 */
export const CloudReadLaneNotApplicableReason = {
  /** The lane's own feature switch is off in this app's persisted settings. */
  DisabledByConfig: "disabled_by_config",
} as const;
export type CloudReadLaneNotApplicableReason =
  (typeof CloudReadLaneNotApplicableReason)[keyof typeof CloudReadLaneNotApplicableReason];

/**
 * The persisted switches that decide whether a lane is in play at all.
 *
 * Only settings belong here. A live gate — online, credentialed, org policy
 * resolved, compute target present — is exactly what this module refuses to
 * accept as a reason, so nothing of that kind may be added to this type.
 */
export type CloudReadLaneConfig = {
  /** The user's own `transcriptSyncEnabled` toggle. */
  transcriptSyncEnabled: boolean;
};

/**
 * Why {@link lane} is not applicable under {@link config}, or `null` when it is
 * applicable — or when no configuration switch governs it.
 *
 * Four of the five lanes have no such switch: they are gated on identity,
 * connectivity and org policy, all of which are live state that reopens. They
 * answer `null` by design, and that keeps a surface waiting on them.
 */
export function cloudReadLaneNotApplicableReason(
  lane: SyncLaneId,
  config: CloudReadLaneConfig
): CloudReadLaneNotApplicableReason | null {
  if (lane === SyncLaneId.TranscriptArchive && !config.transcriptSyncEnabled) {
    return CloudReadLaneNotApplicableReason.DisabledByConfig;
  }
  return null;
}
