import { ProgressTone } from "@closedloop-ai/design-system/components/ui/progress";
import { describe, expect, it } from "vitest";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../../shared/agent-monitor-status";
import { resolveCloudSyncBacklog } from "../../../../shared/cloud-read-readiness-contract";
import type { IngestProgress } from "../../../hooks/use-ingest-progress";
import {
  buildStartupProgressBarModel,
  isPausablePhase,
} from "../startup-readiness-progress";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  StartupPauseState,
  StartupReadinessPhase,
} from "../startup-readiness-state";

const INDETERMINATE_PHASES = [
  StartupReadinessPhase.OpeningStore,
  StartupReadinessPhase.LoadingSaved,
  StartupReadinessPhase.CheckingHistory,
  StartupReadinessPhase.ProcessingHistory,
  StartupReadinessPhase.PreparingViews,
  StartupReadinessPhase.SyncingCloud,
  StartupReadinessPhase.NeedsAttention,
] as const;

describe("buildStartupProgressBarModel", () => {
  it("claims no percentage for any phase that is not finished", () => {
    // ISS-5115: the readiness model has no overall completion figure, so every
    // in-flight (and stalled) phase must stay indeterminate. A regression that
    // reused `sourceFileProgress` as an overall percentage lands here.
    for (const phase of INDETERMINATE_PHASES) {
      expect(
        buildStartupProgressBarModel({ phase, paused: false }).value
      ).toBeNull();
    }
  });

  it("reports a real 100 only once startup is complete", () => {
    expect(
      buildStartupProgressBarModel({
        phase: StartupReadinessPhase.Ready,
        paused: false,
      }).value
    ).toBe(100);
  });

  it("gives every phase its own announced stage text", () => {
    const announced = Object.values(StartupReadinessPhase).map(
      (phase) =>
        buildStartupProgressBarModel({ phase, paused: false }).valueText
    );

    expect(announced.every((text) => text.length > 0)).toBe(true);
    expect(new Set(announced).size).toBe(announced.length);
  });

  it("freezes the bar when a startup source needs attention", () => {
    const bar = buildStartupProgressBarModel({
      phase: StartupReadinessPhase.NeedsAttention,
      paused: false,
    });

    expect(bar.paused).toBe(true);
    expect(bar.valueText).toBe("Startup needs attention");
    expect(bar.tone).toBe(ProgressTone.Warning);
  });

  it("keeps sweeping while work is genuinely in flight", () => {
    expect(
      buildStartupProgressBarModel({
        phase: StartupReadinessPhase.ProcessingHistory,
        paused: false,
      }).paused
    ).toBe(false);
  });

  it("freezes and re-announces the bar once the user pauses processing", () => {
    const bar = buildStartupProgressBarModel({
      phase: StartupReadinessPhase.ProcessingHistory,
      paused: true,
    });

    expect(bar.paused).toBe(true);
    expect(bar.valueText).toBe("History processing is paused");
    expect(bar.value).toBeNull();
  });

  it("ignores a stale paused flag in phases the pause control cannot stop", () => {
    // The Pause button is only offered during Checking/Processing. If `paused`
    // survives into cloud sync, the bar must not claim the sync was paused.
    const bar = buildStartupProgressBarModel({
      phase: StartupReadinessPhase.SyncingCloud,
      paused: true,
    });

    expect(bar.paused).toBe(false);
    expect(bar.valueText).toBe("Syncing cloud history");
  });

  it("says the same thing as the panel copy in every pausable phase", () => {
    // The Pause control is offered exactly where `isPausablePhase` is true, so
    // the detail line under the headline has to honour the pause there too —
    // otherwise a frozen bar sits above copy still claiming work is running.
    // ISS-5115 (wongk review): the request and the collector's acknowledgement
    // are separate states, and only the acknowledged one freezes the bar.
    const pausable = Object.values(StartupReadinessPhase).filter(
      isPausablePhase
    );
    expect(pausable.length).toBeGreaterThan(0);

    for (const phase of pausable) {
      expect(buildStartupProgressBarModel({ phase, paused: true }).paused).toBe(
        true
      );
      expect(
        buildStartupProgressBarModel({ phase, paused: false }).paused
      ).toBe(false);

      const running = modelFor(phase, { paused: false, parked: false });
      const pausing = modelFor(phase, { paused: true, parked: false });
      const stopped = modelFor(phase, { paused: true, parked: true });

      expect(running.phase).toBe(phase);
      expect(pausing.phase).toBe(phase);
      expect(stopped.phase).toBe(phase);

      expect(running.pauseState).toBe(StartupPauseState.Running);
      expect(pausing.pauseState).toBe(StartupPauseState.Pausing);
      expect(stopped.pauseState).toBe(StartupPauseState.Paused);

      expect(running.detail).not.toContain("paus");
      // The request is reported as in progress, never as already taken.
      expect(pausing.detail).toContain("Pausing");
      expect(pausing.detail).not.toContain("is paused");
      expect(stopped.detail).toContain("is paused");
    }
  });

  it("never lets Ready be downgraded by a stale paused flag", () => {
    const bar = buildStartupProgressBarModel({
      phase: StartupReadinessPhase.Ready,
      paused: true,
    });

    expect(bar.value).toBe(100);
    expect(bar.valueText).toBe("Startup complete");
  });
});

/**
 * Drives the real readiness derivation into `phase`, so the copy assertion
 * above runs against what the panel would render rather than a hand-written
 * string. The caller asserts the reached phase.
 */
function modelFor(
  phase: StartupReadinessPhase,
  { paused, parked }: { paused: boolean; parked: boolean }
) {
  return buildStartupReadinessModel({
    agentMonitor: READY_AGENT_MONITOR_RUNTIME_STATUS,
    savedSessions: { status: SavedSessionsReadinessStatus.Ready, total: 10 },
    ingest: ingestFor(phase, parked),
    maintenance: { active: false, phase: null },
    maintenanceSettled: true,
    cloudSync: null,
    // ISS-5768: no cloud identity here, so the backlog cannot change the phase;
    // the unmeasured one is the honest stand-in.
    cloudSyncBacklog: resolveCloudSyncBacklog(null),
    cloudStatus: null,
    paused,
  });
}

/**
 * Checking reaches its phase with NO ingest snapshot at all, so the pause
 * acknowledgement can only ride on a snapshot once one exists. A null snapshot
 * therefore always means "not acknowledged", which under-claims and is safe.
 */
function ingestFor(
  phase: StartupReadinessPhase,
  parked: boolean
): IngestProgress | null {
  if (phase !== StartupReadinessPhase.CheckingHistory) {
    return {
      byHarness: [],
      total: 10,
      processed: 4,
      preparing: false,
      complete: false,
      importParked: parked,
      quarantinedCount: 0,
    };
  }
  if (!parked) {
    return null;
  }
  return {
    byHarness: [],
    total: 0,
    processed: 0,
    preparing: true,
    complete: false,
    importParked: true,
    quarantinedCount: 0,
  };
}
