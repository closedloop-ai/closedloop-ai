import {
  type OnboardingSessionDiscovery,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_SESSION_DISCOVERY,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import {
  FIXTURE_SESSION_DISCOVERY,
  measuredAnalysisProgress,
} from "@repo/app/onboarding/lib/guided-onboarding-fixtures";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../shared/agent-monitor-status";
import type { CloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
} from "../../../shared/sync-burndown-contract";
import {
  type CloudStatus,
  CloudStatusKind,
} from "../../hooks/use-cloud-status";
import type { CloudSyncProgress } from "../../hooks/use-cloud-sync-progress";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import {
  SavedSessionsReadinessStatus,
  type StartupReadinessInputs,
} from "../startup-readiness-state";
import type { StartupAnalysisRead } from "../use-startup-readiness";

/**
 * The ready-on-every-axis input the startup-readiness suites start from: each
 * case flips one axis and asserts the verdict that axis alone decides.
 */
export const COMPLETE_INGEST: IngestProgress = {
  byHarness: [],
  total: 0,
  processed: 0,
  preparing: false,
  complete: true,
  quarantinedCount: 0,
};

export const CAUGHT_UP_CLOUD_SYNC: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 0,
  pendingIncrementalSessions: 0,
  backfilling: false,
  caughtUp: true,
  deadLetteredSessions: 0,
};

/**
 * ISS-5768: every lane owes nothing — the only backlog that lets the panel
 * claim the cloud is up to date. Built through the production derivation rather
 * than hand-shaped, so a change to what "drained" means reaches this fixture.
 */
export const DRAINED_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog({
  sampledAtIso: "2026-08-10T12:00:00.000Z",
  importComplete: true,
  lanes: SYNC_LANE_IDS.map((lane) => ({
    lane,
    state: SyncLaneDrainState.Drained,
    resumeBlocked: false,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    unmeasuredRows: 0,
  })),
});

export const ONLINE_CLOUD_STATUS: CloudStatus = {
  kind: CloudStatusKind.Online,
};

export const READY_INPUTS: StartupReadinessInputs = {
  agentMonitor: READY_AGENT_MONITOR_RUNTIME_STATUS,
  savedSessions: {
    status: SavedSessionsReadinessStatus.Ready,
    total: 3087,
  },
  ingest: COMPLETE_INGEST,
  maintenance: { active: false, phase: null },
  maintenanceSettled: true,
  cloudSync: CAUGHT_UP_CLOUD_SYNC,
  cloudSyncBacklog: DRAINED_BACKLOG,
  cloudStatus: ONLINE_CLOUD_STATUS,
  syncElected: true,
};

/** No discovery measured yet: the parsing counter states nothing. */
export const UNMEASURED_ANALYSIS: StartupAnalysisRead = {
  discovery: UNKNOWN_SESSION_DISCOVERY,
  progress: UNKNOWN_ANALYSIS_PROGRESS,
};

/** The prototype's own fixture: 261 of 270 sessions analyzed, at 97%. */
export const MEASURED_ANALYSIS: StartupAnalysisRead = {
  discovery: FIXTURE_SESSION_DISCOVERY,
  progress: measuredAnalysisProgress(97),
};

/** The same machine before the store read lands: Y is known, X is not. */
export const ANALYZED_UNREAD_ANALYSIS: StartupAnalysisRead = {
  discovery: prototypeDiscoveryWith({ sessionsAnalyzed: null }),
  progress: measuredAnalysisProgress(97),
};

/** Discovery measured on its estimate alone, before the inventory reports. */
export const INVENTORY_PENDING_ANALYSIS: StartupAnalysisRead = {
  discovery: prototypeDiscoveryWith({
    logBytes: null,
    sessionsAnalyzed: null,
    sessionsFound: null,
  }),
  progress: measuredAnalysisProgress(97),
};

/** A machine whose sessions discovery cannot count (Cursor or Copilot only). */
export const UNCOUNTED_ANALYSIS: StartupAnalysisRead = {
  discovery: prototypeDiscoveryWith({
    sessionsAnalyzed: null,
    sessionsFound: null,
  }),
  progress: measuredAnalysisProgress(97),
};

/** The prototype's measured discovery with some of its counts replaced. */
function prototypeDiscoveryWith(counts: {
  logBytes?: number | null;
  sessionsAnalyzed: number | null;
  sessionsFound?: number | null;
}): OnboardingSessionDiscovery {
  if (FIXTURE_SESSION_DISCOVERY.status !== "measured") {
    throw new Error("the prototype discovery fixture is no longer measured");
  }
  return { ...FIXTURE_SESSION_DISCOVERY, ...counts };
}
