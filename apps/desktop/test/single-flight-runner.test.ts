import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSingleFlightRunner } from "../src/main/packs/single-flight-runner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSingleFlightRunner", () => {
  test("executes a single run", async () => {
    let count = 0;
    const runner = createSingleFlightRunner({
      execute: () => {
        count++;
        return Promise.resolve();
      },
    });
    await runner.run();
    assert.equal(count, 1);
  });

  test("coalesces concurrent triggers into one in-flight + one rerun", async () => {
    let count = 0;
    const d = deferred();
    const runner = createSingleFlightRunner({
      execute: async () => {
        count++;
        if (count === 1) {
          await d.promise;
        }
      },
    });

    const first = runner.run();
    const second = runner.run();
    const third = runner.run();

    d.resolve();
    await first;
    await second;
    await third;

    assert.equal(count, 2);
  });

  test("run resolves immediately after stop", async () => {
    const runner = createSingleFlightRunner({
      execute: () => Promise.reject(new Error("should not execute")),
    });
    runner.stop();
    assert.equal(runner.isStopped(), true);
    await runner.run();
  });

  test("stop cancels a queued rerun", async () => {
    let count = 0;
    const d = deferred();
    const runner = createSingleFlightRunner({
      execute: async () => {
        count++;
        if (count === 1) {
          await d.promise;
        }
      },
    });

    const first = runner.run();
    const _queued = runner.run();
    runner.stop();
    d.resolve();
    await first;

    assert.equal(count, 1);
  });

  test("onError receives execute errors without rejecting", async () => {
    const errors: unknown[] = [];
    const runner = createSingleFlightRunner({
      execute: () => Promise.reject(new Error("boom")),
      onError: (e) => errors.push(e),
    });

    await runner.run();
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "boom");
  });

  test("onStop is called when stop runs", () => {
    let called = false;
    const runner = createSingleFlightRunner({
      execute: () => Promise.resolve(),
      onStop: () => {
        called = true;
      },
    });
    runner.stop();
    assert.equal(called, true);
  });

  test("isStopped returns false before stop", () => {
    const runner = createSingleFlightRunner({
      execute: () => Promise.resolve(),
    });
    assert.equal(runner.isStopped(), false);
  });
});
