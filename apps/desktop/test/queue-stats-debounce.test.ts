import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { vi } from "vitest";
import { createQueueStatsDebounce } from "../src/main/util/queue-stats-debounce.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
  vi.restoreAllMocks();
});

describe("createQueueStatsDebounce", () => {
  test("rate limit: 10 rapid triggers emit 0 before 1000ms, exactly 1 after", () => {
    nodeTestTimers.enable(["setTimeout"]);
    const fn = vi.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    for (let i = 0; i < 10; i++) {
      debounce.trigger({ activeCommands: i, queueDepth: i });
    }

    nodeTestTimers.tick(999);
    assert.strictEqual(
      fn.mock.calls.length,
      0,
      "no fire before window elapses"
    );
    nodeTestTimers.tick(1);
    assert.strictEqual(fn.mock.calls.length, 1, "exactly one fire at 1000ms");
  });

  test("trailing edge: last triggered value wins", () => {
    nodeTestTimers.enable(["setTimeout"]);
    const fn = vi.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 1, queueDepth: 1 });
    debounce.trigger({ activeCommands: 2, queueDepth: 2 });
    debounce.trigger({ activeCommands: 9, queueDepth: 9 });

    nodeTestTimers.tick(1000);
    assert.strictEqual(fn.mock.calls.length, 1);
    const args = fn.mock.calls[0] as [number, number];
    assert.deepStrictEqual(args, [9, 9]);
  });

  test("cancel prevents pending fire", () => {
    nodeTestTimers.enable(["setTimeout"]);
    const fn = vi.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 3, queueDepth: 5 });
    debounce.cancel();
    nodeTestTimers.tick(5000);

    assert.strictEqual(
      fn.mock.calls.length,
      0,
      "cancel drops the pending fire"
    );
  });

  test("trigger after cancel re-arms the debounce", () => {
    nodeTestTimers.enable(["setTimeout"]);
    const fn = vi.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 1, queueDepth: 1 });
    debounce.cancel();
    debounce.trigger({ activeCommands: 7, queueDepth: 2 });
    nodeTestTimers.tick(1000);

    assert.strictEqual(fn.mock.calls.length, 1);
    const args = fn.mock.calls[0] as [number, number];
    assert.deepStrictEqual(args, [7, 2]);
  });

  test("cancel is idempotent", () => {
    nodeTestTimers.enable(["setTimeout"]);
    const fn = vi.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.cancel();
    debounce.cancel();
    nodeTestTimers.tick(5000);

    assert.strictEqual(fn.mock.calls.length, 0);
  });
});
