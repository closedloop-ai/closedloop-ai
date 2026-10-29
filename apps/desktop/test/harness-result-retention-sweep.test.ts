/**
 * @file harness-result-retention-sweep.test.ts
 * @description ISS-7332 — the boot-owned cleanup path for retained raw harness
 * result envelopes.
 *
 * Reviewed invariant: expiry must not depend on loop traffic. The store prunes
 * on construction and on each retain, both driven by a loop finishing, so a user
 * who stops running eligible loops keeps PLAINTEXT envelopes on disk past the
 * 90-day window they were promised. Time is pinned with fake timers throughout —
 * a wall-clock assertion here would be untestable at a 90-day window and
 * flaky at an interval.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { HarnessResultEnvelopeStore } from "../src/main/cost/harness-result-retention.js";
import { startHarnessResultRetentionSweep } from "../src/main/cost/harness-result-retention-sweep.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const tempDirs: string[] = [];
/** 2026-08-20T00:00:00Z — a pinned epoch so every window assertion is exact. */
const FIXED_NOW_MS = 1_787_270_400_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  nodeTestTimers.reset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeStore(): HarnessResultEnvelopeStore {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sweep-store-"));
  tempDirs.push(cwd);
  return new HarnessResultEnvelopeStore({
    cwd,
    name: "sweep-store",
    retentionDays: 90,
  });
}

function retainAt(store: HarnessResultEnvelopeStore, loopId: string): void {
  store.retain({
    loopId,
    retainedAtMs: Date.now(),
    rawEnvelope: JSON.stringify({ type: "result", total_cost_usd: 0.5 }),
  });
}

test("the sweep prunes once at boot, before any interval elapses", () => {
  nodeTestTimers.enable(["Date", "setInterval"], {
    now: FIXED_NOW_MS,
  });
  const store = makeStore();
  retainAt(store, "loop-old");
  nodeTestTimers.tick(91 * MS_PER_DAY);

  const sweep = startHarnessResultRetentionSweep({
    store,
    log: () => undefined,
  });

  try {
    assert.equal(
      store.list().length,
      0,
      "an app that boots and never runs a loop must still expire the record"
    );
  } finally {
    sweep.stop();
  }
});

test("the sweep keeps pruning on its interval with no loop traffic", () => {
  nodeTestTimers.enable(["Date", "setInterval"], {
    now: FIXED_NOW_MS,
  });
  const store = makeStore();
  const sweep = startHarnessResultRetentionSweep({
    store,
    intervalMs: MS_PER_DAY,
    log: () => undefined,
  });

  try {
    retainAt(store, "loop-live");
    assert.equal(store.list().length, 1, "precondition: retained and fresh");

    nodeTestTimers.tick(91 * MS_PER_DAY);

    assert.equal(
      store.list().length,
      0,
      "the scheduled sweep must expire it without another retain"
    );
  } finally {
    sweep.stop();
  }
});

test("stop clears the interval so a stopped sweep never fires again", () => {
  nodeTestTimers.enable(["Date", "setInterval"], {
    now: FIXED_NOW_MS,
  });
  const store = makeStore();
  let sweeps = 0;
  const counting = {
    pruneExpired(): number {
      sweeps += 1;
      return 0;
    },
  } as unknown as HarnessResultEnvelopeStore;

  const sweep = startHarnessResultRetentionSweep({
    store: counting,
    intervalMs: MS_PER_DAY,
    log: () => undefined,
  });
  assert.equal(sweeps, 1, "precondition: the boot sweep ran");

  sweep.stop();
  nodeTestTimers.tick(10 * MS_PER_DAY);

  assert.equal(sweeps, 1, "a stopped sweep must not keep a timer alive");
  sweep.stop();
  assert.equal(sweeps, 1, "stop is idempotent");
  assert.equal(store.list().length, 0);
});

test("a throwing prune is absorbed and the schedule survives", () => {
  nodeTestTimers.enable(["Date", "setInterval"], {
    now: FIXED_NOW_MS,
  });
  let calls = 0;
  const flaky = {
    pruneExpired(): number {
      calls += 1;
      if (calls === 1) {
        throw new Error("store unreadable");
      }
      return 0;
    },
  } as unknown as HarnessResultEnvelopeStore;
  const logged: string[] = [];

  const sweep = startHarnessResultRetentionSweep({
    store: flaky,
    intervalMs: MS_PER_DAY,
    log: (message) => logged.push(message),
  });

  try {
    assert.equal(calls, 1);
    assert.equal(logged.length, 1, "the failure is not swallowed silently");
    nodeTestTimers.tick(MS_PER_DAY);
    assert.equal(
      calls,
      2,
      "a dead sweep is the condition this module exists to prevent"
    );
  } finally {
    sweep.stop();
  }
});
