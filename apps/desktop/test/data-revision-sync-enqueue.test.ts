/**
 * ISS-5135: coverage for the data-revision rebuild's sync hand-off.
 *
 * This path was previously carried inside the FEA-3427 wall-clock heal
 * orchestration and had NO direct test — the deleted `wall-clock-resync-
 * orchestration` suite covered only `resolveWallClockResyncIds` (candidate
 * folding and marker gating), all of which went away with the heal. What survived
 * is the part the rebuild actually depends on: enqueue the changed sessions into
 * the durable outbox under the captured identity, then feed them into the live
 * backfill queue. These pin that behavior and its four refusal paths, so the
 * enqueue cannot silently stop reaching the cloud.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentSessionSyncClass } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { RunDataRevisionSyncEnqueueInput } from "../src/main/dashboard/data-revision-sync-enqueue.js";
import { runDataRevisionSyncEnqueueAndFeed } from "../src/main/dashboard/data-revision-sync-enqueue.js";

const TARGET = "compute-target-a";
// ISS-5135: derived through the SAME builder the module uses, not a magic string —
// so this pins that the outbox row and the live inject are keyed by
// `buildAgentSessionSyncSourceKey(capturedComputeTargetId)`, which is now the
// module's own internal derivation rather than a caller-supplied field.
const SOURCE_KEY = buildAgentSessionSyncSourceKey(TARGET);

type Recorded = {
  enqueued: { sourceKey: string; ids: string[] }[];
  injected: { ids: readonly string[]; sourceKey: string | null }[];
  logs: string[];
};

function run(overrides: Partial<RunDataRevisionSyncEnqueueInput> = {}): {
  recorded: Recorded;
  done: Promise<void>;
} {
  const recorded: Recorded = { enqueued: [], injected: [], logs: [] };
  const input: RunDataRevisionSyncEnqueueInput = {
    changedSessionIds: ["s1", "s2"],
    capturedComputeTargetId: TARGET,
    enqueueOutboxEntries: (sourceKey, entries) => {
      recorded.enqueued.push({
        sourceKey,
        ids: entries.map((entry) => entry.externalSessionId),
      });
    },
    resolveLiveComputeTargetId: () => TARGET,
    injectSyncBackfillIds: (ids, sourceKey) => {
      recorded.injected.push({ ids, sourceKey });
    },
    shouldContinue: () => true,
    log: (message) => recorded.logs.push(message),
    ...overrides,
  };
  return { recorded, done: runDataRevisionSyncEnqueueAndFeed(input) };
}

describe("ISS-5135 data-revision sync enqueue-and-feed", () => {
  test("enqueues the changed sessions under the captured key and feeds the live queue", async () => {
    const { recorded, done } = run();
    await done;
    assert.deepEqual(recorded.enqueued, [
      { sourceKey: SOURCE_KEY, ids: ["s1", "s2"] },
    ]);
    assert.deepEqual(recorded.injected, [
      { ids: ["s1", "s2"], sourceKey: SOURCE_KEY },
    ]);
  });

  test("marks every entry as a backfill sync class", async () => {
    const classes: AgentSessionSyncClass[] = [];
    const { done } = run({
      enqueueOutboxEntries: (_sourceKey, entries) => {
        for (const entry of entries) {
          classes.push(entry.syncClass);
        }
      },
    });
    await done;
    assert.deepEqual(classes, [
      AgentSessionSyncClass.Backfill,
      AgentSessionSyncClass.Backfill,
    ]);
  });

  test("offline (no captured target) enqueues nothing and injects nothing", async () => {
    const { recorded, done } = run({ capturedComputeTargetId: null });
    await done;
    assert.deepEqual(recorded.enqueued, []);
    assert.deepEqual(recorded.injected, [], "an offline pass must not inject");
  });

  test("a legacy source without the outbox delegate is a no-op", async () => {
    const { recorded, done } = run({ enqueueOutboxEntries: undefined });
    await done;
    assert.deepEqual(recorded.injected, []);
  });

  test("a compute-target drift skips the enqueue AND the inject, and says so", async () => {
    // Defense-in-depth, NOT a live production guard: retiring the heal removed the
    // awaited candidate/marker reads that used to sit between the caller's capture
    // and this re-resolve, and post-boot-maintenance's resolveComputeTargetId is
    // synchronous — so with today's caller the target cannot drift in that gap.
    // Pinned so the behavior survives for any future caller that captures earlier.
    const { recorded, done } = run({
      resolveLiveComputeTargetId: () => "compute-target-b",
    });
    await done;
    assert.deepEqual(recorded.enqueued, []);
    assert.deepEqual(recorded.injected, []);
    assert.ok(
      recorded.logs.some((line) => line.includes("compute target changed")),
      "the drift is reported"
    );
  });

  test("a cancelled generation does not inject, even though the enqueue landed", async () => {
    // `cancelCollectorMaintenance` can advance the generation while the enqueue is
    // awaited; the durable outbox row stands, but a superseded generation must not
    // nudge live queue/network work during stop/restart/close.
    const { recorded, done } = run({ shouldContinue: () => false });
    await done;
    assert.deepEqual(
      recorded.enqueued,
      [{ sourceKey: SOURCE_KEY, ids: ["s1", "s2"] }],
      "the durable enqueue still happened"
    );
    assert.deepEqual(recorded.injected, [], "but nothing was injected");
  });

  test("an enqueue failure is logged and suppresses the inject", async () => {
    const { recorded, done } = run({
      enqueueOutboxEntries: () => {
        throw new Error("disk full");
      },
    });
    await done;
    assert.deepEqual(
      recorded.injected,
      [],
      "unconfirmed enqueue must not feed the live queue"
    );
    assert.ok(
      recorded.logs.some((line) => line.includes("disk full")),
      "the failure is reported with its cause"
    );
  });

  test("the durable enqueue is AWAITED before the live inject fires", async () => {
    // Every other case here uses a synchronous recorder, which cannot tell an
    // awaited enqueue from an un-awaited one — deleting the `await` would leave
    // them all green. The ordering is the module's whole reason for existing: if
    // the inject fires first, the loop can start uploading before the durable
    // outbox row is committed, and a crash in that gap loses the record.
    let releaseEnqueue: (() => void) | undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const seen: string[][] = [];
    const done = runDataRevisionSyncEnqueueAndFeed({
      changedSessionIds: ["s1"],
      capturedComputeTargetId: TARGET,
      enqueueOutboxEntries: () => enqueueGate,
      resolveLiveComputeTargetId: () => TARGET,
      injectSyncBackfillIds: (ids) => seen.push([...ids]),
      shouldContinue: () => true,
      log: () => undefined,
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      seen,
      [],
      "nothing may be injected while the outbox write is still pending"
    );

    releaseEnqueue?.();
    await done;
    assert.deepEqual(seen, [["s1"]], "the inject runs once the write resolves");
  });

  test("an empty changed set enqueues nothing and injects nothing", async () => {
    const { recorded, done } = run({ changedSessionIds: [] });
    await done;
    assert.deepEqual(recorded.enqueued, []);
    assert.deepEqual(recorded.injected, []);
  });
});
