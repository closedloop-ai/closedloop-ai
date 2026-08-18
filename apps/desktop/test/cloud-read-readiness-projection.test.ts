import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloudReadReadinessProjectorDeps,
  createCloudReadReadinessProjector,
} from "../src/main/ipc/cloud-read-readiness-projection.js";
import { CloudReadLaneNotApplicableReason } from "../src/shared/cloud-read-lane-applicability.js";
import type { CloudReadReadinessSnapshot } from "../src/shared/cloud-read-readiness-contract.js";
import { cloudReadLaneReadinessIsFinal } from "../src/shared/cloud-read-readiness-contract.js";
import {
  type SyncBurndownSnapshot,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  burndownLane,
  burndownSnapshot,
} from "./helpers/sync-burndown-fixtures.js";

/**
 * ISS-6206 (wongk review on #5050): the projection reads THIS app's settings.
 *
 * `ipc-registration-wiring.test.ts` can only assert the shape of the call —
 * importing the composition root boots Electron — so binding the literal `false`
 * where the settings answer belongs left the whole suite green while every
 * install reported the transcript lane as permanently `disabled_by_config`,
 * letting the startup panel dismiss on a lane genuinely in play. These cases
 * execute the decision instead.
 */

/** Everything drained, with the transcript lane merely stopped. */
function stoppedTranscriptSample(): SyncBurndownSnapshot {
  return burndownSnapshot([
    burndownLane({ lane: SyncLaneId.SessionMetadata }),
    burndownLane({
      lane: SyncLaneId.TranscriptArchive,
      state: SyncLaneDrainState.IdleNotRunning,
    }),
  ]);
}

function projectWithTranscriptSync(
  transcriptSyncEnabled: boolean
): CloudReadReadinessSnapshot {
  return createCloudReadReadinessProjector({
    isImportComplete: () => true,
    getLatestSnapshot: stoppedTranscriptSample,
    getTranscriptSyncEnabled: () => transcriptSyncEnabled,
  })();
}

function transcriptReason(
  snapshot: CloudReadReadinessSnapshot
): CloudReadLaneNotApplicableReason | null {
  const lane = snapshot.lanes.find(
    (candidate) => candidate.lane === SyncLaneId.TranscriptArchive
  );
  if (!lane) {
    throw new Error("the projection dropped the transcript lane entirely");
  }
  // Optional on the contract type: an older main process omits it entirely, and
  // absence means the same thing as an explicit `null` — no configuration answer.
  return lane.notApplicableReason ?? null;
}

describe("createCloudReadReadinessProjector — the settings answer is real", () => {
  it("marks the transcript lane not-applicable only when the user turned it off", () => {
    assert.equal(
      transcriptReason(projectWithTranscriptSync(false)),
      CloudReadLaneNotApplicableReason.DisabledByConfig
    );
    // The counterfactual that a literal `false` binding cannot satisfy: a user
    // with transcript sync ON has a lane that is genuinely still in play.
    assert.equal(transcriptReason(projectWithTranscriptSync(true)), null);
  });

  it("keeps a transcript-sync user's stopped lane out of the final verdict", () => {
    // Why the binding matters at all: a reason makes the lane FINAL, which is
    // the licence a startup surface uses to stop waiting on it.
    assert.equal(
      cloudReadLaneReadinessIsFinal(projectWithTranscriptSync(false)),
      true
    );
    assert.equal(
      cloudReadLaneReadinessIsFinal(projectWithTranscriptSync(true)),
      false
    );
  });

  it("re-reads every getter on each projection, so a flipped setting lands next sample", () => {
    let transcriptSyncEnabled = true;
    const project = createCloudReadReadinessProjector({
      isImportComplete: () => true,
      getLatestSnapshot: stoppedTranscriptSample,
      getTranscriptSyncEnabled: () => transcriptSyncEnabled,
    });

    assert.equal(transcriptReason(project()), null);
    transcriptSyncEnabled = false;
    assert.equal(
      transcriptReason(project()),
      CloudReadLaneNotApplicableReason.DisabledByConfig
    );
  });

  it("projects the explicitly unknown snapshot before the first burn-down sample", () => {
    const snapshot = createCloudReadReadinessProjector({
      isImportComplete: () => true,
      getLatestSnapshot: () => null,
      getTranscriptSyncEnabled: () => true,
    })();

    assert.equal(snapshot.sampledAtIso, null);
    assert.deepEqual(snapshot.lanes, []);
  });

  it("carries the import gate through rather than assuming it complete", () => {
    for (const isImportComplete of [true, false]) {
      const snapshot = createCloudReadReadinessProjector({
        isImportComplete: () => isImportComplete,
        getLatestSnapshot: stoppedTranscriptSample,
        getTranscriptSyncEnabled: () => true,
      })();
      assert.equal(snapshot.importComplete, isImportComplete);
    }
  });
});

