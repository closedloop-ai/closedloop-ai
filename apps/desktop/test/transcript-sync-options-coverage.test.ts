/**
 * @file transcript-sync-options-coverage.test.ts
 * @description ISS-8730 coverage for `transcript-sync-options.ts`. That module
 * is almost entirely declarations (`Scheduler`, `TranscriptSyncServiceOptions`,
 * the renderer-facing re-exports) — `defaultScheduler` is the ONLY runtime
 * export. These tests pin its current behavior: a thin pass-through onto the
 * global timer functions, used by `TranscriptSyncService` whenever a caller
 * omits `options.scheduler`.
 *
 * Timers are driven with the shared `nodeTestTimers` fake-clock facade
 * (`test/support/node-test-fake-timers.ts`) rather than real waits, per the
 * repo's ban on timing-based assertions; the clock resets in `afterEach`
 * unconditionally, not at the tail of each case, so an assertion failure
 * mid-test can never leak a frozen clock into a later one.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { defaultScheduler } from "../src/main/transcript-sync/transcript-sync-options.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

describe("defaultScheduler.setTimeout / clearTimeout", () => {
  test("setTimeout forwards the callback and delay to the global timer and fires it once elapsed", () => {
    nodeTestTimers.enable(["setTimeout"]);
    let calls = 0;
    defaultScheduler.setTimeout(() => {
      calls += 1;
    }, 100);

    nodeTestTimers.tick(99);
    assert.equal(calls, 0);

    nodeTestTimers.tick(1);
    assert.equal(calls, 1);
  });

  test("clearTimeout cancels a pending callback before it fires", () => {
    nodeTestTimers.enable(["setTimeout"]);
    let calls = 0;
    const handle = defaultScheduler.setTimeout(() => {
      calls += 1;
    }, 100);

    defaultScheduler.clearTimeout(handle);
    nodeTestTimers.tick(1000);

    assert.equal(calls, 0);
  });
});

describe("defaultScheduler.setInterval / clearInterval", () => {
  test("setInterval repeats the callback on the global timer at the given cadence", () => {
    nodeTestTimers.enable(["setInterval"]);
    let calls = 0;
    defaultScheduler.setInterval(() => {
      calls += 1;
    }, 50);

    nodeTestTimers.tick(150);

    assert.equal(calls, 3);
  });

  test("clearInterval stops further repeats without undoing calls that already fired", () => {
    nodeTestTimers.enable(["setInterval"]);
    let calls = 0;
    const handle = defaultScheduler.setInterval(() => {
      calls += 1;
    }, 50);

    nodeTestTimers.tick(120);
    assert.equal(calls, 2);

    defaultScheduler.clearInterval(handle);
    nodeTestTimers.tick(500);

    assert.equal(calls, 2);
  });
});
