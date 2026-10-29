/**
 * ISS-11449 (whitlockk review): a discovery sweep that runs before the dashboard DB
 * is ready — the startup sweep, or the sign-in kick when auth restores first —
 * stays owed until a drain tick finds the store, instead of waiting out the
 * 30-minute periodic sweep.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";
import type { TranscriptFileRef } from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";
import { fakeExecutor, fakeStore } from "./helpers/transcript-sync-fixtures.js";

const REF: TranscriptFileRef = {
  externalSessionId: "s1",
  fileKey: "main",
  sourceHarness: "claude",
  sourcePath: "/p/s1.jsonl",
};

function serviceWithLateStore() {
  const store = fakeStore();
  let ready: typeof store | null = null;
  let discoverCalls = 0;
  const service = new TranscriptSyncService({
    getStore: () => ready,
    buildExecutor: () => fakeExecutor(),
    discover: () => {
      discoverCalls += 1;
      return [REF];
    },
    isEnabled: () => true,
    isOnline: () => true,
    getCloudSyncTierGate: () => TranscriptEgressGate.Allowed,
    resolveTrustedTranscriptPath: (path) => path,
    statFile: () => Promise.resolve({ size: 10, mtimeMs: 1 }),
    now: () => "2026-10-05T00:00:00.000Z",
    concurrency: 2,
  });
  return {
    service,
    store,
    discoverCalls: () => discoverCalls,
    makeStoreReady: () => {
      ready = store;
    },
  };
}

test("a sweep that found no store runs on the first drain tick that finds one", async () => {
  const lane = serviceWithLateStore();

  await lane.service.sweepOnce();
  assert.equal(lane.discoverCalls(), 0, "no store: nothing to sweep into");

  lane.makeStoreReady();
  await lane.service.drainOnce();

  assert.equal(lane.discoverCalls(), 1);
  assert.equal(lane.store.observed.length, 1);
});

test("the owed sweep runs once, not on every later drain tick", async () => {
  const lane = serviceWithLateStore();
  await lane.service.sweepOnce();
  lane.makeStoreReady();

  await lane.service.drainOnce();
  await lane.service.drainOnce();

  assert.equal(lane.discoverCalls(), 1);
});

test("a drain tick sweeps nothing when no sweep was owed", async () => {
  const lane = serviceWithLateStore();
  lane.makeStoreReady();

  await lane.service.drainOnce();

  assert.equal(lane.discoverCalls(), 0);
});
