import { describe, expect, it } from "vitest";
import { AgentMonitorRuntimeStatusKind } from "../../../shared/agent-monitor-status";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  type StartupReadinessInputs,
  StartupReadinessPhase,
} from "../startup-readiness-state";
import {
  CAUGHT_UP_CLOUD_SYNC,
  COMPLETE_INGEST,
  DRAINED_BACKLOG,
  READY_INPUTS,
} from "./startup-readiness-fixtures";

// ISS-10696: the arms below were unpinned on the renderer lane. Each pins what
// main renders today — including the two fallbacks marked as odd.
describe("attention and hidden verdicts", () => {
  it("asks for attention on a failed store that is not DB-ahead, naming the reason", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: false,
        reason: "Store could not be opened.",
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.headline).toBe("3,087 saved sessions still available");
    expect(model.detail).toBe("Store could not be opened.");
  });

  it("falls back to the generic attention sentence when the runtime gives no reason", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: {
        status: SavedSessionsReadinessStatus.Error,
        total: null,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.headline).toBe("Session library needs attention");
    expect(model.detail).toBe(
      "One startup source could not be verified. Existing sessions remain unchanged."
    );
  });

  it("names quarantined files by the stage that failed them", () => {
    const parseOnly = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: { ...COMPLETE_INGEST, quarantinedCount: 2 },
    });
    expect(parseOnly.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(parseOnly.detail).toBe(
      "2 history files couldn't be read. Existing sessions are unchanged."
    );

    const importStall = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: {
        ...COMPLETE_INGEST,
        quarantinedCount: 3,
        quarantinedByStage: { parse: 1, import: 2 },
      },
    });
    expect(importStall.detail).toBe(
      "3 history files couldn't be imported. Some sessions may be partly imported."
    );
  });

  // pins current behavior (ISS-10700); looks odd because the top-level count says three
  // files were quarantined while the per-stage split says none were, and the
  // panel trusts the split for the sentence and the count for the fallback.
  it("falls back to the raw quarantined count when the per-stage split is empty", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: {
        ...COMPLETE_INGEST,
        quarantinedCount: 3,
        quarantinedByStage: { parse: 0, import: 0 },
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.detail).toBe(
      "3 history files couldn't be imported. Existing sessions are unchanged."
    );
  });
});

describe("headlines without a saved-session count", () => {
  it("names an empty library rather than an up-to-date one", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: { status: SavedSessionsReadinessStatus.Ready, total: 0 },
    });

    expect(model.phase).toBe(StartupReadinessPhase.Ready);
    expect(model.headline).toBe("No saved sessions found");
    expect(model.savedSessionCount).toBe(0);
  });

  it("routes a malformed saved total to attention before any counted headline", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: { status: SavedSessionsReadinessStatus.Ready, total: -1 },
      cloudSync: { ...CAUGHT_UP_CLOUD_SYNC, pendingBackfillSessions: 4 },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.headline).toBe("Session library needs attention");
    expect(model.savedSessionCount).toBeNull();
  });
});

describe("processing and cloud detail fallbacks", () => {
  it("reports background reading without counts while the scan has no total yet", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: { ...COMPLETE_INGEST, total: 0, processed: 0, complete: false },
    });

    expect(model.phase).toBe(StartupReadinessPhase.ProcessingHistory);
    expect(model.sourceFileProgress).toBeNull();
    expect(model.detail).toBe(
      "Reading newly discovered agent history in the background."
    );
  });

  it("raises attention for abandoned component rows even when the session lane reports none", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        caughtUp: false,
        deadLetteredComponents: 2,
      },
      cloudSyncBacklog: DRAINED_BACKLOG,
    });

    // The session lane is not caught up, so the line waits for it: ISS-11668
    // ruling 11 (operator, 2026-10-01).
    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
    expect(model.cloudWarning).toBe(
      "2 source files could not sync. Local sessions remain available."
    );
  });

  it("adds the abandoned component rows to the session ones in the warning", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        deadLetteredSessions: 1,
        deadLetteredComponents: 2,
      },
    });

    expect(model.cloudWarning).toBe(
      "3 source files could not sync. Local sessions remain available."
    );
    expect(model.cloudVerified).toBe(false);
  });
});

describe("maintenance progress", () => {
  const PREPARING_VIEWS: StartupReadinessInputs = {
    ...READY_INPUTS,
    maintenanceSettled: false,
  };

  it("reports the rebuild pass's own position while preparing views", () => {
    const model = buildStartupReadinessModel({
      ...PREPARING_VIEWS,
      maintenance: {
        active: true,
        phase: MaintenancePhase.Rebuild,
        processed: 12,
        total: 40,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.PreparingViews);
    expect(model.maintenanceProgress).toEqual({ processed: 12, total: 40 });
  });

  it("renders indeterminate when the rebuild pass has not substantiated a population", () => {
    const model = buildStartupReadinessModel({
      ...PREPARING_VIEWS,
      maintenance: { active: true, phase: MaintenancePhase.Rebuild },
    });

    expect(model.phase).toBe(StartupReadinessPhase.PreparingViews);
    expect(model.maintenanceProgress).toBeNull();
  });

  it("renders indeterminate when only one half of the pair arrived", () => {
    for (const half of [{ processed: 3 }, { total: 40 }]) {
      const model = buildStartupReadinessModel({
        ...PREPARING_VIEWS,
        maintenance: { active: true, phase: MaintenancePhase.Rebuild, ...half },
      });
      expect(model.maintenanceProgress).toBeNull();
    }
  });

  it("renders indeterminate while preparing views with no maintenance snapshot at all", () => {
    const model = buildStartupReadinessModel({
      ...PREPARING_VIEWS,
      maintenance: null,
    });

    expect(model.phase).toBe(StartupReadinessPhase.PreparingViews);
    expect(model.maintenanceProgress).toBeNull();
  });

  it("reports nothing for a countless pass, even while preparing views", () => {
    const model = buildStartupReadinessModel({
      ...PREPARING_VIEWS,
      maintenance: { active: true, phase: MaintenancePhase.ArtifactLinks },
    });

    expect(model.phase).toBe(StartupReadinessPhase.PreparingViews);
    expect(model.maintenanceProgress).toBeNull();
  });

  it("drops a count that outlived its phase", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: { ...COMPLETE_INGEST, total: 4, processed: 1, complete: false },
      maintenance: {
        active: true,
        phase: MaintenancePhase.Rebuild,
        processed: 12,
        total: 40,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.ProcessingHistory);
    expect(model.maintenanceProgress).toBeNull();
  });
});
