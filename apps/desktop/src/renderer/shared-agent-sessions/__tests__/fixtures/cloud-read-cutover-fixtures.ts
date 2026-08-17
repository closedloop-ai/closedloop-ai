import type {
  CloudReadLaneReadiness,
  CloudReadReadinessSnapshot,
} from "../../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../../shared/sync-burndown-contract";
import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "../../desktop-app-core-mode";

/**
 * Shared ISS-5477 fixtures. Several suites across `shared-agent-sessions/` and
 * `components/dashboard/` need the same "signed in, corpus still uploading" and
 * "everything drained" shapes, so they are built once here rather than
 * hand-rolled per file where they would quietly drift apart.
 */

/** A lane that owes the cloud nothing. Override to make it owe something. */
export function laneReadiness(
  overrides: Partial<CloudReadLaneReadiness> = {}
): CloudReadLaneReadiness {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
    ...overrides,
  };
}

/**
 * ISS-6206 (wongk review on #5050): the named lanes, PLUS a drained row for
 * every other lane the burn-down reports.
 *
 * The reporter emits all five lanes on every sample, and the readiness channel
 * now rejects any payload that does not carry exactly that set — because a
 * truncated one is what let one drained lane cut the whole app over to the
 * cloud. So a fixture naming a single lane is no longer a smaller real
 * snapshot; it is a malformed one, and a test built on it would be asserting
 * against a payload the app can never accept.
 */
export function fullLaneSet(
  named: readonly CloudReadLaneReadiness[]
): CloudReadLaneReadiness[] {
  const namedIds = new Set(named.map((lane) => lane.lane));
  return [
    ...named,
    ...SYNC_LANE_IDS.filter((lane) => !namedIds.has(lane)).map((lane) =>
      laneReadiness({ lane })
    ),
  ];
}

/** A readiness snapshot with everything genuinely drained. */
export function drainedReadiness(
  overrides: Partial<CloudReadReadinessSnapshot> = {}
): CloudReadReadinessSnapshot {
  return {
    sampledAtIso: "2026-08-07T12:00:00.000Z",
    importComplete: true,
    lanes: fullLaneSet([laneReadiness()]),
    ...overrides,
  };
}

/**
 * The reported bug's shape: a populated machine has signed in and its history is
 * still on its way up, so nothing of it is in the cloud yet.
 */
export function drainingReadiness(
  itemsRemaining = 3401
): CloudReadReadinessSnapshot {
  return drainedReadiness({
    lanes: fullLaneSet([
      laneReadiness({ state: SyncLaneDrainState.Draining, itemsRemaining }),
    ]),
  });
}

/** The decision a signed-out (or unmounted-provider) renderer sees. */
export function signedOutCutover(): CloudReadCutoverDecision {
  return {
    mode: DesktopAppCoreMode.Local,
    blocker: CloudReadCutoverBlocker.NotAuthenticated,
    failedOpen: false,
    latch: CloudReadCutoverLatch.None,
    itemsRemaining: null,
    deadLetteredCount: 0,
    cloudHoldsHistory: false,
  };
}

/** The decision once the backlog has genuinely drained. */
export function drainedCutover(): CloudReadCutoverDecision {
  return {
    mode: DesktopAppCoreMode.Cloud,
    blocker: null,
    failedOpen: false,
    latch: CloudReadCutoverLatch.Drained,
    itemsRemaining: 0,
    deadLetteredCount: 0,
    cloudHoldsHistory: true,
  };
}

/** The decision while the reader is held local waiting on the upload backlog. */
export function drainingCutover(
  itemsRemaining = 3401
): CloudReadCutoverDecision {
  return {
    mode: DesktopAppCoreMode.Local,
    blocker: CloudReadCutoverBlocker.SyncDraining,
    failedOpen: false,
    latch: CloudReadCutoverLatch.None,
    itemsRemaining,
    deadLetteredCount: 0,
    cloudHoldsHistory: false,
  };
}
