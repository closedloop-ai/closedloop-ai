/**
 * @file cloud-read-readiness-resume-blocked.test.ts
 * @description ISS-9823 — what a session lane's FAILING once-per-identity resume
 * read does to the readiness projection and to the whole-app backlog verdict.
 *
 * Split out of `cloud-read-readiness-contract.test.ts` for the reason its
 * lane-applicability cases were (ISS-6206): that file is at the 1,000-line
 * ceiling, and this ticket's cases are a cohesive subject with a single shared
 * fixture. The lane rows come from `helpers/sync-burndown-fixtures.ts`, so
 * nothing here is a second copy of a twenty-field row.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CloudSyncBacklogState,
  isCloudReadBacklogDrained,
  resolveCloudSyncBacklog,
} from "../src/shared/cloud-read-readiness-contract.js";
import {
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  burndownLane as lane,
  projectConsentedReadiness as projectConsented,
  burndownSnapshot as snapshot,
} from "./helpers/sync-burndown-fixtures.js";

describe("projectCloudReadReadiness — the blocked resume (ISS-9823)", () => {
  it("carries resumeBlocked through, so the renderer can re-derive the state", () => {
    // The renderer re-runs `classifyLaneDrainState` over this payload and fails
    // the whole snapshot when its answer disagrees with the projected `state`.
    // Every count on this lane is a clean, measured zero, so `remaining_unknown`
    // is reproducible ONLY from the flag: dropping it here would turn the fix
    // into a rejected payload and a startup gate stuck on `unknown`.
    const projected = projectConsented({
      importComplete: true,
      snapshot: snapshot([
        lane({
          resumeBlocked: true,
          state: SyncLaneDrainState.RemainingUnknown,
          itemsRemaining: 0,
        }),
      ]),
    });

    assert.equal(projected.lanes[0]?.resumeBlocked, true);
    assert.equal(
      isCloudReadBacklogDrained(projected),
      false,
      "a lane whose resume is wedged has not established that it owes nothing"
    );
  });
});

describe("resolveCloudSyncBacklog — the blocked resume (ISS-9823)", () => {
  /** A wedged session lane beside four honestly-settled ones. */
  function wedgedSnapshot(sessionOverrides: Partial<SyncLaneBurndown> = {}) {
    return projectConsented({
      importComplete: true,
      snapshot: snapshot([
        lane({
          lane: SyncLaneId.SessionMetadata,
          resumeBlocked: true,
          state: SyncLaneDrainState.RemainingUnknown,
          ...sessionOverrides,
        }),
        lane({ lane: SyncLaneId.InvocationParts }),
        lane({ lane: SyncLaneId.TranscriptArchive }),
        lane({ lane: SyncLaneId.ComponentInventory }),
      ]),
    });
  }

  it("refuses to answer drained on the DEFAULT path, not just the strict one", () => {
    // The population this ticket exists for, on the path users are actually on.
    // Every count on the wedged lane is a clean measured zero, so
    // `cloudReadLaneOwesWork` is false for all four lanes and the aggregate used
    // to round up to `drained` — which `describeCloudSyncStatus` renders as
    // "Up to date". `strictLaneReadiness` already caught this, but it is a
    // closed-by-default flag, so without the default-path guard the fix reaches
    // almost nobody.
    const backlog = resolveCloudSyncBacklog(wedgedSnapshot());

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(
      resolveCloudSyncBacklog(wedgedSnapshot(), { strictLaneReadiness: true })
        .state,
      CloudSyncBacklogState.Unknown,
      "and the two paths still agree about whether this snapshot has settled"
    );
  });

  it("refuses `abandoned` too, the other terminal claim at a zero total", () => {
    // The branch a guard nested under the `drained` door would miss: one dead
    // letter makes `cloudReadLaneOwesWork` true, so the snapshot skips that door
    // entirely and falls through to `abandoned` — which still says every lane
    // finished. Testing the total is what closes both.
    const backlog = resolveCloudSyncBacklog(
      wedgedSnapshot({ deadLetteredCount: 1 })
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(
      backlog.deadLetteredCount,
      1,
      "and the dead letter is still reported — refusing the verdict is not dropping the count"
    );
  });

  it("still reports a measured backlog as outstanding, count intact", () => {
    // The guard converts a false terminal claim into `unknown` and nothing else.
    // A wedged lane still holding rows is genuinely `outstanding`, and collapsing
    // that to `unknown` would throw away a number the user can act on.
    const backlog = resolveCloudSyncBacklog(
      wedgedSnapshot({
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 12,
      })
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.equal(backlog.itemsRemaining, 12);
  });

  it("does not let a lane that STOPPED hold the aggregate at unknown", () => {
    // ISS-9823 re-review. `classifyLaneDrainState` ranks liveness above the
    // blocked resume, and the burn-down row carries `resumeBlocked` through
    // whether the gate is open or not — so a lane that latched a fault and then
    // had its gate shut says `idle_not_running`, honestly and with a measured
    // zero, while still carrying the flag. Reading the raw flag here contradicted
    // that ordering, and nothing could undo it: a lane that has stopped tees no
    // further outcome, so the level never sees the `Seeded` that clears it and
    // the whole-app verdict stayed `unknown` for the rest of the process. A
    // permanent "still checking" is a lie of the same family as "Up to date"
    // while wedged, pointed the other way.
    for (const state of [
      SyncLaneDrainState.IdleNotRunning,
      SyncLaneDrainState.NeverStarted,
    ]) {
      assert.equal(
        resolveCloudSyncBacklog(wedgedSnapshot({ state })).state,
        CloudSyncBacklogState.Drained,
        `expected a ${state} lane's stale flag not to pin the aggregate`
      );
      assert.equal(
        resolveCloudSyncBacklog(wedgedSnapshot({ state }), {
          strictLaneReadiness: true,
        }).state,
        CloudSyncBacklogState.Unknown,
        `and strict lane readiness still refuses to settle on a ${state} lane`
      );
    }
  });

  it("leaves a healthy snapshot answering drained", () => {
    // The counterfactual: the cases above must not pass against a guard that
    // simply stopped answering `drained`.
    assert.equal(
      resolveCloudSyncBacklog(
        wedgedSnapshot({
          resumeBlocked: false,
          state: SyncLaneDrainState.Drained,
        })
      ).state,
      CloudSyncBacklogState.Drained
    );
  });
});
