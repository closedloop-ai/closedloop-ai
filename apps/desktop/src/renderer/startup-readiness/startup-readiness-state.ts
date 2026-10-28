import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status";
import { AgentMonitorRuntimeStatusKind } from "../../shared/agent-monitor-status";
import type { CloudSyncBacklog } from "../../shared/cloud-read-readiness-contract";
import { CloudSyncBacklogState } from "../../shared/cloud-read-readiness-contract";
import type { QuarantinedStageCounts } from "../../shared/ingest-quarantine-contract";
import { MaintenancePhase } from "../../shared/maintenance-progress-contract";
import {
  describeAllLaneRemainders,
  describeItemsRemaining,
  describeQuarantinedSessionImpact,
  describeQuarantinedSources,
  formatCount,
  resolveQuarantinedStageCounts,
} from "../components/import-progress-display";
import { isBootImportDegraded } from "../hooks/ingest-progress-terminal";
import type { CloudStatus } from "../hooks/use-cloud-status";
import { CloudStatusKind } from "../hooks/use-cloud-status";
import type { CloudSyncProgress } from "../hooks/use-cloud-sync-progress";
import type {
  IngestProgress,
  MaintenanceProgress,
} from "../hooks/use-ingest-progress";

export const StartupReadinessPhase = {
  OpeningStore: "opening-store",
  LoadingSaved: "loading-saved",
  CheckingHistory: "checking-history",
  ProcessingHistory: "processing-history",
  PreparingViews: "preparing-views",
  SyncingCloud: "syncing-cloud",
  SyncDeadLettered: "sync-dead-lettered",
  NeedsAttention: "needs-attention",
  Ready: "ready",
  Hidden: "hidden",
} as const;

export type StartupReadinessPhase =
  (typeof StartupReadinessPhase)[keyof typeof StartupReadinessPhase];

export const StartupReadinessStepState = {
  Complete: "complete",
  Active: "active",
  Pending: "pending",
  Warning: "warning",
} as const;

export type StartupReadinessStepState =
  (typeof StartupReadinessStepState)[keyof typeof StartupReadinessStepState];

export const SavedSessionsReadinessStatus = {
  Loading: "loading",
  Ready: "ready",
  Error: "error",
} as const;

export type SavedSessionsReadinessStatus =
  (typeof SavedSessionsReadinessStatus)[keyof typeof SavedSessionsReadinessStatus];

export type StartupReadinessStep = {
  id: "saved" | "history" | "views";
  label: string;
  description: string;
  state: StartupReadinessStepState;
};

export type StartupReadinessModel = {
  phase: StartupReadinessPhase;
  headline: string;
  detail: string;
  savedSessionCount: number | null;
  sourceFileProgress: {
    processed: number;
    total: number;
    percentage: number;
  } | null;
  cloudPendingCount: number | null;
  cloudWarning: string | null;
  cloudVerified: boolean;
  /**
   * ISS-4715: cloud egress is off by choice. NOT a warning and NOT a blank —
   * the row states it, muted. Mutually exclusive with `cloudWarning` by
   * construction: `getCloudWarning` answers `null` for this status.
   */
  cloudDisabled: boolean;
  steps: readonly StartupReadinessStep[];
  /**
   * ISS-6241: how far the live derived-view maintenance pass has drained its own
   * population, or `null` for every other phase and whenever the pass cannot
   * substantiate a total. Nothing here is derived or defaulted — a total the
   * producer did not send is not invented.
   */
  maintenanceProgress: { processed: number; total: number } | null;
};

export type StartupReadinessInputs = {
  agentMonitor: AgentMonitorRuntimeStatus | null;
  savedSessions: {
    status: SavedSessionsReadinessStatus;
    total: number | null;
  };
  ingest: IngestProgress | null;
  maintenance: MaintenanceProgress | null;
  maintenanceSettled: boolean;
  cloudSync: CloudSyncProgress | null;
  /**
   * ISS-5768: the whole-app, all-lanes backlog. `cloudSync.caughtUp` is the
   * session lane alone, so a panel that verified the cloud on it alone declared
   * history fully synced while thousands of component-inventory rows were still
   * on the machine. This is the aggregate that answers that question.
   */
  cloudSyncBacklog: CloudSyncBacklog;
  cloudStatus: CloudStatus | null;
  /**
   * ISS-11668: the user has answered the sync-consent choice for this account.
   * Syncing only begins after that election (Marisol, #symphony-dev 2026-09-30),
   * so every cloud phase waits on it.
   */
  syncElected: boolean;
};

