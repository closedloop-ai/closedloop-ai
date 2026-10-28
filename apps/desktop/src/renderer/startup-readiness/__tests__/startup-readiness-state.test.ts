import { describe, expect, it } from "vitest";
import { AgentMonitorRuntimeStatusKind } from "../../../shared/agent-monitor-status";
import { CloudReadLaneNotApplicableReason } from "../../../shared/cloud-read-lane-applicability";
import type {
  CloudReadReadinessSnapshot,
  CloudSyncBacklog,
  ResolveCloudSyncBacklogOptions,
} from "../../../shared/cloud-read-readiness-contract";
import {
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
} from "../../../shared/cloud-read-readiness-contract";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import {
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import {
  type CloudStatus,
  CloudStatusKind,
} from "../../hooks/use-cloud-status";
import type { CloudSyncProgress } from "../../hooks/use-cloud-sync-progress";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  type StartupReadinessInputs,
  StartupReadinessPhase,
  StartupReadinessStepState,
} from "../startup-readiness-state";
import {
  CAUGHT_UP_CLOUD_SYNC,
  COMPLETE_INGEST,
  READY_INPUTS,
} from "./startup-readiness-fixtures";

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
    expect(model.detail).toContain("750 historical sessions remaining");
  });

  it("syncs pending incremental sessions when nothing has warned (ISS-11668 ruling 11)", () => {
    // Syncing is done at 100%, and new-session uploads are a sync (rulings 9
    // and 11). The backfill queue is empty here.
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingIncrementalSessions: 5,
        caughtUp: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
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

  /**
   * ISS-6207: the boot import settled with source files left behind after their
   * automatic re-drive budget was spent. Before the fix that arrived here as
   * `complete: true`, so this panel latched Ready over sessions that were never
   * imported and nothing would ever revisit them.
   */
  it("does not call a spent retry budget ready", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      ingest: {
        ...COMPLETE_INGEST,
        total: 7,
        processed: 3,
        complete: false,
        retriesExhausted: true,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
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

  it("states the records that could not sync as its headline (ISS-11668)", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        deadLetteredSessions: 2,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncDeadLettered);
    expect(model.headline).toBe(
      "2 source files could not sync. Local sessions remain available."
    );
    expect(model.headline).toBe(model.cloudWarning);
  });

  it("keeps syncing when a dead letter lands while the sync still has work (ISS-11668)", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingBackfillSessions: 7,
        caughtUp: false,
        deadLetteredSessions: 2,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
    expect(model.cloudWarning).toBe(
      "2 source files could not sync. Local sessions remain available."
    );
  });

  it("enters no cloud phase before the sync election (ISS-11668)", () => {
    const pending = {
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingBackfillSessions: 7,
        caughtUp: false,
      },
    };

    expect(buildStartupReadinessModel(pending).phase).toBe(
      StartupReadinessPhase.SyncingCloud
    );
    expect(
      buildStartupReadinessModel({ ...pending, syncElected: false }).phase
    ).toBe(StartupReadinessPhase.Ready);
  });

  it("ranks the sync above the view rebuild once parsing is done (ISS-11668)", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      maintenance: { active: true, phase: MaintenancePhase.ArtifactLinks },
      maintenanceSettled: false,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        pendingBackfillSessions: 7,
        caughtUp: false,
      },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
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
          resumeBlocked: false,
          itemsRemaining: 0,
          itemsRemainingIsLowerBound: false,
          deadLetteredCount: 0,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
          unmeasuredRows: 0,
          ...overrides,
        })),
      },
      options
    );
  }
  /** The session lane still uploading, which is what holds `SyncingCloud`. */
  const SESSION_LANE_SYNCING: CloudSyncProgress = {
    ...CAUGHT_UP_CLOUD_SYNC,
    caughtUp: false,
  };

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
   * ISS-11668 ruling 11 (operator, 2026-10-01): the session lane holds the
   * phase, not the whole-app backlog. The bar leaves once session metadata is
   * uploaded and the other lanes upload in the background with no bar. While
   * the session lane syncs, the detail line still reports the whole-app
   * backlog (ISS-5768).
   */
  describe("phase", () => {
    it("leaves once the session lane is caught up while another lane still owes work (ISS-11668 ruling 11)", () => {
      const cloudSyncBacklog = backlogFor([
        { lane: SyncLaneId.SessionMetadata },
        {
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2985,
        },
      ]);
      expect(cloudSyncBacklog.state).toBe(CloudSyncBacklogState.Outstanding);

      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSyncBacklog,
      });

      expect(model.phase).toBe(StartupReadinessPhase.Ready);
      // Leaving is not a completeness claim: the cloud is still not verified.
      expect(model.cloudVerified).toBe(false);
    });

    it("reports the whole-app remainder while the session lane syncs", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: SESSION_LANE_SYNCING,
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
      // `cloudPendingCount` is the session lane, which here is a clean 0.
      expect(model.detail).toContain("2,985 items still to upload");
      expect(model.detail).not.toContain("0 historical sessions");
    });

    it.each([
      { state: CloudSyncBacklogState.Drained, lanes: [] },
      {
        state: CloudSyncBacklogState.Abandoned,
        lanes: [
          {
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
          },
        ],
      },
    ])(
      "keeps syncing incremental sessions past a dead letter over a $state backlog (whitlockk review on #8290)",
      ({ state, lanes }) => {
        const cloudSyncBacklog = backlogFor([
          { lane: SyncLaneId.SessionMetadata },
          ...lanes,
        ]);
        expect(cloudSyncBacklog.state).toBe(state);

        const model = buildStartupReadinessModel({
          ...READY_INPUTS,
          cloudSync: {
            ...CAUGHT_UP_CLOUD_SYNC,
            pendingIncrementalSessions: 5,
            caughtUp: false,
            deadLetteredSessions: 1,
          },
          cloudSyncBacklog,
        });

        expect(model.cloudWarning).not.toBeNull();
        expect(model.phase).toBe(StartupReadinessPhase.SyncingCloud);
      }
    );

    /**
     * ISS-6206 (whitlockk review on #5050) — this panel's detail is the SECOND
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
        cloudSync: SESSION_LANE_SYNCING,
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
              lane: SyncLaneId.ComponentInventory,
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
        "2,900 sessions, 12 transcripts and 7 activity records"
      );
      expect(model.detail).not.toContain("1 more");
      // 2,900 outbox rows + 12 files + 7 activity records is not "2,919" of anything.
      expect(model.detail).not.toContain("2,919");
    });

    it("keeps the single cross-lane total when strict readiness is off", () => {
      // The gate's counterfactual: same lanes, no strict option. Without it the
      // assertion above would pass on copy applied unconditionally.
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: SESSION_LANE_SYNCING,
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
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 7,
          },
        ]),
      });

      expect(model.detail).toContain("2,919 items still to upload");
      expect(model.detail).not.toContain("2,900 sessions");
    });

    it("says the history is still being checked while nothing has been measured yet", () => {
      const model = buildStartupReadinessModel({
        ...READY_INPUTS,
        cloudSync: SESSION_LANE_SYNCING,
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
      expect(model.phase).toBe(StartupReadinessPhase.SyncDeadLettered);
      expect(model.cloudWarning).toBe(
        "1 source file could not sync. Local sessions remain available."
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
     * ISS-6206 (whitlockk review on #5050) — the signed-IN twin of the signed-out
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
              // stopped sample (davetho review on #5050).
              lane: SyncLaneId.TranscriptArchive,
              notApplicableReason:
                CloudReadLaneNotApplicableReason.DisabledByConfig,
              state: SyncLaneDrainState.NeverStarted,
            },
            { lane: SyncLaneId.ComponentInventory },
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
          ],
          { strictLaneReadiness: true }
        ),
      });

      expect(model.phase).not.toBe(StartupReadinessPhase.Ready);
    });
  });
});

/**
 * ISS-4715: a cloud that is OFF and a cloud that is BROKEN are different facts,
 * and the panel latches on the difference — `NeedsAttention` never clears,
 * because `done` only latches on `Ready`. Reporting a deliberate opt-out as
 * degraded therefore pinned the strip open for the whole session on every
 * install with cloud sync switched off.
 *
 * BOTH directions are asserted from one table, deliberately. A fixture carrying
 * only the disabled status would pass just as happily against a build that had
 * stopped warning about a genuinely degraded cloud — trading a false positive
 * for a false negative, which is the worse of the two.
 */
