"use client";

import type {
  OnboardingAnalysisProgress,
  OnboardingSessionDiscovery,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import type { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner";
import {
  deriveAnalysisBannerInputs,
  isDiscoveryReady,
} from "@repo/app/onboarding/lib/onboarding-analysis-banner-inputs";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { AgentMonitorRuntimeStatusKind } from "../../shared/agent-monitor-status";
import {
  deliveredSessions,
  inFlightTotalSessions,
  resolveSyncCounter,
} from "../components/sessions/cloud-sync-pending-sessions";
import { useLocalAgentSessionUsage } from "../components/sessions/use-local-agent-session-usage";
import { useAgentMonitorStatus } from "../hooks/use-agent-monitor-status";
import { useCloudStatus } from "../hooks/use-cloud-status";
import {
  type CloudSyncProgress,
  useCloudSyncBacklog,
  useCloudSyncProgress,
} from "../hooks/use-cloud-sync-progress";
import {
  useIngestProgress,
  useMaintenanceProgress,
} from "../hooks/use-ingest-progress";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  type StartupReadinessModel,
  StartupReadinessPhase,
} from "./startup-readiness-state";

const REVEAL_DELAY_MS = 350;
const MAINTENANCE_BRIDGE_MS = 2500;
// ISS-11668: how long the dead-letter line stays up before the bar leaves
// (operator ruling, 2026-10-01). Exported so the suite advances past this value
// rather than a copy of it.
export const SYNC_DEAD_LETTER_HOLD_MS = 3000;
const SOURCE_FILES_UNIT = "source files";
const STARTUP_STATUS_PROGRESS_LABEL = "Desktop startup status";

export type StartupReadinessBannerInputs = Omit<
  ComponentProps<typeof OnboardingAnalysisBanner>,
  "onHeightChange"
>;

const IDLE: StartupReadinessBannerInputs = {
  active: false,
  analyzed: null,
  found: null,
  label: null,
  percent: null,
};

export function useStartupReadiness({
  analysis,
  syncElected,
}: {
  /** The host's measured session discovery, for the parsing counter. */
  analysis: StartupAnalysisRead;
  /** The user's sync election lets data leave this Mac. */
  syncElected: boolean;
}): StartupReadinessBannerInputs {
  // ISS-11668: the pass settled before the user chose a sync option. Syncing
  // only begins after that election (Marisol, #symphony-dev 2026-09-30), so the
  // pass parks its pollers until the election wakes it.
  const [settledBeforeElection, setSettledBeforeElection] = useState(false);
  // ISS-11668: this sync's dead letters have been stated. The bar shows
  // whenever syncing happens (Marisol, 2026-10-01), so the pass never latches
  // shut, and dead letters outlive the sync that hit them; this keeps the line
  // to once per sync instead of every hold.
  const [deadLetterStated, setDeadLetterStated] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // The treatment the bar last showed, so its exit states that treatment's own
  // counter rather than another pass's.
  const lastShownRef = useRef<BarTreatment | null>(null);
  const [maintenanceObserved, setMaintenanceObserved] = useState(false);
  const [maintenanceBridgeElapsed, setMaintenanceBridgeElapsed] =
    useState(false);
  // Standing down feeds every poller below, so a pass parked until the sync
  // election releases THIS PASS'S six subscriptions rather than only hiding the
  // bar.
  //
  // It does NOT, on today's tree, stop the shared 1s IPC. That interval is
  // released only when its LAST subscriber leaves
  // (`use-runtime-status-poll.ts`), and the same host mounts
  // `useOnboardingSessionDiscovery(true)` beside this hook
  // (`components/onboarding/desktop-guided-onboarding-dialog-host.tsx`), which
  // subscribes with a hardcoded `true` and so holds the interval open for the
  // session on its own. Standing that read down would take the onboarding
  // wizard's live progress with it, which is a product call this hook does not
  // make — so what standing down buys here is the six parses and the renders
  // behind them, not the round-trip. Said plainly because the claim is easy to
  // over-read from this line alone.
  const standDown = settledBeforeElection && !syncElected;
  const active = !standDown;
  const agentMonitor = useAgentMonitorStatus(active);
  const ingest = useIngestProgress(active);
  const maintenance = useMaintenanceProgress(active);
  const cloudSync = useCloudSyncProgress(active);
  const cloudSyncBacklog = useCloudSyncBacklog(active);
  const cloudStatus = useCloudStatus(active);
  const monitorReady =
    agentMonitor?.kind === AgentMonitorRuntimeStatusKind.Ready;
  const savedSessionsQuery = useLocalAgentSessionUsage(
    {},
    { enabled: active && monitorReady }
  );

  useEffect(() => {
    if (maintenance?.active) {
      setMaintenanceObserved(true);
    }
  }, [maintenance?.active]);

  useEffect(() => {
    if (
      ingest?.complete !== true ||
      maintenance?.active === true ||
      maintenanceObserved
    ) {
      return;
    }
    const timer = globalThis.setTimeout(
      () => setMaintenanceBridgeElapsed(true),
      MAINTENANCE_BRIDGE_MS
    );
    return () => globalThis.clearTimeout(timer);
  }, [ingest?.complete, maintenance?.active, maintenanceObserved]);

  const maintenanceSettled = maintenanceObserved
    ? maintenance?.active !== true
    : maintenanceBridgeElapsed;
  const model = buildStartupReadinessModel({
    agentMonitor,
    savedSessions: {
      status: getSavedSessionsStatus({
        monitorReady,
        isError: savedSessionsQuery.isError,
        hasData: savedSessionsQuery.data !== undefined,
      }),
      total: savedSessionsQuery.data?.totalSessions ?? null,
    },
    ingest,
    maintenance,
    maintenanceSettled,
    cloudSync,
    cloudSyncBacklog,
    cloudStatus,
    syncElected,
  });
  const treatment = BAR_TREATMENT[model.phase];
  // ISS-11668 ruling 16 (operator, 2026-10-02): the bar's first frame shows
  // "X / Y", so parsing waits until Session discovery can state both.
  const parsingHeld =
    treatment === BarTreatment.Parsing && !isDiscoveryReady(analysis.discovery);
  const shown =
    treatment !== BarTreatment.Off &&
    !parsingHeld &&
    !(
      model.phase === StartupReadinessPhase.SyncDeadLettered && deadLetterStated
    );

  useEffect(() => {
    if (standDown) {
      return;
    }
    if (model.phase === StartupReadinessPhase.SyncingCloud) {
      // A new sync: its own dead letters get stated when it ends.
      setDeadLetterStated(false);
    }
    if (model.phase === StartupReadinessPhase.Ready && !syncElected) {
      setSettledBeforeElection(true);
    }
    if (!shown) {
      // Cleared so the next entry, the next sync, waits out the reveal delay
      // like the first one did.
      setRevealed(false);
      return;
    }
    if (!revealed) {
      const timer = globalThis.setTimeout(
        () => setRevealed(true),
        REVEAL_DELAY_MS
      );
      return () => globalThis.clearTimeout(timer);
    }
    if (model.phase === StartupReadinessPhase.SyncDeadLettered) {
      const timer = globalThis.setTimeout(
        () => setDeadLetterStated(true),
        SYNC_DEAD_LETTER_HOLD_MS
      );
      return () => globalThis.clearTimeout(timer);
    }
  }, [standDown, model.phase, shown, revealed, syncElected]);

  const counterSources: CounterSources = {
    analysis,
    cloudSync,
    files: model.sourceFileProgress,
  };
  if (standDown || !revealed || !shown) {
    return exitInputs(lastShownRef.current, counterSources);
  }
  lastShownRef.current = treatment;

  return {
    active: true,
    // Parsing and syncing say what the prototype says, which is the bar's
    // own default label: ISS-11668 rulings 8 and 10 (operator, 2026-10-01).
    // The dead-letter line keeps its own (rulings 6 and 7).
    label:
      treatment === BarTreatment.Parsing ||
      model.phase === StartupReadinessPhase.SyncingCloud
        ? null
        : model.headline,
    ...counterInputs(treatment, counterSources),
  };
}

function getSavedSessionsStatus({
  monitorReady,
  isError,
  hasData,
}: {
  monitorReady: boolean;
  isError: boolean;
  hasData: boolean;
}): SavedSessionsReadinessStatus {
  if (isError) {
    return SavedSessionsReadinessStatus.Error;
  }
  return monitorReady && hasData
    ? SavedSessionsReadinessStatus.Ready
    : SavedSessionsReadinessStatus.Loading;
}

/**
 * How each phase puts the bar on screen (ISS-11668, Marisol, #symphony-dev
 * 2026-09-30): the bar leaves once parsing completes and comes back for the
 * sync. `PreparingViews` is the post-parse rebuild, which is not parsing.
 */
const BarTreatment = {
  Off: "off",
  Stage: "stage",
  Parsing: "parsing",
  Syncing: "syncing",
} as const;

type BarTreatment = (typeof BarTreatment)[keyof typeof BarTreatment];

const BAR_TREATMENT = {
  [StartupReadinessPhase.OpeningStore]: BarTreatment.Parsing,
  [StartupReadinessPhase.LoadingSaved]: BarTreatment.Parsing,
  [StartupReadinessPhase.CheckingHistory]: BarTreatment.Parsing,
  [StartupReadinessPhase.ProcessingHistory]: BarTreatment.Parsing,
  [StartupReadinessPhase.PreparingViews]: BarTreatment.Off,
  [StartupReadinessPhase.SyncingCloud]: BarTreatment.Syncing,
  [StartupReadinessPhase.SyncDeadLettered]: BarTreatment.Syncing,
  [StartupReadinessPhase.NeedsAttention]: BarTreatment.Stage,
  [StartupReadinessPhase.Ready]: BarTreatment.Off,
  [StartupReadinessPhase.Hidden]: BarTreatment.Off,
} as const satisfies Record<StartupReadinessPhase, BarTreatment>;

type CounterInputs = Pick<
  StartupReadinessBannerInputs,
  "analyzed" | "found" | "percent" | "counterUnit" | "progressLabel"
>;

function sourceFileCounterInputs(
  files: StartupReadinessModel["sourceFileProgress"]
): CounterInputs {
  return {
    analyzed: files?.processed ?? null,
    found: files?.total ?? null,
    counterUnit: SOURCE_FILES_UNIT,
    progressLabel: files
      ? "Agent history source files processed"
      : STARTUP_STATUS_PROGRESS_LABEL,
    percent: files?.percentage ?? null,
  };
}

/**
 * Sessions the lane has delivered over the total it measures them against.
 * The lane's own pair, the only one `resolveSyncCounter` derives: a count of
 * departures from the queue, which a withhold or a dead letter also produces,
 * cannot be called sessions synced. No unit and the default progress name, as parsing
 * shows: ISS-11668 ruling 10 (operator, 2026-10-01).
 */
function syncCounterInputs(progress: CloudSyncProgress | null): CounterInputs {
  const counter = resolveSyncCounter({
    delivered: deliveredSessions(progress),
    total: inFlightTotalSessions(progress),
  });
  return {
    analyzed: counter?.completed ?? null,
    found: counter?.total ?? null,
    percent: counter
      ? Math.min(100, (counter.completed / counter.total) * 100)
      : null,
  };
}

export type StartupAnalysisRead = {
  discovery: OnboardingSessionDiscovery;
  progress: OnboardingAnalysisProgress;
};

type CounterSources = {
  analysis: StartupAnalysisRead;
  cloudSync: CloudSyncProgress | null;
  files: StartupReadinessModel["sourceFileProgress"];
};

function counterInputs(
  treatment: BarTreatment,
  { analysis, cloudSync, files }: CounterSources
): CounterInputs {
  if (treatment === BarTreatment.Syncing) {
    return syncCounterInputs(cloudSync);
  }
  if (treatment === BarTreatment.Parsing) {
    return parsingCounterInputs(analysis);
  }
  return sourceFileCounterInputs(files);
}

/**
 * ISS-11668: the prototype's parsing counter, sessions analyzed over sessions
 * found with no unit and the bar's default progress name (operator ruling,
 * 2026-10-01: match the prototype). Taken from the derivation the
 * prototype-promoted bar already uses, including its per-harness fit check
 * (ISS-10582); its `active` verdict is the onboarding run's, not this pass's,
 * so only the numbers are read.
 */
function parsingCounterInputs({
  discovery,
  progress,
}: StartupAnalysisRead): CounterInputs {
  const { analyzed, found, percent } = deriveAnalysisBannerInputs({
    discovery,
    phase: undefined,
    progress,
    settled: false,
  });
  return { analyzed, found, percent };
}

/**
 * What the bar states while it leaves: the treatment it last showed, at its
 * current reading, so a finished sync slides out on its own counter rather than
 * the parse's (ISS-11668 ruling 15, operator, 2026-10-02). A field this leaves
 * null is held at its last value by the banner.
 */
function exitInputs(
  lastShown: BarTreatment | null,
  sources: CounterSources
): StartupReadinessBannerInputs {
  if (lastShown === null) {
    return IDLE;
  }
  return { active: false, label: null, ...counterInputs(lastShown, sources) };
}
