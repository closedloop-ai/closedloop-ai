import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { Observability } from "../src/main/observability.js";
import { createQueueStatsDebounce } from "../src/main/queue-stats-debounce.js";

// Wiring sanity: the onQueueStatsChange handler delegates telemetry to the
// shared debounce helper while keeping sendPresence synchronous. Detailed
// debounce mechanics live in queue-stats-debounce.test.ts; the detailed
// observability payload shape lives in observability.test.ts.

type Stats = { activeCommands: number; queueDepth: number };

function buildHandler(sendPresence: (stats: Stats) => void): {
  handler: (stats: Stats) => void;
  cancel: () => void;
} {
  const debounce = createQueueStatsDebounce(
    (active, depth) => Observability.queueStatsChanged(active, depth),
    1000
  );
  return {
    handler: (stats) => {
      sendPresence(stats);
      debounce.trigger(stats);
    },
    cancel: debounce.cancel,
  };
}

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  Observability.reset();
});

describe("onQueueStatsChange wiring", () => {
  test("sendPresence fires synchronously once per invocation (un-throttled)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const sendPresence = mock.fn((_stats: Stats) => {});
    const { handler, cancel } = buildHandler(sendPresence);

    for (let i = 0; i < 10; i++) {
      handler({ activeCommands: i, queueDepth: i });
    }

    assert.strictEqual(
      sendPresence.mock.calls.length,
      10,
      "presence fires per invocation; it is never debounced"
    );
    cancel();
  });

  test("telemetry goes through the shared debounce (1 fire per burst)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const queueStatsChanged = mock.method(
      Observability,
      "queueStatsChanged",
      () => {}
    );
    const { handler, cancel } = buildHandler(() => {});

    for (let i = 0; i < 5; i++) {
      handler({ activeCommands: i, queueDepth: i });
    }
    mock.timers.tick(1000);

    assert.strictEqual(queueStatsChanged.mock.calls.length, 1);
    const args = queueStatsChanged.mock.calls[0].arguments as [number, number];
    assert.deepStrictEqual(args, [4, 4], "trailing-edge value");
    cancel();
  });
});