const STEP_COPY = {
  saved: {
    id: "saved",
    label: "Saved sessions",
    description: "Open the local store and make existing sessions available.",
  },
  history: {
    id: "history",
    label: "Local history",
    description: "Check supported agent tools for new or changed sessions.",
  },
  views: {
    id: "views",
    label: "Session views",
    description: "Refresh timelines, links, and summaries from verified data.",
  },
} as const;

export function buildStartupReadinessModel(
  inputs: StartupReadinessInputs
): StartupReadinessModel {
  const savedSessionCount = sanitizeCount(inputs.savedSessions.total);
  const sourceFileProgress = getSourceFileProgress(inputs.ingest);
  const malformedProgress = hasMalformedProgress(inputs.ingest);
  const malformedSavedSessions =
    inputs.savedSessions.status === SavedSessionsReadinessStatus.Ready &&
    savedSessionCount === null;
  const quarantinedCount = sanitizeCount(inputs.ingest?.quarantinedCount) ?? 0;
  const quarantinedByStage = resolveQuarantinedStageCounts(
    inputs.ingest ?? null
  );
  const cloudPendingCount = getCloudPendingCount(inputs.cloudSync);
  const cloudBacklog = getEngagedCloudBacklog(
    inputs.cloudSync,
    inputs.cloudSyncBacklog
  );
  const cloudWarningVerdict = getCloudWarning(
    inputs.cloudSync,
    inputs.cloudStatus,
    cloudBacklog
  );
  const cloudWarning = cloudWarningVerdict?.message ?? null;
  // ISS-5768: "verified" means EVERY lane owes nothing, not just the session
  // one. `caughtUp` stays in the conjunction as the live per-poll signal (the
  // burn-down behind the backlog samples once a minute), so the panel cannot
  // announce a clean finish ahead of the session lane either.
  const cloudVerified =
    inputs.cloudSync?.identified === true &&
    inputs.cloudSync.caughtUp === true &&
    inputs.cloudSyncBacklog.state === CloudSyncBacklogState.Drained &&
    cloudWarning === null;
  const cloudChecking = isCloudChecking(inputs.cloudSync, cloudWarning);
  const cloudDisabled = inputs.cloudStatus?.kind === CloudStatusKind.Disabled;
  const phase = getPhase({
    ...inputs,
    malformedProgress,
    malformedSavedSessions,
    quarantinedCount,
    cloudWarning: cloudWarningVerdict,
  });

  return {
    phase,
    headline: getHeadline(phase, savedSessionCount, cloudWarning),
    detail: getDetail({
      phase,
      sourceFileProgress,
      cloudBacklog,
      cloudPendingCount,
      cloudChecking,
      quarantinedCount,
      quarantinedByStage,
      agentMonitorReason: inputs.agentMonitor?.reason ?? null,
      cloudVerified,
      cloudDisabled,
    }),
    savedSessionCount,
    sourceFileProgress,
    cloudPendingCount,
    cloudWarning,
    cloudVerified,
    cloudDisabled,
    steps: buildSteps(phase),
    maintenanceProgress: getMaintenanceProgress(inputs, phase),
  };
}

type PhaseInputs = StartupReadinessInputs & {
  malformedProgress: boolean;
  malformedSavedSessions: boolean;
  quarantinedCount: number;
  cloudWarning: CloudWarning | null;
};

