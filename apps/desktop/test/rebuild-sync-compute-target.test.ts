/**
 * @file rebuild-sync-compute-target.test.ts
 * @description #4150: pure, electron-free coverage for the leaf module that owns
 * `resolveRebuildSyncComputeTargetId` and the extracted
 * `buildSharedAgentSessionsListOptions`. The builder was moved out of the
 * grandfathered `agent-dashboard-design-system-runtime.ts`; this pins its
 * two-lane wiring (online-aware compute target + bounded transcript-blob loader
 * that degrades when the store is absent) at the new boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSharedAgentSessionsListOptions,
  resolveRebuildSyncComputeTargetId,
} from "../src/main/dashboard/rebuild-sync-compute-target.js";
import type { TranscriptMainBlobState } from "../src/main/transcript-sync/transcript-sync-types.js";

test("resolveRebuildSyncComputeTargetId honors the online-aware target's null over the legacy getter", () => {
  assert.equal(
    resolveRebuildSyncComputeTargetId({
      getSyncComputeTargetId: () => null,
      getComputeTargetId: () => "stale-target",
    }),
    null
  );
  assert.equal(
    resolveRebuildSyncComputeTargetId({
      getComputeTargetId: () => "legacy-target",
    }),
    "legacy-target"
  );
});

test("buildSharedAgentSessionsListOptions carries the online-aware compute target", () => {
  const options = buildSharedAgentSessionsListOptions(
    { transcriptSync: null },
    { getSyncComputeTargetId: () => "target-1" }
  );
  assert.equal(options.computeTargetId, "target-1");
});

test("buildSharedAgentSessionsListOptions reads the page's blob states through the store", async () => {
  const seen: string[][] = [];
  const state: TranscriptMainBlobState = {
    externalSessionId: "session-a",
  } as TranscriptMainBlobState;
  const options = buildSharedAgentSessionsListOptions(
    {
      transcriptSync: {
        listMainBlobStates: (ids) => {
          seen.push(ids);
          return Promise.resolve([state]);
        },
      },
    },
    { getSyncComputeTargetId: () => "target-1" }
  );

  const result = await options.loadTranscriptBlobStates?.(["session-a"]);
  assert.deepEqual(seen, [["session-a"]]);
  assert.deepEqual(result, [state]);
});

test("buildSharedAgentSessionsListOptions degrades to no blob states when the store is absent", async () => {
  const options = buildSharedAgentSessionsListOptions(
    { transcriptSync: null },
    { getSyncComputeTargetId: () => "target-1" }
  );

  const result = await options.loadTranscriptBlobStates?.(["session-a"]);
  assert.deepEqual(result, []);
});
