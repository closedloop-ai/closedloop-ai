/**
 * ISS-9807 — the dead-letter BASIS at the renderer's IPC boundary, now that
 * the lane classifier reads it.
 *
 * Split out of `use-cloud-sync-progress.test.ts`, which is near the 1,000-line
 * ceiling. Three payload shapes, and each side of the version skew is pinned
 * so a refusal cannot be read as proof:
 *
 * 1. A payload that PREDATES the field, carrying the `drained` that build
 *    classified — must still settle. The refine re-derives with the field
 *    absent (the classifier skips the rule), and the degrade to `unmeasured`
 *    reaches only the cross-lane total.
 * 2. A payload from THIS build reporting a never-read lane as
 *    `remaining_unknown` on an `unmeasured` basis — accepted, and the aggregate
 *    answers `unknown`, never `drained`.
 * 3. A payload claiming `drained` ON an `unmeasured` basis, a pair this build's
 *    classifier can never emit — refused, so the aggregate is `unknown`.
 */
import { describe, expect, it } from "vitest";
import {
  type CloudReadReadinessSnapshot,
  CloudSyncBacklogState,
} from "../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import { parseCloudSyncBacklog } from "../use-cloud-sync-progress";

type LaneRow = CloudReadReadinessSnapshot["lanes"][number];

/** One lane, drained and quiet on a measured basis. */
function laneRow(overrides: Partial<LaneRow>): LaneRow {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    resumeBlocked: false,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    unmeasuredRows: 0,
    notApplicableReason: null,
    parkedCount: null,
    ...overrides,
  };
}

/**
 * A full snapshot of every known lane (the boundary rejects any other set) with the
 * session lane overridden.
 */
function readiness(session: Partial<LaneRow>): CloudReadReadinessSnapshot {
  return {
    sampledAtIso: "2026-08-10T12:00:00.000Z",
    importComplete: true,
    lanes: SYNC_LANE_IDS.map((lane) =>
      lane === SyncLaneId.SessionMetadata
        ? laneRow({ lane, ...session })
        : laneRow({ lane })
    ),
  };
}

/** How a field actually goes missing across IPC: `undefined` does not survive the wire. */
function withoutBasis(snapshot: CloudReadReadinessSnapshot): unknown {
  return JSON.parse(
    JSON.stringify(snapshot, (key, value) =>
      key === "deadLetteredBasis" ? undefined : value
    )
  );
}

describe("parseCloudSyncBacklog — the dead-letter basis (ISS-9807)", () => {
  it("still settles a payload from a main process that predates the basis", () => {
    // COUNTERFACTUAL: coarsen the absent basis to `unmeasured` BEFORE the
    // refine and this lane re-derives `remaining_unknown`, disagrees with its
    // declared `drained`, and the whole snapshot is refused — a build that can
    // never report caught up.
    const backlog = parseCloudSyncBacklog({
      cloudReadReadiness: withoutBasis(readiness({})),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Drained);
    expect(backlog.itemsRemaining).toBe(0);
  });

  it("accepts a never-read lane reported remaining_unknown, and answers unknown rather than drained", () => {
    // COUNTERFACTUAL: drop the basis from the refine's re-derivation and this
    // lane — every count a clean zero — re-derives `drained`, disagrees with
    // the declared `remaining_unknown`, and is refused instead of honoured.
    const backlog = parseCloudSyncBacklog({
      cloudReadReadiness: readiness({
        state: SyncLaneDrainState.RemainingUnknown,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
      }),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    // Accepted, not refused: a refused snapshot carries no measured total.
    expect(backlog.itemsRemaining).toBe(0);
  });

  it("refuses a lane that claims drained on an unmeasured basis", () => {
    // A pair the classifier cannot emit; admitting it would let a placeholder
    // zero render "Up to date".
    const backlog = parseCloudSyncBacklog({
      cloudReadReadiness: readiness({
        state: SyncLaneDrainState.Drained,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
      }),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.itemsRemaining).toBeNull();
  });
});
