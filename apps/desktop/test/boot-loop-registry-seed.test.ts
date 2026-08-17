/**
 * ISS-5811 -- the CROSS-PROCESS half of launch-replay dedupe.
 *
 * The API replays an undelivered launch dispatch with the same commandId, and
 * the relay replays buffered commands on reconnect. Both dedupe layers that
 * makes safe are per-process Maps: `trackedByCommandId` in
 * `cloud-command-executor.ts`, and `runningLoops` in `symphony-loop.ts`, which
 * is the launch handler's ONLY pre-spawn guard. The runner child is detached,
 * so it outlives its Electron process -- meaning a replayed launch can be
 * delivered to a FRESH process whose maps are empty while the original runner
 * is still alive, and spawn a duplicate.
 *
 * These cases construct exactly that: a loop registered by a previous process
 * (persisted in the job store, its pid still alive), a fresh module state
 * standing in for the restarted process, and the replayed launch arriving after
 * the boot seed. A `node:test` file gets its own process, so the empty
 * `runningLoops` here is the real post-restart condition, not a simulation of
 * one.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { seedRunningLoopsFromJobStore } from "../src/main/jobs/boot-loop-registry-seed.js";
import { JobStore, type LocalJob } from "../src/main/jobs/job-store.js";
import { reconcileJobStoreOnBoot } from "../src/main/jobs/job-store-boot-reconciliation.js";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import {
  getActiveLoopPid,
  registerSymphonyLoopRoutes,
  unregisterLoop,
} from "../src/server/operations/symphony-loop.js";
import {
  buildSymphonyLoopContext,
  createRouteRecorder,
} from "./helpers/symphony-loop-op-context.js";

const RE_ALREADY_RUNNING = /already running on this machine/;
const LIVE_LOOP_ID = "aaaaaaaa-0000-0000-0000-00000000e811";
const DEAD_LOOP_ID = "bbbbbbbb-0000-0000-0000-00000000e811";

/**
 * A pid that is guaranteed NOT to be running. Chosen high and then probed, so a
 * recycled pid cannot silently turn the dead-job case into a live one.
 */
function findDeadPid(): number {
  for (let candidate = 4_194_300; candidate > 4_000_000; candidate--) {
    try {
      process.kill(candidate, 0);
    } catch {
      return candidate;
    }
  }
  throw new Error("could not find an unused pid");
}

let tmpDir: string;
let jobStore: JobStore;

function persistJob(overrides: Partial<LocalJob>): void {
  const now = new Date().toISOString();
  jobStore.upsert({
    id: overrides.loopId ?? "job-1",
    kind: "SYMPHONY_LOOP",
    loopId: overrides.loopId ?? "job-1",
    command: LoopCommand.Plan,
    status: "RUNNING",
    startedAt: now,
    updatedAt: now,
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-loop-seed-"));
  jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs" });
});

afterEach(() => {
  // `runningLoops` is module state shared by every case in this file; leaving a
  // seeded entry behind would let one case satisfy the next one's guard.
  unregisterLoop(LIVE_LOOP_ID);
  unregisterLoop(DEAD_LOOP_ID);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("seedRunningLoopsFromJobStore (ISS-5811)", () => {
  test("adopts a persisted loop whose runner survived the restart", () => {
    persistJob({ loopId: LIVE_LOOP_ID, pid: process.pid });

    // The condition a replayed command actually lands in: a process that never
    // registered this loop, holding no memory of it.
    assert.equal(getActiveLoopPid(LIVE_LOOP_ID), null);

    const seeded = seedRunningLoopsFromJobStore(jobStore);

    assert.deepEqual(seeded, [LIVE_LOOP_ID]);
    assert.equal(getActiveLoopPid(LIVE_LOOP_ID), process.pid);
  });

  test("leaves a persisted loop whose runner is gone unregistered", () => {
    // The seed must not become a blanket block: a job whose runner died while
    // the app was closed has to stay launchable.
    persistJob({ loopId: DEAD_LOOP_ID, pid: findDeadPid() });

    const seeded = seedRunningLoopsFromJobStore(jobStore);

    assert.deepEqual(seeded, []);
    assert.equal(getActiveLoopPid(DEAD_LOOP_ID), null);
  });

  test("skips a persisted loop that never recorded a pid", () => {
    persistJob({ loopId: DEAD_LOOP_ID, pid: undefined });

    assert.deepEqual(seedRunningLoopsFromJobStore(jobStore), []);
    assert.equal(getActiveLoopPid(DEAD_LOOP_ID), null);
  });
});

describe("replayed launch after a restart (ISS-5811)", () => {
  test("answers 409 instead of spawning a second runner for a live loop", async () => {
    persistJob({ loopId: LIVE_LOOP_ID, pid: process.pid });
    const routes = createRouteRecorder();
    registerSymphonyLoopRoutes(
      routes.dispatcher as never,
      () => [tmpDir],
      new LoopSchedulerContext(),
      () => "http://127.0.0.1:1",
      jobStore
    );

    // Boot, through the real entry point the app calls: reconcile-then-seed,
    // synchronously, before the cloud socket can accept anything. Driving the
    // seed directly here would leave the production wiring untested.
    reconcileJobStoreOnBoot(jobStore);

    // The replay: same loopId, delivered to this process for the first time.
    const context = buildSymphonyLoopContext({
      loopId: LIVE_LOOP_ID,
      command: LoopCommand.Plan,
      closedLoopAuthToken: "tok",
      prompt: "replayed launch",
      artifacts: [],
    });
    await routes.find("POST", "/api/gateway/symphony/loop")(context);

    assert.equal(context.responseStatus, 409);
    assert.match(context.responseBody, RE_ALREADY_RUNNING);
  });
});
