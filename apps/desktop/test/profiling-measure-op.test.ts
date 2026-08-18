import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { measureOp } from "../src/main/database/db-host/db-host-memory-watchdog.js";
import type { ProfilingDbOpRow } from "../src/shared/profiling.js";
import { createTestClock } from "./helpers/profiling-test-helpers.js";

function createRecordingSink(): {
  rows: ProfilingDbOpRow[];
  append(row: ProfilingDbOpRow): void;
} {
  const rows: ProfilingDbOpRow[] = [];
  return { rows, append: (row) => rows.push(row) };
}

const noopLog = () => {
  // measureOp only logs on heap-pressure thresholds these tests never cross.
};

describe("measureOp profiling extension", () => {
  test("records the op's wall time and returns its value unchanged", async () => {
    const sink = createRecordingSink();
    const clock = createTestClock();

    const result = await measureOp(
      "dashboard.getInsights",
      noopLog,
      () => {
        clock.advance(250);
        return Promise.resolve({ rows: 3 });
      },
      { profiling: { sink, clock } }
    );

    assert.deepEqual(result, { rows: 3 });
    assert.deepEqual(sink.rows, [
      { op: "dashboard.getInsights", ms: 250, ts: 1_700_000_000_250 },
    ]);
  });

  test("a throwing op is still timed and still rethrows the original error", async () => {
    const sink = createRecordingSink();
    const clock = createTestClock();
    const boom = new Error("db op failed");

    await assert.rejects(
      async () =>
        await measureOp(
          "sessions.getAll",
          noopLog,
          () => {
            clock.advance(80);
            return Promise.reject(boom);
          },
          { profiling: { sink, clock } }
        ),
      (error) => {
        assert.equal(error, boom, "the original error instance must propagate");
        return true;
      }
    );

    assert.deepEqual(sink.rows, [
      { op: "sessions.getAll", ms: 80, ts: 1_700_000_000_080 },
    ]);
  });

  test("a throwing sink is isolated from the op", async () => {
    const clock = createTestClock();

    const result = await measureOp(
      "sessions.getAll",
      noopLog,
      () => Promise.resolve("value survives"),
      {
        profiling: {
          sink: {
            append() {
              throw new Error("sink is on fire");
            },
          },
          clock,
        },
      }
    );

    assert.equal(result, "value survives");
  });

  test("a throwing clock disables timing without touching the op", async () => {
    const sink = createRecordingSink();

    const result = await measureOp(
      "sessions.getAll",
      noopLog,
      () => Promise.resolve("value survives"),
      {
        profiling: {
          sink,
          clock: {
            nowMs() {
              throw new Error("clock is broken");
            },
            nowEpochMs: () => 0,
          },
        },
      }
    );

    assert.equal(result, "value survives");
    assert.deepEqual(
      sink.rows,
      [],
      "a duration we could not compute must not be written as a number"
    );
  });

  test("without profiling options the op behaves exactly as before", async () => {
    const logged: string[] = [];

    const result = await measureOp(
      "sessions.getAll",
      (message) => logged.push(message),
      () => Promise.resolve(42)
    );

    assert.equal(result, 42);
    assert.deepEqual(
      logged,
      [],
      "a small op must not trip the heap-delta warning"
    );
  });
});
