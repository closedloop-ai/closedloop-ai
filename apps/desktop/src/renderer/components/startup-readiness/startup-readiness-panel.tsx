"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentMonitorRuntimeStatusKind } from "../../../shared/agent-monitor-status";
import {
  useAgentMonitorStatus,
  useCloudStatus,
  useCloudSyncBacklog,
  useCloudSyncProgress,
  useIngestProgress,
  useMaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import { useLocalAgentSessionUsage } from "../sessions/use-local-agent-session-usage";
import { StartupReadinessPanelBody } from "./startup-readiness-panel-body";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  StartupReadinessPhase,
} from "./startup-readiness-state";

const REVEAL_DELAY_MS = 350;
const READY_HOLD_MS = 900;
const MAINTENANCE_BRIDGE_MS = 2500;

/**
 * ISS-4715: non-blocking startup truth for the whole desktop shell. Existing
 * rows become usable as soon as SQLite opens; history processing, derived-view
 * maintenance, and cloud freshness are reported as separate facts rather than
 * one fictional percentage.
 */
export function StartupReadinessPanel({
  // ISS-6241: the Compute-count Labs flag, read by `StartupReadinessBannerGate`
  // and passed down so this panel keeps reading no flags of its own. Defaults to
  // the flag-off behaviour: the Session views step names no population.
  showComputeProgress = false,
}: {
  showComputeProgress?: boolean;
} = {}) {
  const [done, setDone] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [paused, setPaused] = useState(false);
  const [maintenanceObserved, setMaintenanceObserved] = useState(false);
  const [maintenanceBridgeElapsed, setMaintenanceBridgeElapsed] =
    useState(false);
  const active = !done;
  const agentMonitor = useAgentMonitorStatus(active);
  const ingest = useIngestProgress(active);
  const maintenance = useMaintenanceProgress(active);
  const cloudSync = useCloudSyncProgress(active);
  // ISS-5768: the whole-app, all-lanes backlog behind `cloudVerified`. Same
  // shared 1s poller as `cloudSync` — no extra IPC round-trip.
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
  const waitingForMaintenanceBridge =
    ingest?.complete === true &&
    maintenance?.active !== true &&
    !maintenanceObserved &&
    !maintenanceBridgeElapsed;
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
    paused,
    showComputeProgress,
  });

  useEffect(() => {
    if (
      done ||
      waitingForMaintenanceBridge ||
      model.phase === StartupReadinessPhase.Hidden
    ) {
      return;
    }
    if (model.phase === StartupReadinessPhase.Ready && !revealed) {
      setDone(true);
      return;
    }
    if (!revealed) {
      const timer = globalThis.setTimeout(
        () => setRevealed(true),
        REVEAL_DELAY_MS
      );
      return () => globalThis.clearTimeout(timer);
    }
    if (model.phase === StartupReadinessPhase.Ready) {
      const timer = globalThis.setTimeout(() => setDone(true), READY_HOLD_MS);
      return () => globalThis.clearTimeout(timer);
    }
  }, [done, model.phase, revealed, waitingForMaintenanceBridge]);

  useEffect(() => {
    if (model.phase === StartupReadinessPhase.SyncingCloud) {
      setExpanded(false);
    }
  }, [model.phase]);

  const togglePause = useCallback(() => {
    const next = !paused;
    setPaused(next);
    globalThis.window.desktopApi
      ?.setAgentMonitorImportPaused(next)
      .catch(() => undefined);
  }, [paused]);

  if (done || !revealed || model.phase === StartupReadinessPhase.Hidden) {
    return null;
  }

  return (
    <StartupReadinessPanelBody
      expanded={expanded}
      model={model}
      onToggleExpanded={() => setExpanded((current) => !current)}
      onTogglePause={togglePause}
      paused={paused}
    />
  );
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