/** A stand-in for the composition root's stores, each answer flippable. */
function fakeProjectionSources(initial: {
  importComplete: boolean;
  transcriptSyncEnabled: boolean;
  sample: SyncBurndownSnapshot | null;
}) {
  const state = { ...initial };
  return {
    state,
    sources: {
      rendererGates: {
        isInitialCollectorImportComplete: () => state.importComplete,
      },
      syncBurndownReporter: { getLatestSnapshot: () => state.sample },
      settingsStore: {
        getTranscriptSyncEnabled: () => state.transcriptSyncEnabled,
      },
    },
  };
}

describe("buildCloudReadReadinessProjectorDeps — the binding is executed, not inspected", () => {
  it("reads the transcript answer from the settings store, in both directions", () => {
    // Kills `getTranscriptSyncEnabled: () => false` (and its `true` twin): a
    // literal cannot follow the store to both answers. This is the mutation the
    // wiring guard could not see, because it only ever read property NAMES off
    // the composition root's object literal.
    for (const transcriptSyncEnabled of [true, false]) {
      const { sources } = fakeProjectionSources({
        importComplete: true,
        transcriptSyncEnabled,
        sample: stoppedTranscriptSample(),
      });
      const snapshot = createCloudReadReadinessProjector(
        buildCloudReadReadinessProjectorDeps(sources)
      )();
      assert.equal(
        transcriptReason(snapshot),
        transcriptSyncEnabled
          ? null
          : CloudReadLaneNotApplicableReason.DisabledByConfig
      );
      assert.equal(
        cloudReadLaneReadinessIsFinal(snapshot),
        !transcriptSyncEnabled
      );
    }
  });

  it("re-reads the store on every projection, never a value captured at build time", () => {
    // Kills the frozen variant a thunk alone still permits:
    //   const enabled = sources.settingsStore.getTranscriptSyncEnabled();
    //   getTranscriptSyncEnabled: () => enabled
    // That binding is a live getter by shape and a boot-time snapshot by
    // behavior, so a user who turns transcript sync off (or on) keeps the old
    // verdict until the next app launch.
    const { state, sources } = fakeProjectionSources({
      importComplete: false,
      transcriptSyncEnabled: true,
      sample: stoppedTranscriptSample(),
    });
    const project = createCloudReadReadinessProjector(
      buildCloudReadReadinessProjectorDeps(sources)
    );

    assert.equal(transcriptReason(project()), null);
    assert.equal(project().importComplete, false);
    assert.deepEqual(project().lanes.length, 2);

    state.transcriptSyncEnabled = false;
    state.importComplete = true;

    assert.equal(
      transcriptReason(project()),
      CloudReadLaneNotApplicableReason.DisabledByConfig
    );
    assert.equal(project().importComplete, true);

    // The burn-down getter is live too: a captured sample would keep replaying
    // the stale two-lane one.
    state.sample = null;
    assert.deepEqual(project().lanes, []);
  });

  it("does not touch any store until a projection is actually taken", () => {
    // The same freeze, caught one step earlier and independently of what the
    // captured value happens to be: building the deps must read nothing.
    let reads = 0;
    const project = createCloudReadReadinessProjector(
      buildCloudReadReadinessProjectorDeps({
        rendererGates: {
          isInitialCollectorImportComplete: () => {
            reads += 1;
            return true;
          },
        },
        syncBurndownReporter: {
          getLatestSnapshot: () => {
            reads += 1;
            return stoppedTranscriptSample();
          },
        },
        settingsStore: {
          getTranscriptSyncEnabled: () => {
            reads += 1;
            return true;
          },
        },
      })
    );
    assert.equal(reads, 0, "building the deps read a store at boot");
    project();
    assert.ok(reads > 0, "projecting read no store at all");
  });
});