function getPhase(inputs: PhaseInputs): StartupReadinessPhase {
  if (inputs.agentMonitor?.kind === AgentMonitorRuntimeStatusKind.Failed) {
    return inputs.agentMonitor.dbAhead
      ? StartupReadinessPhase.Hidden
      : StartupReadinessPhase.NeedsAttention;
  }
  if (
    inputs.agentMonitor === null ||
    inputs.agentMonitor.kind === AgentMonitorRuntimeStatusKind.Starting
  ) {
    return StartupReadinessPhase.OpeningStore;
  }
  if (inputs.savedSessions.status === SavedSessionsReadinessStatus.Error) {
    return StartupReadinessPhase.NeedsAttention;
  }
  if (inputs.savedSessions.status !== SavedSessionsReadinessStatus.Ready) {
    return StartupReadinessPhase.LoadingSaved;
  }
  if (
    inputs.malformedProgress ||
    inputs.malformedSavedSessions ||
    // ISS-6207: EITHER degraded boot-import terminal routes here. A settled
    // import that gave up on outstanding sources used to arrive as `complete`,
    // so this panel latched Ready over sessions that were never imported.
    (inputs.ingest !== null && isBootImportDegraded(inputs.ingest)) ||
    inputs.quarantinedCount > 0
  ) {
    return StartupReadinessPhase.NeedsAttention;
  }
  if (inputs.ingest === null || inputs.ingest.preparing) {
    return StartupReadinessPhase.CheckingHistory;
  }
  if (!inputs.ingest.complete) {
    return StartupReadinessPhase.ProcessingHistory;
  }
  // ISS-11668: the cloud outranks the view rebuild. Parsing is over here, and
  // the bar shows the syncing treatment whenever syncing is the only work left
  // (Marisol, #symphony-dev 2026-09-30), so a rebuild must not mask it.
  const cloudPhase = inputs.syncElected ? getCloudPhase(inputs) : null;
  if (cloudPhase !== null) {
    return cloudPhase;
  }
  if (inputs.maintenance?.active === true || !inputs.maintenanceSettled) {
    return StartupReadinessPhase.PreparingViews;
  }
  return StartupReadinessPhase.Ready;
}

function getHeadline(
  phase: StartupReadinessPhase,
  savedSessionCount: number | null,
  cloudWarning: string | null
): string {
  if (phase === StartupReadinessPhase.SyncDeadLettered) {
    return cloudWarning ?? "";
  }
  if (phase === StartupReadinessPhase.OpeningStore) {
    return "Opening your session library";
  }
  if (phase === StartupReadinessPhase.LoadingSaved) {
    return "Loading saved sessions";
  }
  if (phase === StartupReadinessPhase.Hidden) {
    return "";
  }
  if (phase === StartupReadinessPhase.NeedsAttention) {
    return savedSessionCount === null
      ? "Session library needs attention"
      : `${formatSavedSessions(savedSessionCount)} still available`;
  }
  if (phase === StartupReadinessPhase.Ready) {
    if (savedSessionCount === null) {
      return "Sessions are up to date";
    }
    if (savedSessionCount === 0) {
      return "No saved sessions found";
    }
    return `${formatSavedSessions(savedSessionCount)} up to date`;
  }
  return savedSessionCount === null
    ? "Your saved sessions are ready"
    : `${formatSavedSessions(savedSessionCount)} ready`;
}

function getDetail({
  phase,
  sourceFileProgress,
  cloudBacklog,
  cloudPendingCount,
  cloudChecking,
  quarantinedCount,
  quarantinedByStage,
  agentMonitorReason,
  cloudVerified,
  cloudDisabled,
}: {
  phase: StartupReadinessPhase;
  sourceFileProgress: StartupReadinessModel["sourceFileProgress"];
  cloudBacklog: CloudSyncBacklog | null;
  cloudPendingCount: number | null;
  cloudChecking: boolean;
  quarantinedCount: number;
  quarantinedByStage: QuarantinedStageCounts;
  agentMonitorReason: string | null;
  cloudVerified: boolean;
  cloudDisabled: boolean;
}): string {
  if (phase === StartupReadinessPhase.OpeningStore) {
    return "Starting the private on-device store.";
  }
  if (phase === StartupReadinessPhase.LoadingSaved) {
    return "Your existing sessions will appear before background freshness work finishes.";
  }
  if (phase === StartupReadinessPhase.CheckingHistory) {
    return "Checking local agent history for anything new.";
  }
  if (phase === StartupReadinessPhase.ProcessingHistory) {
    return getProcessingDetail(sourceFileProgress);
  }
  if (phase === StartupReadinessPhase.PreparingViews) {
    return "Refreshing timelines, links, and summaries from verified local data.";
  }
  if (phase === StartupReadinessPhase.SyncingCloud) {
    return getCloudDetail(cloudChecking, cloudPendingCount, cloudBacklog);
  }
  if (phase === StartupReadinessPhase.NeedsAttention) {
    return getAttentionDetail(
      quarantinedCount,
      quarantinedByStage,
      agentMonitorReason
    );
  }
  if (phase === StartupReadinessPhase.Ready) {
    if (cloudDisabled) {
      // Says what was and was NOT done. "Up to date" would claim a freshness
      // check that never ran, and the bare sentence would leave the reader to
      // assume one did.
      return "Local history checked just now. Cloud sync is off.";
    }
    return cloudVerified
      ? "Local history checked and cloud history is up to date."
      : "Local history checked just now.";
  }
  return "";
}

