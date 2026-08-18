import { describe, expect, it } from "vitest";
import {
  AgentMonitorRuntimeStatusKind,
  READY_AGENT_MONITOR_RUNTIME_STATUS,
} from "../../../../shared/agent-monitor-status";
import { CloudReadLaneNotApplicableReason } from "../../../../shared/cloud-read-lane-applicability";
import type {
  CloudReadReadinessSnapshot,
  CloudSyncBacklog,
  ResolveCloudSyncBacklogOptions,
} from "../../../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../../shared/sync-burndown-contract";
import {
  type CloudStatus,
  CloudStatusKind,
  type CloudSyncProgress,
  type IngestProgress,
} from "../../../hooks/use-ingest-progress";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  StartupPauseState,
  type StartupReadinessInputs,
  StartupReadinessPhase,
  StartupReadinessStepState,
} from "../startup-readiness-state";

const COMPLETE_INGEST: IngestProgress = {
  byHarness: [],
  total: 0,
  processed: 0,
  preparing: false,
  complete: true,
  quarantinedCount: 0,
};

const CAUGHT_UP_CLOUD_SYNC: CloudSyncProgress = {
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
const DRAINED_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog({
  sampledAtIso: "2026-08-10T12:00:00.000Z",
  importComplete: true,
  lanes: SYNC_LANE_IDS.map((lane) => ({
    lane,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
  })),
});

const ONLINE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Online };

const READY_INPUTS: StartupReadinessInputs = {
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
  paused: false,
};

describe("buildStartupReadinessModel", () => {
  it("orders store opening before loading saved sessions", () => {
    const opening = buildStartupReadinessModel({
      ...READY_INPUTS,
      agentMonitor: null,
      savedSessions: {
        status: SavedSessionsReadinessStatus.Loading,
        total: null,
      },
    });
    const loading = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: {
        status: SavedSessionsReadinessStatus.Loading,
        total: null,
      },
    });

    expect(opening.phase).toBe(StartupReadinessPhase.OpeningStore);
    expect(opening.headline).toBe("Opening your session library");
    expect(loading.phase).toBe(StartupReadinessPhase.LoadingSaved);
    expect(loading.headline).toBe("Loading saved sessions");
  });

  it("makes saved sessions available before reporting source-file progress", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: {
        ...COMPLETE_INGEST,
        total: 14,
        processed: 13,
        complete: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.ProcessingHistory);
    expect(model.headline).toBe("3,087 saved sessions ready");
    expect(model.detail).toContain("13 of 14 source files");
    expect(model.sourceFileProgress).toEqual({
      processed: 13,
      total: 14,
      percentage: (13 / 14) * 100,
    });
    expect(model.steps.map((step) => step.state)).toEqual([
      StartupReadinessStepState.Complete,
      StartupReadinessStepState.Active,
      StartupReadinessStepState.Pending,
    ]);
  });

  it("keeps the view-preparation bridge ahead of the ready verdict", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      maintenanceSettled: false,
    });

    expect(model.phase).toBe(StartupReadinessPhase.PreparingViews);
    expect(model.detail).toContain(
      "Refreshing timelines, links, and summaries"
    );
  });

  it("reports historical cloud catch-up separately from local readiness", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingBackfillSessions: 750,
        backfilling: true,
        caughtUp: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
    expect(model.headline).toBe("3,087 saved sessions ready on this Mac");
    expect(model.detail).toContain("750 historical sessions remaining");
  });

  it("does not block readiness on one active incremental update", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingIncrementalSessions: 1,
        caughtUp: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.Ready);
    expect(model.headline).toBe("3,087 saved sessions up to date");
  });

  it("does not call an unresolved cloud verdict up to date", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        caughtUp: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
    expect(model.cloudVerified).toBe(false);
    expect(model.detail).toContain("Checking cloud freshness");
  });

  it("treats zero quarantined files as healthy", () => {
    const model = buildStartupReadinessModel(READY_INPUTS);

    expect(model.phase).toBe(StartupReadinessPhase.Ready);
  });

  it("surfaces malformed progress without inventing a percentage", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: {
        ...COMPLETE_INGEST,
        total: 4,
        processed: 5,
        complete: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.sourceFileProgress).toBeNull();
  });

  it("does not call a malformed saved-session total ready", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: {
        status: SavedSessionsReadinessStatus.Ready,
        total: Number.NaN,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.savedSessionCount).toBeNull();
  });

  it("does not call malformed cloud counters verified", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingBackfillSessions: Number.POSITIVE_INFINITY,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.cloudWarning).toContain("could not be verified");
  });

  it("keeps saved sessions visible when cloud records need attention", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        deadLetteredSessions: 2,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.headline).toBe("3,087 saved sessions still available");
    expect(model.cloudWarning).toContain("2 cloud records could not sync");
  });

  it("defers a DB-ahead failure to the existing higher-severity banner", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: true,
        reason: "Update required.",
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.Hidden);
  });
});

