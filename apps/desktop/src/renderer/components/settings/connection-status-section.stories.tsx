import type {
  CloudReadLaneReadiness,
  CloudSyncBacklog,
} from "../../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { ConnectionSecurityMode } from "../../../shared/connection-security";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import type {
  CloudStatus,
  CloudSyncProgress,
} from "../../hooks/use-ingest-progress";
import { CloudStatusKind } from "../../hooks/use-ingest-progress";
import { ConnectionStatusSection } from "./connection-status-section";

/**
 * ISS-5310 (wongk story review on PR #4484): the gateway health rollup that used
 * to sit behind the Labs flag as `GatewayHealthCard` now renders here
 * unconditionally, as the first cell of Connection Status — because behind an
 * off-by-default gate the one rollup you want when the desktop will not connect
 * was invisible to exactly the person who needs it.
 *
 * That makes three new states reachable on this card (Connected / Needs
 * Attention / Offline) plus two reworked formatters, and every one of them is
 * hard to force from a running app: you would have to actually kill the local
 * gateway, or half-kill it into reachable-but-unhealthy, to see two of the
 * three. The section is fully prop-driven, so a canvas can hold all of them side
 * by side.
 *
 * TONE NOTE — do not "fix" this by coloring the labels. `--success` /
 * `--warning` / `--destructive` are fill colors: as text on this card they
 * measure 3.18 / 1.71 / 3.91, all under WCAG 1.4.3's 4.5:1 for normal text. The
 * tone deliberately rides an `aria-hidden` dot while the label keeps the card
 * foreground and names the state in words. The sibling render test
 * (`settings-panel-labs-gateway-health`) runs in jsdom with no Tailwind loaded
 * and is structurally blind to contrast, so this canvas is where that stays
 * checkable.
 */
const meta = {
  title: "Desktop/Settings/Connection Status Section",
  component: ConnectionStatusSection,
  parameters: {
    layout: "padded",
  },
};

export default meta;

const STORY_GATEWAY_PORT = 41_234;

/**
 * Everything healthy: the gateway is reachable and reporting healthy, the port
 * validates, the cloud socket is online, remote commands are live, and history
 * is caught up. The success dot leads, the label reads "Connected".
 */
export const Connected = {
  render: () => (
    <ConnectionStatusSection
      cloudConnectionEnabled={true}
      cloudStatus={{ kind: CloudStatusKind.Online }}
      cloudSyncBacklog={DRAINED_BACKLOG}
      cloudSyncProgress={caughtUpSync()}
      gatewayHealthy={true}
      gatewayPort={STORY_GATEWAY_PORT}
      remoteCommandsPaused={false}
      security={{
        detail: "Enhanced — requests are signed",
        mode: ConnectionSecurityMode.Enhanced,
      }}
      serverAlive={true}
    />
  ),
};

/**
 * The degraded middle state, and the one worth having on a canvas at all: the
 * gateway is REACHABLE but is not reporting healthy (recovering, or a failing
 * liveness probe), so it is neither Connected nor Offline. Shown alongside a
 * failed cloud socket, paused remote commands, and a backfill still draining, so
 * the warning tone appears on more than one cell at once.
 *
 * ISS-5768 (wongk story review): the backlog here has to MATCH that draining
 * backfill. Pairing the draining `cloudSyncProgress` with a drained backlog made
 * History Sync render "Up to date" inside a story whose own caption said the
 * backfill was still running — a canvas contradicting itself, which is the exact
 * two-indicators-one-screen defect this ticket is named for.
 */
export const NeedsAttention = {
  render: () => (
    <ConnectionStatusSection
      cloudConnectionEnabled={true}
      cloudStatus={degradedCloudStatus()}
      cloudSyncBacklog={OUTSTANDING_BACKLOG}
      cloudSyncProgress={backfillingSync()}
      gatewayHealthy={false}
      gatewayPort={STORY_GATEWAY_PORT}
      remoteCommandsPaused={true}
      security={{ mode: ConnectionSecurityMode.SigningUnavailable }}
      serverAlive={true}
    />
  ),
};

/**
 * The local gateway server is confirmed down. Nothing downstream of it has a
 * value to report either, so the port and security cells fall to the shared
 * "..." placeholder and the cloud link reads Disabled — the row degrades
 * together rather than claiming a port on a server that is not listening.
 */
export const Offline = {
  render: () => (
    <ConnectionStatusSection
      cloudConnectionEnabled={false}
      cloudStatus={null}
      cloudSyncBacklog={DRAINED_BACKLOG}
      cloudSyncProgress={null}
      gatewayHealthy={false}
      gatewayPort={undefined}
      remoteCommandsPaused={false}
      security={undefined}
      serverAlive={false}
    />
  ),
};

/**
 * The reworked formatters on their rejection path, which is the whole reason
 * they were rewritten. The generic formatter this replaced printed any finite
 * number and any non-empty string, so an out-of-range port (`0`, `65536`) or a
 * stringified one rendered as if the gateway were really listening there. An
 * unusable port is not a port: both cells say "..." rather than something false.
 */