function getProcessingDetail(
  sourceFileProgress: StartupReadinessModel["sourceFileProgress"]
): string {
  if (sourceFileProgress) {
    return `Reading ${sourceFileProgress.processed.toLocaleString()} of ${sourceFileProgress.total.toLocaleString()} source files in the background.`;
  }
  return "Reading newly discovered agent history in the background.";
}

/**
 * ISS-5768 (codex review on #4809): the whole-app remainder outranks the
 * session-lane one. `cloudPendingCount` is `pendingBackfillSessions` — one of
 * the five lanes in `main/sync/AGENTS.md` — so on the reported machine it read
 * `0 historical sessions remaining` while 2,985 component rows were still here.
 * The detail line has to say what the backlog says.
 */
function getCloudDetail(
  cloudChecking: boolean,
  cloudPendingCount: number | null,
  cloudBacklog: CloudSyncBacklog | null
): string {
  if (
    cloudBacklog?.state === CloudSyncBacklogState.Outstanding &&
    cloudBacklog.itemsRemaining !== null
  ) {
    // ISS-6206: the per-lane breakdown when one was computed, so this panel and
    // the Settings cell report the same backlog in the same units. `null` is
    // the flag-off path and keeps the pre-ISS-6206 cross-lane total.
    // This is a detail line, not a status label, so it names every lane rather
    // than collapsing the tail into "and N more" (whitlockk review on #5050).
    const remaining =
      describeAllLaneRemainders(cloudBacklog.laneRemainders) ??
      describeItemsRemaining(
        cloudBacklog.itemsRemaining,
        cloudBacklog.itemsRemainingIsLowerBound
      );
    return `${remaining} still to upload to your workspace; local sessions stay usable.`;
  }
  if (cloudBacklog?.state === CloudSyncBacklogState.Unknown) {
    // Not "catching up in the background" — nothing has established there is
    // anything to catch up on, or that there is not.
    return "Checking whether your history is fully synced; local sessions stay usable.";
  }
  if (cloudChecking) {
    return "Checking cloud freshness while local sessions stay usable.";
  }
  return cloudPendingCount === null
    ? "Cloud history is catching up in the background."
    : `${formatCount(cloudPendingCount, "historical session")} remaining to sync; local sessions stay usable.`;
}

function getAttentionDetail(
  quarantinedCount: number,
  quarantinedByStage: QuarantinedStageCounts,
  agentMonitorReason: string | null
): string {
  if (quarantinedCount > 0) {
    // ISS-6115 (whitlockk review): both halves of this sentence were false for an
    // import stall. The file WAS read — the write is what did not finish — and
    // the isolated importer can have committed earlier record groups before a
    // later one timed out, so existing sessions are NOT necessarily unchanged.
    const shortfall =
      describeQuarantinedSources(quarantinedByStage, "history file") ??
      `${formatCount(quarantinedCount, "history file")} couldn't be imported`;
    return `${shortfall}. ${describeQuarantinedSessionImpact(quarantinedByStage)}`;
  }
  return (
    agentMonitorReason ??
    "One startup source could not be verified. Existing sessions remain unchanged."
  );
}

function buildSteps(
  phase: StartupReadinessPhase
): readonly StartupReadinessStep[] {
  const activeIndex = getActiveStepIndex(phase);
  const warningIndex =
    phase === StartupReadinessPhase.NeedsAttention ? activeIndex : -1;
  return [STEP_COPY.saved, STEP_COPY.history, STEP_COPY.views].map(
    (step, index) => ({
      ...step,
      state: getStepState({ phase, index, activeIndex, warningIndex }),
    })
  );
}

function getStepState({
  phase,
  index,
  activeIndex,
  warningIndex,
}: {
  phase: StartupReadinessPhase;
  index: number;
  activeIndex: number;
  warningIndex: number;
}): StartupReadinessStepState {
  if (index === warningIndex) {
    return StartupReadinessStepState.Warning;
  }
  if (index < activeIndex || phase === StartupReadinessPhase.Ready) {
    return StartupReadinessStepState.Complete;
  }
  if (index === activeIndex) {
    return StartupReadinessStepState.Active;
  }
  return StartupReadinessStepState.Pending;
}

