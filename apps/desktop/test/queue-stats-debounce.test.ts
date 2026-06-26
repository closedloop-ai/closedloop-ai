import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { createQueueStatsDebounce } from "../src/main/queue-stats-debounce.js";

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("createQueueStatsDebounce", () => {
  test("rate limit: 10 rapid triggers emit 0 before 1000ms, exactly 1 after", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    for (let i = 0; i < 10; i++) {
      debounce.trigger({ activeCommands: i, queueDepth: i });
    }

    mock.timers.tick(999);
    assert.strictEqual(
      fn.mock.calls.length,
      0,
      "no fire before window elapses"
    );
    mock.timers.tick(1);
    assert.strictEqual(fn.mock.calls.length, 1, "exactly one fire at 1000ms");
  });

  test("trailing edge: last triggered value wins", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 1, queueDepth: 1 });
    debounce.trigger({ activeCommands: 2, queueDepth: 2 });
    debounce.trigger({ activeCommands: 9, queueDepth: 9 });

    mock.timers.tick(1000);
    assert.strictEqual(fn.mock.calls.length, 1);
    const args = fn.mock.calls[0].arguments as [number, number];
    assert.deepStrictEqual(args, [9, 9]);
  });

  test("cancel prevents pending fire", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 3, queueDepth: 5 });
    debounce.cancel();
    mock.timers.tick(5000);

    assert.strictEqual(
      fn.mock.calls.length,
      0,
      "cancel drops the pending fire"
    );
  });

  test("trigger after cancel re-arms the debounce", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.trigger({ activeCommands: 1, queueDepth: 1 });
    debounce.cancel();
    debounce.trigger({ activeCommands: 7, queueDepth: 2 });
    mock.timers.tick(1000);

    assert.strictEqual(fn.mock.calls.length, 1);
    const args = fn.mock.calls[0].arguments as [number, number];
    assert.deepStrictEqual(args, [7, 2]);
  });

  test("cancel is idempotent", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn((_active: number, _depth: number) => {});
    const debounce = createQueueStatsDebounce(fn, 1000);

    debounce.cancel();
    debounce.cancel();
    mock.timers.tick(5000);

    assert.strictEqual(fn.mock.calls.length, 0);
  });
});