export const UnreportedPortAndSecurity = {
  render: () => (
    <ConnectionStatusSection
      cloudConnectionEnabled={true}
      cloudStatus={{ kind: CloudStatusKind.Unknown }}
      cloudSyncBacklog={DRAINED_BACKLOG}
      cloudSyncProgress={null}
      gatewayHealthy={true}
      gatewayPort={0}
      remoteCommandsPaused={false}
      security="enhanced"
      serverAlive={true}
    />
  ),
};

/**
 * ISS-5768 (wongk story review): the three History Sync states no other story
 * on this canvas reaches, side by side.
 *
 * They are the whole point of the ticket and every one of them is effectively
 * unreachable from a running app — you would have to wedge a lane, kill an item
 * into a dead letter, or catch the ~60s window before the burn-down's first
 * sample. The section is fully prop-driven, so the canvas can hold all three.
 *
 *   - Syncing: a lane still owes work. The one indicator whose count is the
 *     WHOLE-APP remainder, not the session lane's.
 *   - Sync issues (abandoned): every lane stopped, but one GAVE UP. Not a
 *     completeness claim, and deliberately not "Up to date".
 *   - Checking…: nothing has been measured yet. The state that must never round
 *     down to the happy one.
 */
export const HistorySyncStates = {
  render: () => (
    <div className="flex flex-col gap-6">
      <ConnectionStatusSection
        cloudConnectionEnabled={true}
        cloudStatus={{ kind: CloudStatusKind.Online }}
        cloudSyncBacklog={OUTSTANDING_BACKLOG}
        cloudSyncProgress={backfillingSync()}
        gatewayHealthy={true}
        gatewayPort={STORY_GATEWAY_PORT}
        remoteCommandsPaused={false}
        security={{ mode: ConnectionSecurityMode.Enhanced }}
        serverAlive={true}
      />
      <ConnectionStatusSection
        cloudConnectionEnabled={true}
        cloudStatus={{ kind: CloudStatusKind.Online }}
        cloudSyncBacklog={ABANDONED_BACKLOG}
        cloudSyncProgress={caughtUpSync()}
        gatewayHealthy={true}
        gatewayPort={STORY_GATEWAY_PORT}
        remoteCommandsPaused={false}
        security={{ mode: ConnectionSecurityMode.Enhanced }}
        serverAlive={true}
      />
      <ConnectionStatusSection
        cloudConnectionEnabled={true}
        cloudStatus={{ kind: CloudStatusKind.Online }}
        cloudSyncBacklog={UNKNOWN_BACKLOG}
        cloudSyncProgress={caughtUpSync()}
        gatewayHealthy={true}
        gatewayPort={STORY_GATEWAY_PORT}
        remoteCommandsPaused={false}
        security={{ mode: ConnectionSecurityMode.Enhanced }}
        serverAlive={true}
      />
    </div>
  ),
};

/** Every lane drained but one, built through the production derivation. */
function backlogWith(
  overrides: Partial<CloudReadLaneReadiness>,
  importComplete = true
): CloudSyncBacklog {
  return resolveCloudSyncBacklog({
    sampledAtIso: "2026-08-10T12:00:00.000Z",
    importComplete,
    lanes: SYNC_LANE_IDS.map((lane) => ({
      lane,
      state: SyncLaneDrainState.Drained,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
      ...(lane === overrides.lane ? overrides : {}),
    })),
  });
}

/**
 * ISS-5768: every lane owes nothing — the only backlog that lets the panel
 * claim the cloud is up to date. Built through the production derivation rather
 * than hand-shaped, so a change to what "drained" means reaches this fixture.
 */
const DRAINED_BACKLOG: CloudSyncBacklog = backlogWith({});

/** The reported machine: the session lanes are clean, the inventory is not. */
const OUTSTANDING_BACKLOG: CloudSyncBacklog = backlogWith({
  lane: SyncLaneId.ComponentInventory,
  state: SyncLaneDrainState.Draining,
  itemsRemaining: 2985,
});

/** Nothing left to attempt, and one item the invocation-parts lane gave up on. */
const ABANDONED_BACKLOG: CloudSyncBacklog = backlogWith({
  lane: SyncLaneId.InvocationParts,
  state: SyncLaneDrainState.DrainedWithDeadLetters,
  deadLetteredCount: 1,
});

/** Before the burn-down's first sample — ~60s of every launch (ISS-5749). */
const UNKNOWN_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog(null);

function caughtUpSync(): CloudSyncProgress {
  return {
    backfilling: false,
    caughtUp: true,
    deadLetteredComponents: 0,
    deadLetteredSessions: 0,
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
  };
}

function backfillingSync(): CloudSyncProgress {
  return {
    backfilling: true,
    caughtUp: false,
    deadLetteredComponents: 0,
    deadLetteredSessions: 0,
    identified: true,
    pendingBackfillSessions: 128,
    pendingIncrementalSessions: 0,
  };
}

function degradedCloudStatus(): CloudStatus {
  return {
    error: "Cloud relay handshake failed",
    kind: CloudStatusKind.Degraded,
  };
}