function getActiveStepIndex(phase: StartupReadinessPhase): number {
  if (
    phase === StartupReadinessPhase.OpeningStore ||
    phase === StartupReadinessPhase.LoadingSaved
  ) {
    return 0;
  }
  if (
    phase === StartupReadinessPhase.CheckingHistory ||
    phase === StartupReadinessPhase.ProcessingHistory ||
    phase === StartupReadinessPhase.NeedsAttention
  ) {
    return 1;
  }
  return 2;
}

function getSourceFileProgress(
  ingest: IngestProgress | null
): StartupReadinessModel["sourceFileProgress"] {
  if (ingest === null || hasMalformedProgress(ingest) || ingest.total === 0) {
    return null;
  }
  return {
    processed: ingest.processed,
    total: ingest.total,
    percentage: Math.min(100, (ingest.processed / ingest.total) * 100),
  };
}

function hasMalformedProgress(ingest: IngestProgress | null): boolean {
  if (ingest === null) {
    return false;
  }
  return (
    sanitizeCount(ingest.total) === null ||
    sanitizeCount(ingest.processed) === null ||
    (ingest.quarantinedCount !== undefined &&
      sanitizeCount(ingest.quarantinedCount) === null) ||
    ingest.processed > ingest.total
  );
}

function getCloudPendingCount(
  progress: CloudSyncProgress | null
): number | null {
  if (progress === null || !progress.identified) {
    return null;
  }
  if (hasMalformedCloudSync(progress)) {
    return null;
  }
  return sanitizeCount(progress.pendingBackfillSessions);
}

function hasMalformedCloudSync(progress: CloudSyncProgress): boolean {
  return (
    sanitizeCount(progress.pendingBackfillSessions) === null ||
    sanitizeCount(progress.pendingIncrementalSessions) === null ||
    sanitizeCount(progress.deadLetteredSessions) === null ||
    (progress.deadLetteredComponents !== undefined &&
      sanitizeCount(progress.deadLetteredComponents) === null)
  );
}

/**
 * ISS-5768 (codex review on #4809): the abandoned count is the WHOLE-APP one,
 * floored by the two per-lane counts `progress` carries — the same
 * `Math.max` of two independently-fresh sources the History Sync cell takes in
 * `describeCouldNotSync`. `deadLetteredSessions` + `deadLetteredComponents`
 * cover two of the lanes, so an item abandoned in the invocation-parts or
 * transcript-archive lane raised no warning here at all and
 * the panel walked straight past it into `Ready`.
 */
function getCloudWarning(
  progress: CloudSyncProgress | null,
  status: CloudStatus | null,
  backlog: CloudSyncBacklog | null
): CloudWarning | null {
  // ISS-4715: OFF is not BROKEN. A connection the user switched off has nothing
  // to warn about, and warning anyway pinned `getPhase` at `NeedsAttention`
  // forever — the bar left only on `Ready`. The off-ness is still reported, as
  // a muted fact on the cloud row rather than as an alert; see `cloudDisabled`.
  if (status?.kind === CloudStatusKind.Disabled) {
    return null;
  }
  if (status?.kind === CloudStatusKind.Degraded) {
    return {
      kind: CloudWarningKind.Degraded,
      message:
        "Cloud connection needs attention. Local sessions remain available.",
    };
  }
  if (progress === null || !progress.identified) {
    return null;
  }
  if (hasMalformedCloudSync(progress)) {
    return {
      kind: CloudWarningKind.Unverified,
      message:
        "Cloud sync status could not be verified. Local sessions remain available.",
    };
  }
  const deadLetteredSessions =
    sanitizeCount(progress.deadLetteredSessions) ?? 0;
  const deadLetteredComponents =
    sanitizeCount(progress.deadLetteredComponents) ?? 0;
  const deadLettered = Math.max(
    deadLetteredSessions + deadLetteredComponents,
    sanitizeCount(backlog?.deadLetteredCount) ?? 0
  );
  if (deadLettered === 0) {
    return null;
  }
  // ISS-11668: "source files", matching the in-progress counter (operator
  // ruling, 2026-10-01).
  return {
    kind: CloudWarningKind.DeadLettered,
    message: `${formatCount(deadLettered, "source file")} could not sync. Local sessions remain available.`,
  };
}

function isCloudChecking(
  progress: CloudSyncProgress | null,
  warning: string | null
): boolean {
  if (progress === null || !progress.identified || warning !== null) {
    return false;
  }
  const pendingBackfill = sanitizeCount(progress.pendingBackfillSessions);
  const pendingIncremental = sanitizeCount(progress.pendingIncrementalSessions);
  return (
    progress.caughtUp === false &&
    pendingBackfill === 0 &&
    pendingIncremental === 0
  );
}

function sanitizeCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function formatSavedSessions(count: number): string {
  return formatCount(count, "saved session");
}

/**
 * ISS-5768: the whole-app backlog, but only once the cloud is actually in play.
 *
 * Every other cloud signal in this model is gated on `identified` — a machine
 * with no compute target has no cloud to be behind, though the burn-down
 * samples its lanes regardless. `null` means "the cloud is not this launch's
 * business".
 */
function getEngagedCloudBacklog(
  progress: CloudSyncProgress | null,
  backlog: CloudSyncBacklog
): CloudSyncBacklog | null {
  return progress?.identified === true ? backlog : null;
}

/**
 * ISS-6241: the maintenance pass's own position, or `null`.
 *
 * ISS-7819 retired the `compute-progress-count` Labs gate this used to read, so
 * the count ships unconditionally on both surfaces that report the rebuild.
 *
 * Still gated on the panel actually being ON the step the counts
 * describe, on the payload being the ONE phase that has a progress channel, and
 * on it carrying BOTH halves — `parseMaintenanceProgress` guarantees they arrive
 * together or not at all, and this re-checks rather than assuming, because the
 * cost of being wrong is a fabricated denominator on screen. Scoping it to
 * PreparingViews is what stops a count that outlived its phase being re-rendered
 * against a later step that measures something else.
 *
 * The `rebuild` check is the union's discriminant, not a redundant guard: an
 * active `artifact-links` pass is a `MaintenanceCountlessPayload`, which has no
 * counts to read at all.
 */
function getMaintenanceProgress(
  inputs: StartupReadinessInputs,
  phase: StartupReadinessPhase
): { processed: number; total: number } | null {
  const maintenance = inputs.maintenance;
  if (
    phase !== StartupReadinessPhase.PreparingViews ||
    maintenance === null ||
    maintenance.active !== true ||
    maintenance.phase !== MaintenancePhase.Rebuild
  ) {
    return null;
  }
  const { processed, total } = maintenance;
  if (processed === undefined || total === undefined) {
    return null;
  }
  return { processed, total };
}

/**
 * Why the cloud is warning. ISS-11668 treats a dead letter differently from the
 * other two (Marisol, #symphony-dev 2026-09-30): the bar states it, then leaves.
 */
const CloudWarningKind = {
  Degraded: "degraded",
  Unverified: "unverified",
  DeadLettered: "dead-lettered",
} as const;

type CloudWarningKind =
  (typeof CloudWarningKind)[keyof typeof CloudWarningKind];

type CloudWarning = { kind: CloudWarningKind; message: string };

function getCloudPhase(inputs: PhaseInputs): StartupReadinessPhase | null {
  const warning = inputs.cloudWarning;
  if (warning !== null && warning.kind !== CloudWarningKind.DeadLettered) {
    return StartupReadinessPhase.NeedsAttention;
  }
  // ISS-11668: a dead letter is stated once the sync has nothing else to do.
  // Stating it earlier ends the bar while the rest of the sync is still running.
  if (hasCloudWorkLeft(inputs.cloudSync)) {
    return StartupReadinessPhase.SyncingCloud;
  }
  return warning === null ? null : StartupReadinessPhase.SyncDeadLettered;
}

/**
 * Whether the session lane still has sessions to upload, which is what holds
 * the bar in `SyncingCloud`.
 *
 * ISS-11668 ruling 11 (operator, 2026-10-01): syncing is done when the counter
 * reaches 100%, so the bar leaves once session metadata is uploaded and full
 * transcripts keep uploading in the background with no bar. The lane's own
 * `caughtUp` is that answer: it waits on both queues and the pending parts
 * (`buildAgentSessionSyncProgress`), and a dead-lettered session is dequeued,
 * so a dead letter cannot pin it. ISS-5768's whole-app backlog no longer holds
 * the phase: it covers lanes the bar does not wait on. The term this replaces
 * read only the backfill queue, so a dead letter beside pending incremental
 * sessions ended the bar mid-sync (whitlockk review on #8290). The backlog still
 * decides `cloudVerified` and the detail line.
 */
function hasCloudWorkLeft(progress: CloudSyncProgress | null): boolean {
  return progress?.identified === true && !progress.caughtUp;
}
