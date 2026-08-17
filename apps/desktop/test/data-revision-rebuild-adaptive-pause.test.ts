/**
 * @file data-revision-rebuild-adaptive-pause.test.ts
 * @description ISS-4711 / ISS-4824 — the DATA_REVISION rebuild's adaptive
 * per-write pause gate, split out of the 2.9k-line `data-revision-rebuild.test.ts`
 * (which is on the shrink-only `noExcessiveLinesPerFile` grandfather list) into a
 * focused sibling.
 *
 * The gate is its own concern: the parent suite covers WHAT the rebuild derives,
 * this covers HOW HARD it throttles while doing it. Both arms hold the full
 * cooperative pause — the db host being under memory pressure (wired for real in
 * ISS-4823) or the renderer having just been served — and the idle path drops the
 * flat 50ms/session floor that made a ~2,888-session corpus take ~7 hours.
 *
 * The `fakeCollector` / `makePopulatedSession` helpers come from the shared
 * `normalized-session-test-utils` fixture rather than being duplicated here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DATA_REVISION_REBUILD_IDLE_PAUSE_MS,
  DATA_REVISION_REBUILD_WRITE_PAUSE_MS,
  runDataRevisionRebuild,
} from "../src/main/collectors/engine/data-revision-rebuild.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

describe("ISS-4711 adaptive write pause (memory-pressure / renderer-read gate)", () => {
  // Runs a single-session rebuild with the given adaptive-gate signals and
  // returns the ms values passed to `cooperativeDelay` (one per session write).
  const runAdaptiveRebuild = async (gate: {
    isDbHostUnderMemoryPressure?: () => boolean;
    hasRecentRendererRead?: () => boolean;
  }): Promise<{ rebuilt: number; delayCalls: number[] }> => {
    const source = "/fake/iss-4711-adaptive.jsonl";
    const delayCalls: number[] = [];
    const collector = fakeCollector("claude", {
      sources: [source],
      sessionIdForSource: () => "iss-4711-adaptive",
    });
    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "iss-4711-adaptive", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      cooperativeDelay: (ms) => {
        delayCalls.push(ms);
        return Promise.resolve();
      },
      ...gate,
      parseSource: () =>
        Promise.resolve([makeSession({ sessionId: "iss-4711-adaptive" })]),
    });
    return { rebuilt: result.rebuilt, delayCalls };
  };

  test("takes the full cooperative pause under simulated memory pressure", async () => {
    const { rebuilt, delayCalls } = await runAdaptiveRebuild({
      isDbHostUnderMemoryPressure: () => true,
      hasRecentRendererRead: () => false,
    });
    assert.equal(rebuilt, 1);
    // Cooperative yield preserved: the full pause is still paid per write.
    assert.deepEqual(delayCalls, [DATA_REVISION_REBUILD_WRITE_PAUSE_MS]);
  });

  test("takes the full cooperative pause on a recent renderer read", async () => {
    const { rebuilt, delayCalls } = await runAdaptiveRebuild({
      isDbHostUnderMemoryPressure: () => false,
      hasRecentRendererRead: () => true,
    });
    assert.equal(rebuilt, 1);
    assert.deepEqual(delayCalls, [DATA_REVISION_REBUILD_WRITE_PAUSE_MS]);
  });

  test("skips the flat 50ms floor when idle: no pressure and no recent renderer read", async () => {
    const { rebuilt, delayCalls } = await runAdaptiveRebuild({
      isDbHostUnderMemoryPressure: () => false,
      hasRecentRendererRead: () => false,
    });
    assert.equal(rebuilt, 1);
    // Fast path: still a cooperative yield (a real 0ms loop-turn boundary), but
    // no flat 50ms/session floor — the crux of the ISS-4711 speedup.
    assert.deepEqual(delayCalls, [DATA_REVISION_REBUILD_IDLE_PAUSE_MS]);
    assert.notEqual(delayCalls[0], DATA_REVISION_REBUILD_WRITE_PAUSE_MS);
  });

  test("defaults to the idle fast path when neither signal is wired", async () => {
    const { rebuilt, delayCalls } = await runAdaptiveRebuild({});
    assert.equal(rebuilt, 1);
    assert.deepEqual(delayCalls, [DATA_REVISION_REBUILD_IDLE_PAUSE_MS]);
  });
});
