/**
 * The graduated data-sync level's application, testable for the first time
 * because ISS-10950 lifted it out of `DesktopApplication` (shrink-only
 * grandfather rule). Behavior is unchanged by that move; these pin it so the
 * next move is judged against something.
 *
 * The ISS-10950 case is the last one: a level write is the sync-policy step's
 * own commit path, so it also releases the boot import — the release a device
 * without a recorded Welcome Start agreement (ISS-10890) still waits on.
 * Without an assertion here, deleting that call leaves every other suite in the
 * repo green.
 */

import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { describe, it } from "vitest";
import {
  type ApplyDataSyncLevelDeps,
  applyDataSyncLevel,
} from "../src/main/settings/apply-data-sync-level.js";

type Recorded = {
  deps: ApplyDataSyncLevelDeps;
  cloudCommandsPaused: boolean[];
  cloudConnectionEnabled: boolean[];
  levels: DataSyncLevel[];
  levelRecorded: number;
  persistedCloudConnectionEnabled: boolean[];
  transcriptLaneStarts: number;
};

describe("applyDataSyncLevel", () => {
  it("persists the level before reconciling the in-memory connectivity flags", () => {
    const recorded = recorder();

    applyDataSyncLevel(DataSyncLevel.Full, recorded.deps);

    assert.deepEqual(recorded.levels, [DataSyncLevel.Full]);
    assert.deepEqual(recorded.cloudCommandsPaused, [false]);
    assert.deepEqual(recorded.cloudConnectionEnabled, [true]);
  });

  it("keeps cloud egress hard-disabled in golden mode", () => {
    const recorded = recorder({ isGoldenMode: () => true });

    applyDataSyncLevel(DataSyncLevel.Full, recorded.deps);

    assert.deepEqual(recorded.persistedCloudConnectionEnabled, [false]);
  });

  it("starts the transcript lane the first time a level turns it on", () => {
    const recorded = recorder();

    applyDataSyncLevel(DataSyncLevel.Full, recorded.deps);

    assert.equal(recorded.transcriptLaneStarts, 1);
  });

  it("leaves an existing transcript lane alone rather than replacing it", () => {
    const recorded = recorder({ hasTranscriptSyncLane: () => true });

    applyDataSyncLevel(DataSyncLevel.Full, recorded.deps);

    assert.equal(recorded.transcriptLaneStarts, 0);
  });

  // `metadata` derives `transcriptSyncEnabled: false`, so the lane must not be
  // constructed at all — the level that allows transcripts is the only one.
  it("never starts the transcript lane on a level that excludes transcripts", () => {
    const recorded = recorder();

    applyDataSyncLevel(DataSyncLevel.Metadata, recorded.deps);

    assert.equal(recorded.transcriptLaneStarts, 0);
  });

  it("reports the level write, on every level, so the import gate can release", () => {
    for (const level of [DataSyncLevel.Off, DataSyncLevel.Full]) {
      const recorded = recorder();

      applyDataSyncLevel(level, recorded.deps);

      assert.equal(recorded.levelRecorded, 1);
    }
  });
});

function recorder(overrides: Partial<ApplyDataSyncLevelDeps> = {}): Recorded {
  const recorded: Recorded = {
    cloudCommandsPaused: [],
    cloudConnectionEnabled: [],
    deps: {} as ApplyDataSyncLevelDeps,
    levelRecorded: 0,
    levels: [],
    persistedCloudConnectionEnabled: [],
    transcriptLaneStarts: 0,
  };
  recorded.deps = {
    hasTranscriptSyncLane: () => false,
    isGoldenMode: () => false,
    isShuttingDown: () => false,
    onLevelRecorded: () => {
      recorded.levelRecorded += 1;
    },
    setCloudCommandsPaused: (paused) => {
      recorded.cloudCommandsPaused.push(paused);
    },
    setCloudConnectionEnabled: (enabled) => {
      recorded.cloudConnectionEnabled.push(enabled);
    },
    setDataSyncLevel: (level) => {
      recorded.levels.push(level);
    },
    setPersistedCloudConnectionEnabled: (enabled) => {
      recorded.persistedCloudConnectionEnabled.push(enabled);
    },
    startTranscriptSyncLane: () => {
      recorded.transcriptLaneStarts += 1;
    },
    ...overrides,
  };
  return recorded;
}