describe("cloud off versus cloud broken (ISS-4715)", () => {
  const DISABLED_CLOUD_STATUS: CloudStatus = {
    kind: CloudStatusKind.Disabled,
    reason: "Cloud connection disabled by user",
  };
  const DEGRADED_CLOUD_STATUS: CloudStatus = {
    kind: CloudStatusKind.Degraded,
    error: "socket handshake failed",
  };
  /**
   * What the sync lane really reports with egress off: nothing was identified,
   * so nothing was measured. Using the caught-up fixture here would assert
   * against a state the product cannot be in — a cloud that is switched off and
   * simultaneously confirmed up to date.
   */
  const UNIDENTIFIED_CLOUD_SYNC: CloudSyncProgress = {
    identified: false,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: false,
    deadLetteredSessions: 0,
  };
  const CLOUD_OFF_INPUTS: StartupReadinessInputs = {
    ...READY_INPUTS,
    cloudStatus: DISABLED_CLOUD_STATUS,
    cloudSync: UNIDENTIFIED_CLOUD_SYNC,
  };

  it("does not ask for attention when the user turned the cloud off", () => {
    const model = buildStartupReadinessModel(CLOUD_OFF_INPUTS);

    expect(model.phase).toBe(StartupReadinessPhase.Ready);
    expect(model.cloudWarning).toBeNull();
    expect(model.cloudDisabled).toBe(true);
  });

  it("still asks for attention when an enabled cloud is failing", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudStatus: DEGRADED_CLOUD_STATUS,
    });

    expect(model.phase).toBe(StartupReadinessPhase.NeedsAttention);
    expect(model.cloudWarning).not.toBeNull();
    expect(model.cloudDisabled).toBe(false);
  });

  /**
   * The off state is REPORTED, not suppressed. Without this a fix that simply
   * dropped the cloud row would satisfy both cases above while deleting a fact
   * the reader is entitled to — and "up to date" would be a claim about a
   * freshness check that never ran.
   */
  it("says the cloud is off rather than claiming it is up to date", () => {
    const model = buildStartupReadinessModel(CLOUD_OFF_INPUTS);

    expect(model.detail).toBe(
      "Local history checked just now. Cloud sync is off."
    );
    expect(model.cloudVerified).toBe(false);
  });
});