describe("pause acknowledgement", () => {
  // ISS-5115 (wongk review): the collector only parks at its next pause gate.
  // During first-launch source discovery the whole scan runs on past the click,
  // so a request must never be rendered as an outcome.
  const CHECKING_INPUTS: StartupReadinessInputs = {
    ...READY_INPUTS,
    ingest: { ...COMPLETE_INGEST, complete: false, preparing: true },
    cloudSync: null,
    maintenanceSettled: false,
  };

  it("reports a pause request as Pausing until the collector acknowledges it", () => {
    const model = buildStartupReadinessModel({
      ...CHECKING_INPUTS,
      paused: true,
    });

    expect(model.pauseState).toBe(StartupPauseState.Pausing);
    expect(model.detail).toContain("Pausing");
    expect(model.detail).not.toContain("is paused");
  });

  it("reports Paused once the collector reports it parked", () => {
    const model = buildStartupReadinessModel({
      ...CHECKING_INPUTS,
      ingest: {
        ...CHECKING_INPUTS.ingest,
        importParked: true,
      } as IngestProgress,
      paused: true,
    });

    expect(model.pauseState).toBe(StartupPauseState.Paused);
    expect(model.detail).toContain("is paused");
  });

  it("under-claims rather than over-claims when the field is absent", () => {
    // An older main process never sends `importParked`. Resolving that to
    // Paused would assert work stopped on no evidence at all.
    const model = buildStartupReadinessModel({
      ...CHECKING_INPUTS,
      paused: true,
    });

    expect(CHECKING_INPUTS.ingest?.importParked).toBeUndefined();
    expect(model.pauseState).toBe(StartupPauseState.Pausing);
  });

  it("is Running when no pause was requested, whatever the collector reports", () => {
    const model = buildStartupReadinessModel({
      ...CHECKING_INPUTS,
      ingest: {
        ...CHECKING_INPUTS.ingest,
        importParked: true,
      } as IngestProgress,
      paused: false,
    });

    expect(model.pauseState).toBe(StartupPauseState.Running);
  });
});

/**
 * ISS-5768 — the panel's "cloud history is up to date" claim is whole-app.
 *
 * `cloudVerified` used to be `identified && caughtUp && no warning`, and
 * `caughtUp` is the session backfill/incremental queues alone. On the reported
 * machine that was true while the component-inventory lane still owed 2,985
 * rows, so the panel declared the cloud verified over a ~3,000-item backlog.
 */
