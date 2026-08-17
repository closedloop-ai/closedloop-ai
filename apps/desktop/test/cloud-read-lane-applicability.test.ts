import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudReadLaneNotApplicableReason } from "../src/shared/cloud-read-lane-applicability.js";
import {
  type CloudSyncBacklog,
  CloudSyncBacklogState,
  projectCloudReadReadiness,
  resolveCloudSyncBacklog,
} from "../src/shared/cloud-read-readiness-contract.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  burndownLane,
  burndownSnapshot,
} from "./helpers/sync-burndown-fixtures.js";

/**
 * ISS-6206 (shafty023 review on #5050): strict lane readiness may only settle
 * on a reason this app's CONFIGURATION carries. A lane that is merely stopped
 * — `idle_not_running` covers connectivity, credential, policy and
 * compute-target gates — gets no such licence, because its gate reopens on its
 * own and the burn-down that follows is what exposes the newly eligible work.
 *
 * Split out of `cloud-read-readiness-contract.test.ts` when that file reached
 * the 1,000-line ceiling; the burn-down fixtures both files build on live in
 * `helpers/sync-burndown-fixtures.ts`.
 */

const lane = burndownLane;
const snapshot = burndownSnapshot;

describe("laneReadinessUnattested — finality comes from config (ISS-6206 review)", () => {
  const STRICT_READINESS = { strictLaneReadiness: true };

  /** Everything drained except the transcript lane, which is merely stopped. */
  function stoppedTranscript(
    state: SyncLaneDrainState,
    transcriptSyncEnabled: boolean
  ): CloudSyncBacklog {
    return resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot(
          SYNC_LANE_IDS.map((laneId) =>
            lane({
              lane: laneId,
              state:
                laneId === SyncLaneId.TranscriptArchive
                  ? state
                  : SyncLaneDrainState.Drained,
            })
          )
        ),
        notApplicableReason: (laneId) =>
          cloudReadLaneNotApplicableReason(laneId, { transcriptSyncEnabled }),
      }),
      STRICT_READINESS
    );
  }

  it("settles when the shortfall is a lane this config switched off", () => {
    // The shipped default: transcript upload off. The lane is out of play for
    // as long as the setting says so, so waiting cannot improve on this.
    const backlog = stoppedTranscript(SyncLaneDrainState.NeverStarted, false);

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(backlog.laneReadinessUnattested, true);
  });

  it("stays pending when the same lane is stopped with the switch ON", () => {
    // Identical snapshot, identical drain state — the ONLY difference is the
    // persisted setting. `never_started` with the feature enabled is a lane that
    // has not started YET, and the next sample can genuinely change it.
    const backlog = stoppedTranscript(SyncLaneDrainState.NeverStarted, true);

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(backlog.laneReadinessUnattested, false);
  });

  it("stays pending on idle_not_running, whose gates reopen on their own", () => {
    // Connectivity, credential, org policy and compute target all land here.
    assert.equal(
      stoppedTranscript(SyncLaneDrainState.IdleNotRunning, true)
        .laneReadinessUnattested,
      false
    );
  });

  it("stays pending when a lane with no config answer is the one stopped", () => {
    // The session lane has no configuration switch at all, so nothing can ever
    // account for its stoppage and the aggregate must keep waiting on it.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot(
          SYNC_LANE_IDS.map((laneId) =>
            lane({
              lane: laneId,
              state:
                laneId === SyncLaneId.SessionMetadata
                  ? SyncLaneDrainState.IdleNotRunning
                  : SyncLaneDrainState.Drained,
            })
          )
        ),
        notApplicableReason: (laneId) =>
          cloudReadLaneNotApplicableReason(laneId, {
            transcriptSyncEnabled: false,
          }),
      }),
      STRICT_READINESS
    );

    assert.equal(backlog.laneReadinessUnattested, false);
  });

  it("does not dismiss across stopped → outstanding without an intervening settle", () => {
    // The sequence the review named. A lane whose gate is shut with a measured
    // empty queue, then the gate reopens and real work appears. At no point in
    // between may the backlog report a settled verdict, because that is what
    // lets a startup surface latch shut before the work is ever shown.
    const stopped = stoppedTranscript(SyncLaneDrainState.IdleNotRunning, true);
    assert.equal(stopped.laneReadinessUnattested, false);

    const running = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot(
          SYNC_LANE_IDS.map((laneId) =>
            lane({
              lane: laneId,
              state:
                laneId === SyncLaneId.TranscriptArchive
                  ? SyncLaneDrainState.Draining
                  : SyncLaneDrainState.Drained,
              itemsRemaining: laneId === SyncLaneId.TranscriptArchive ? 9 : 0,
            })
          )
        ),
        notApplicableReason: (laneId) =>
          cloudReadLaneNotApplicableReason(laneId, {
            transcriptSyncEnabled: true,
          }),
      }),
      STRICT_READINESS
    );

    assert.equal(running.state, CloudSyncBacklogState.Outstanding);
    assert.equal(running.laneReadinessUnattested, false);
  });
});
