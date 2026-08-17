import type { AgentMonitorRuntimeStatus } from "../../../shared/agent-monitor-status";
import { AgentMonitorRuntimeStatusKind } from "../../../shared/agent-monitor-status";
import type { CloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { CloudSyncBacklogState } from "../../../shared/cloud-read-readiness-contract";
import type { QuarantinedStageCounts } from "../../../shared/ingest-quarantine-contract";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import type {
  CloudStatus,
  CloudSyncProgress,
  IngestProgress,
  MaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import { CloudStatusKind } from "../../hooks/use-ingest-progress";
import {
  describeAllLaneRemainders,
  describeItemsRemaining,
  describeQuarantinedSessionImpact,
  describeQuarantinedSources,
  formatCount,
  resolveQuarantinedStageCounts,
} from "../import-progress-display";

export const StartupReadinessPhase = {
  OpeningStore: "opening-store",
  LoadingSaved: "loading-saved",
  CheckingHistory: "checking-history",
  ProcessingHistory: "processing-history",
  PreparingViews: "preparing-views",
  SyncingCloud: "syncing-cloud",
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

/**
 * ISS-5115 (wongk review): a pause has two distinct facts, and collapsing them
 * let the panel claim work had stopped while it was still running. `Pausing` is
 * the user's request registered but not yet honoured — the collector only parks
 * at its next pause gate, and during first-launch source discovery that is the
 * whole scan. `Paused` is the collector confirming it parked.
 */
export const StartupPauseState = {
  Running: "running",
  Pausing: "pausing",
  Paused: "paused",
} as const;

export type StartupPauseState =
  (typeof StartupPauseState)[keyof typeof StartupPauseState];

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
  /** Request vs acknowledgement — see {@link StartupPauseState}. */
  pauseState: StartupPauseState;
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
  /** The user's pause REQUEST. Acknowledgement arrives via `ingest.importParked`. */
  paused: boolean;
  /**
   * ISS-6241 (ISS-4779 closed-by-default): surface the maintenance pass's real
   * per-session counts on the Session views step. Off by default and absent in
   * every existing caller, in which case the step renders exactly as it does
   * today.
   */
  showComputeProgress?: boolean;
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

/** One copy for every phase whose work the Pause control can stop (ISS-5115). */
const PAUSED_DETAIL =
  "History processing is paused. Your saved sessions remain available.";

/**
 * ISS-5115 (wongk review): "paused" is a request, not an outcome. The collector
 * only parks at its next pause gate, and during first-launch source discovery
 * (`listSources` + `loadExistingSessionIds` + `collectPendingSources` all run
 * before the first gate) that whole scan keeps running after the user clicks.
 * Reporting "paused" on the click alone let the panel claim work had stopped
 * while it had not, so the request and the acknowledgement are separate states.
 */
const PAUSING_DETAIL =
  "Pausing after the step already in progress finishes. Your saved sessions remain available.";

export function buildStartupReadinessModel(
  inputs: StartupReadinessInputs
): StartupReadinessModel {
  const pauseState = getPauseState(inputs.paused, inputs.ingest);
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
  const cloudWarning = getCloudWarning(
    inputs.cloudSync,
    inputs.cloudStatus,
    cloudBacklog
  );
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
  const phase = getPhase({
    ...inputs,
    malformedProgress,
    malformedSavedSessions,
    quarantinedCount,
    cloudBacklog,
    cloudPendingCount,
    cloudWarning,
    cloudChecking,
  });

  return {
    phase,
    headline: getHeadline(phase, savedSessionCount),
    pauseState,
    detail: getDetail({
      phase,
      pauseState,
      sourceFileProgress,
      cloudBacklog,
      cloudPendingCount,
      cloudChecking,
      quarantinedCount,
      quarantinedByStage,
      agentMonitorReason: inputs.agentMonitor?.reason ?? null,
      cloudVerified,
    }),
    savedSessionCount,
    sourceFileProgress,
    cloudPendingCount,
    cloudWarning,
    cloudVerified,
    steps: buildSteps(phase),
    maintenanceProgress: getMaintenanceProgress(inputs, phase),
  };
}

type PhaseInputs = StartupReadinessInputs & {
  malformedProgress: boolean;
  malformedSavedSessions: boolean;
  quarantinedCount: number;
  /** The whole-app backlog, or `null` when the cloud is not in play. */
  cloudBacklog: CloudSyncBacklog | null;
  cloudPendingCount: number | null;
  cloudWarning: string | null;
  cloudChecking: boolean;
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
    inputs.ingest?.timedOut === true ||
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
  if (inputs.maintenance?.active === true || !inputs.maintenanceSettled) {
    return StartupReadinessPhase.PreparingViews;
  }
  if (inputs.cloudWarning !== null) {
    return StartupReadinessPhase.NeedsAttention;
  }
  // ISS-5768 (codex review on #4809): the PHASE has to read the whole-app
  // backlog too, not just `cloudVerified`. Driving it off `cloudPendingCount` /
  // `cloudChecking` alone — both session-lane signals — let a machine whose
  // session queues had drained reach `Ready` while other lanes still owed
  // thousands of items, and `Ready` is what makes this panel latch shut. The
  // panel would have hidden the remaining work rather than reported it.
  if (
    (inputs.cloudPendingCount ?? 0) > 0 ||
    inputs.cloudChecking ||
    hasUnfinishedCloudBacklog(inputs.cloudBacklog)
  ) {
    return StartupReadinessPhase.SyncingCloud;
  }
  return StartupReadinessPhase.Ready;
}

function getHeadline(
  phase: StartupReadinessPhase,
  savedSessionCount: number | null
): string {
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
  if (phase === StartupReadinessPhase.SyncingCloud) {
    return savedSessionCount === null
      ? "Sessions are ready on this Mac"
      : `${formatSavedSessions(savedSessionCount)} ready on this Mac`;
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
  pauseState,
  sourceFileProgress,
  cloudBacklog,
  cloudPendingCount,
  cloudChecking,
  quarantinedCount,
  quarantinedByStage,
  agentMonitorReason,
  cloudVerified,
}: {
  phase: StartupReadinessPhase;
  pauseState: StartupPauseState;
  sourceFileProgress: StartupReadinessModel["sourceFileProgress"];
  cloudBacklog: CloudSyncBacklog | null;
  cloudPendingCount: number | null;
  cloudChecking: boolean;
  quarantinedCount: number;
  quarantinedByStage: QuarantinedStageCounts;
  agentMonitorReason: string | null;
  cloudVerified: boolean;
}): string {
  if (phase === StartupReadinessPhase.OpeningStore) {
    return "Starting the private on-device store.";
  }
  if (phase === StartupReadinessPhase.LoadingSaved) {
    return "Your existing sessions will appear before background freshness work finishes.";
  }
  if (phase === StartupReadinessPhase.CheckingHistory) {
    // ISS-5115: Pause is offered in this phase too, so the detail has to honour
    // it. Leaving it out let a frozen progress bar sit above copy still
    // claiming the check was running. It reports the REQUEST separately from the
    // acknowledgement, because the discovery scan runs on past the click.
    if (pauseState === StartupPauseState.Running) {
      return "Checking local agent history for anything new.";
    }
    return pauseState === StartupPauseState.Paused
      ? PAUSED_DETAIL
      : PAUSING_DETAIL;
  }
  if (phase === StartupReadinessPhase.ProcessingHistory) {
    return getProcessingDetail(pauseState, sourceFileProgress);
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
    return cloudVerified
      ? "Local history checked and cloud history is up to date."
      : "Local history checked just now.";
  }
  return "";
}

function getProcessingDetail(
  pauseState: StartupPauseState,
  sourceFileProgress: StartupReadinessModel["sourceFileProgress"]
): string {
  if (pauseState === StartupPauseState.Paused) {
    return PAUSED_DETAIL;
  }
  if (pauseState === StartupPauseState.Pausing) {
    return PAUSING_DETAIL;
  }
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
 * A phase held open by the backlog has to say what the backlog says.
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
    // than collapsing the tail into "and N more" (wongk review on #5050).
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
    // ISS-6115 (wongk review): both halves of this sentence were false for an
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
 * cover two of the five lanes, so an item abandoned in the invocation-parts,
 * transcript-archive, or trace-comment lane raised no warning here at all and
 * the panel walked straight past it into `Ready`.
 */
function getCloudWarning(
  progress: CloudSyncProgress | null,
  status: CloudStatus | null,
  backlog: CloudSyncBacklog | null
): string | null {
  if (status?.kind === CloudStatusKind.Degraded) {
    return "Cloud connection needs attention. Local sessions remain available.";
  }
  if (progress === null || !progress.identified) {
    return null;
  }
  if (hasMalformedCloudSync(progress)) {
    return "Cloud sync status could not be verified. Local sessions remain available.";
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
  return `${formatCount(deadLettered, "cloud record")} could not sync. Local sessions remain available.`;
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
 * A pause the user asked for is only reported as taken once the collector says
 * it parked. `importParked` is absent on an older main process, which resolves
 * to `Pausing` — under-claiming, which is the safe direction: it never asserts
 * work stopped when it may not have.
 */
function getPauseState(
  paused: boolean,
  ingest: IngestProgress | null
): StartupPauseState {
  if (!paused) {
    return StartupPauseState.Running;
  }
  return ingest?.importParked === true
    ? StartupPauseState.Paused
    : StartupPauseState.Pausing;
}

/**
 * ISS-5768: the whole-app backlog, but only once the cloud is actually in play.
 *
 * Every other cloud signal in this model is gated on `identified` — a machine
 * with no compute target has no cloud to be behind. The burn-down samples its
 * lanes regardless, so ungating this would pin a signed-out launch in
 * `SyncingCloud` forever on a backlog nobody is draining, and the panel would
 * never finish. `null` means "the cloud is not this launch's business".
 */
function getEngagedCloudBacklog(
  progress: CloudSyncProgress | null,
  backlog: CloudSyncBacklog
): CloudSyncBacklog | null {
  return progress?.identified === true ? backlog : null;
}

/**
 * Does the whole-app backlog still have something to say? Every state except
 * `drained` does: `outstanding` and `abandoned` name real work, and `unknown`
 * is the branch where completeness has NOT been established — which is exactly
 * the claim `Ready` would make on the user's behalf.
 *
 * ISS-6206 (wongk review on #5050): with ONE exception, and it is the exception
 * this function's sibling {@link getEngagedCloudBacklog} already documents for
 * signed-out launches. This phase gates a panel that must eventually finish, so
 * it may only wait on an `unknown` that waiting can resolve.
 * {@link CloudSyncBacklog.laneReadinessUnattested} marks the one that cannot:
 * every lane owes nothing, and the lanes that fell short of `drained` did so
 * because this app's CONFIGURATION puts them out of play, so the next sample of
 * that configuration answers the same thing. Strict lane readiness reaches that
 * verdict on the SHIPPED default config — transcript sync off means its lane is
 * switched off, not merely stopped — which would otherwise have pinned a
 * signed-in launch in `SyncingCloud` for the rest of the session, the same
 * never-finishing panel, one branch over.
 *
 * shafty023 review on #5050: a lane that is merely STOPPED does not reach that
 * verdict, and this branch is why it must not. `idle_not_running` covers
 * connectivity, credential, policy and compute-target gates that reopen on
 * their own, and dismissing on one of those would latch the panel shut moments
 * before the next burn-down exposed the newly eligible work. The aggregate
 * keeps `laneReadinessUnattested` false for those, so they land in the
 * `unknown` this function still waits on.
 *
 * Dead letters still hold the panel: they are real work the user has and the
 * cloud does not, so an unattested backlog carrying one is treated exactly as
 * the `abandoned` it resolves to with the flag off. Completeness surfaces are
 * unaffected — this backlog is still `unknown`, and `unknown` may never render
 * as caught up.
 */
function hasUnfinishedCloudBacklog(backlog: CloudSyncBacklog | null): boolean {
  if (backlog === null || backlog.state === CloudSyncBacklogState.Drained) {
    return false;
  }
  return !(backlog.laneReadinessUnattested && backlog.deadLetteredCount === 0);
}

/**
 * ISS-6241: the maintenance pass's own position, or `null`.
 *
 * Gated on the Labs flag, on the panel actually being ON the step the counts
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
    inputs.showComputeProgress !== true ||
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