describe("buildStartupReadinessModel — whole-app cloud verification (ISS-5768)", () => {
  function backlogFor(
    lanes: Partial<CloudReadReadinessSnapshot["lanes"][number]>[],
    options: ResolveCloudSyncBacklogOptions = {}
  ): CloudSyncBacklog {
    return resolveCloudSyncBacklog(
      {
        sampledAtIso: "2026-08-10T12:00:00.000Z",
        importComplete: true,
        lanes: lanes.map((overrides) => ({
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.Drained,
          itemsRemaining: 0,
          itemsRemainingIsLowerBound: false,
          deadLetteredCount: 0,
          unmeasuredRows: 0,
          ...overrides,
        })),
      },
      options
    );
  }

  it("does not verify the cloud while another lane still owes work", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      // Exactly the reported state: the session lanes are drained.
      cloudSync: CAUGHT_UP_CLOUD_SYNC,
      cloudSyncBacklog: backlogFor([
        { lane: SyncLaneId.SessionMetadata },
        {
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2985,
        },
      ]),
    });
    expect(model.cloudVerified).toBe(false);
    expect(model.detail).not.toContain("cloud history is up to date");
  });

  it("does not verify the cloud while a lane has abandoned work", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSyncBacklog: backlogFor([
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 1,
          unmeasuredRows: 0,
        },
      ]),
    });
    expect(model.cloudVerified).toBe(false);
  });

  it("does not verify the cloud before anything has been measured", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSyncBacklog: resolveCloudSyncBacklog(null),
    });
    expect(model.cloudVerified).toBe(false);
  });

  it("verifies the cloud when every lane owes nothing", () => {
    // The counterfactual: same inputs, drained backlog. Without this the three
    // assertions above would pass on a `cloudVerified` that is simply never true.
    const model = buildStartupReadinessModel(READY_INPUTS);
    expect(model.cloudVerified).toBe(true);
    expect(model.detail).toContain("cloud history is up to date");
  });

  /**
   * ISS-5768 (codex review on #4809) — `cloudVerified` alone does not keep the
   * panel open.
   *
   * `Ready` is what makes this panel latch shut (`setDone(true)`, permanently).
   * Reaching it on the session-lane signals alone meant a machine still owing
   * thousands of items in other lanes dismissed the panel and the remaining work
   * went unreported — the same defect one layer over from the "Up to date" label.
   */
  describe("phase", () => {
    it("holds at Syncing — not Ready — while another lane still owes work", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog: backlogFor([
          { lane: SyncLaneId.SessionMetadata },
          {
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2985,
          },
        ]),
      });
      expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
      // …and it reports the WHOLE-APP remainder. `cloudPendingCount` is the
      // session lane, which on this machine is a clean 0.
      expect(model.detail).toContain("2,985 items still to upload");
      expect(model.detail).not.toContain("0 historical sessions");
    });

    /**
     * ISS-6206 (wongk review on #5050) — this panel's detail is the SECOND
     * surface the per-lane breakdown reaches, and it must name every lane.
     *
     * The launched-app pair for the flag selection lives in
     * `settings-labs-gateway-health.spec.ts`, which reads the History Sync cell
     * directly. It cannot live here: this panel is a phase machine, and
     * `SyncingCloud` sits behind quarantine and cloud-connection gates that a
     * launched E2E profile trips on its own (an unverified startup source and a
     * degraded socket both outrank a backlog, correctly). So the panel's own
     * copy is pinned at the level where the phase IS deterministic.
     */
    it("reports the backlog per lane, naming every lane, under strict readiness", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog: backlogFor(
          [
            {
              lane: SyncLaneId.SessionMetadata,
              state: SyncLaneDrainState.Draining,
              itemsRemaining: 2900,
            },
            {
              lane: SyncLaneId.TranscriptArchive,
              state: SyncLaneDrainState.Draining,
              itemsRemaining: 12,
            },
            {
              lane: SyncLaneId.TraceComments,
              state: SyncLaneDrainState.Draining,
              itemsRemaining: 7,
            },
          ],
          { strictLaneReadiness: true }
        ),
      });

      expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
      // A detail line, so the third lane is NAMED rather than collapsed into
      // "and 1 other kind" — that collapse belongs to the status label alone.
      expect(model.detail).toContain(
        "2,900 sessions, 12 transcripts and 7 comments"
      );
      expect(model.detail).not.toContain("1 more");
      // 2,900 outbox rows + 12 files + 7 comments is not "2,919" of anything.
      expect(model.detail).not.toContain("2,919");
    });

    it("keeps the single cross-lane total when strict readiness is off", () => {
      // The gate's counterfactual: same lanes, no strict option. Without it the
      // assertion above would pass on copy applied unconditionally.
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog: backlogFor([
          {
            lane: SyncLaneId.SessionMetadata,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2900,
          },
          {
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 12,
          },
          {
            lane: SyncLaneId.TraceComments,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 7,
          },
        ]),
      });

      expect(model.detail).toContain("2,919 items still to upload");
      expect(model.detail).not.toContain("2,900 sessions");
    });

    it("holds at Syncing while nothing has been measured yet", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog: resolveCloudSyncBacklog(null),
      });
      expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
      expect(model.detail).toContain(
        "Checking whether your history is fully synced"
      );
    });

    it("raises attention for work abandoned in a lane the session counts cannot see", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        // Both per-lane dead-letter counts are 0 — the abandoned item is in the
        // invocation-parts lane, which `CloudSyncProgress` cannot represent.
        cloudSync: { ...CAUGHT_UP_CLOUD_SYNC, deadLetteredComponents: 0 },
        cloudSyncBacklog: backlogFor([
          {
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
          },
        ]),
      });
      expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
      expect(model.cloudWarning).toBe(
        "1 cloud record could not sync. Local sessions remain available."
      );
    });

    it("reaches Ready when every lane owes nothing", () => {
      // The counterfactual for all three above: identical inputs, drained
      // backlog. Without it they would pass on a phase that never settles.
      expect(buildStartupReadinessModel(READY_INPUTS).phase).toBe(
        StartupReadinessPhase.Ready
      );
    });

    it("does not hold a signed-out launch open on a backlog nobody is draining", () => {
      // The burn-down samples its lanes with or without a compute target. Every
      // other cloud signal here is gated on `identified`; this one has to be too,
      // or a machine that never syncs never finishes starting up.
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: { ...CAUGHT_UP_CLOUD_SYNC, identified: false },
        cloudSyncBacklog: resolveCloudSyncBacklog(null),
      });
      expect(model.phase).toBe(StartupReadinessPhase.Ready);
      expect(model.cloudVerified).toBe(false);
    });

    /**
     * ISS-6206 (wongk review on #5050) — the signed-IN twin of the signed-out
     * case directly above, and the reason `laneReadinessUnattested` exists.
     *
     * `transcriptSyncEnabled` ships FALSE, so on a default machine the transcript
     * lane is never constructed, never runs, and reports `never_started` with a
     * clean zero on every sample. Under strict readiness that is permanently
     * `unknown` — not "still checking", but "nothing here will ever attest" — and
     * `unknown` is not `drained`, so the phase machine held `SyncingCloud` and
     * `setDone(true)` (which fires ONLY on `Ready`) never ran. A signed-in
     * machine on the shipped default config with both flags on could not dismiss
     * the startup panel for the rest of the session.
     */
    it("finishes at Ready when strict readiness can never attest a stopped lane", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: CAUGHT_UP_CLOUD_SYNC,
        cloudSyncBacklog: backlogFor(
          [
            { lane: SyncLaneId.SessionMetadata },
            { lane: SyncLaneId.InvocationParts },
            {
              // The shipped default: transcript sync off, so this lane never ran
              // — and the reason comes from the persisted setting, not from the
              // stopped sample (shafty023 review on #5050).
              lane: SyncLaneId.TranscriptArchive,
              notApplicableReason:
                CloudReadLaneNotApplicableReason.DisabledByConfig,
              state: SyncLaneDrainState.NeverStarted,
            },
            { lane: SyncLaneId.ComponentInventory },
            { lane: SyncLaneId.TraceComments },
          ],
          { strictLaneReadiness: true }
        ),
      });

      expect(model.phase).toBe(StartupReadinessPhase.Ready);
      // The panel finishing does NOT promote the backlog to a completeness
      // claim: strict readiness still refuses to call this cloud verified.
      expect(model.cloudVerified).toBe(false);
    });

    it("still holds the panel when an unattested lane sits beside abandoned work", () => {
      // The counterfactual for the case above: same never-started lane, one dead
      // letter added. Waiting cannot attest this cloud either, but there is real
      // work the user has and the cloud does not, so the panel must not finish.
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog: backlogFor(
          [
            { lane: SyncLaneId.SessionMetadata },
            {
              lane: SyncLaneId.InvocationParts,
              state: SyncLaneDrainState.DrainedWithDeadLetters,
              deadLetteredCount: 1,
            },
            {
              lane: SyncLaneId.TranscriptArchive,
              notApplicableReason:
                CloudReadLaneNotApplicableReason.DisabledByConfig,
              state: SyncLaneDrainState.NeverStarted,
            },
            { lane: SyncLaneId.ComponentInventory },
            { lane: SyncLaneId.TraceComments },
          ],
          { strictLaneReadiness: true }
        ),
      });

      expect(model.phase).not.toBe(StartupReadinessPhase.Ready);
    });

    /**
     * shafty023 review on #5050: the dismissal above may rest ONLY on a
     * configuration answer. A lane that is merely stopped gets no such licence,
     * because its gate reopens on its own and the burn-down that follows is what
     * exposes the newly eligible work — a panel that latched shut first would
     * have hidden it.
     */
    it("keeps waiting when the stopped lane carries no configuration reason", () => {
      // Byte-for-byte the dismissing case, minus the persisted reason.
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: CAUGHT_UP_CLOUD_SYNC,
        cloudSyncBacklog: backlogFor(
          [
            { lane: SyncLaneId.SessionMetadata },
            { lane: SyncLaneId.InvocationParts },
            {
              lane: SyncLaneId.TranscriptArchive,
              state: SyncLaneDrainState.IdleNotRunning,
            },
            { lane: SyncLaneId.ComponentInventory },
            { lane: SyncLaneId.TraceComments },
          ],
          { strictLaneReadiness: true }
        ),
      });

      expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
    });

    it("never dismisses between a stopped lane and the work its reopened gate exposes", () => {
      // The transition the review asked to cover, in the order it happens: shut
      // gate with a measured empty queue, then the gate reopens with real work.
      const lanes = (
        state: SyncLaneDrainState,
        itemsRemaining: number
      ): Partial<CloudReadReadinessSnapshot["lanes"][number]>[] => [
        { lane: SyncLaneId.SessionMetadata },
        { lane: SyncLaneId.InvocationParts },
        { itemsRemaining, lane: SyncLaneId.TranscriptArchive, state },
        { lane: SyncLaneId.ComponentInventory },
        { lane: SyncLaneId.TraceComments },
      ];
      const stopped = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: CAUGHT_UP_CLOUD_SYNC,
        cloudSyncBacklog: backlogFor(
          lanes(SyncLaneDrainState.IdleNotRunning, 0),
          { strictLaneReadiness: true }
        ),
      });
      const running = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: CAUGHT_UP_CLOUD_SYNC,
        cloudSyncBacklog: backlogFor(lanes(SyncLaneDrainState.Draining, 9), {
          strictLaneReadiness: true,
        }),
      });

      expect(stopped.phase).toBe(StartupReadinessPhase.SyncingCloud);
      expect(running.phase).toBe(StartupReadinessPhase.SyncingCloud);
    });
  });
});
