/**
 * @file db-host-close-sequence.test.ts
 * @description ISS-6003 — the db-host must flush its ISS-4430 CPU profile BEFORE
 * it closes the store.
 *
 * Main kills the child `CLOSE_ACK_TIMEOUT_MS` (2s) after posting `Close`, and
 * closing the store drains the write queue. A profiling run exists to measure a
 * BUSY db-host, so during one the store close outlives that budget — and with
 * the profile write sequenced behind it, the capture was lost in exactly the
 * state it was taken for. Observed directly: a 5-minute import capture wrote
 * `db-ops.jsonl` and `main.cpuprofile` but no `dbhost.cpuprofile`.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { runDbHostCloseSequence } from "../src/main/database/db-host/db-host-close-sequence.js";

/** Longer than the sequence needs, short enough to keep the suite fast. */
const ABANDON_MS = 50;

describe("db-host close sequence", () => {
  test("flushes the profile before the store close, which can outlive the ack budget", async () => {
    const calls: string[] = [];
    let closeStarted = false;

    const sequence = runDbHostCloseSequence({
      stopProfiling: async () => {
        // A real profile write is async (Profiler.stop, then a file write), so
        // yield before recording — a step that resolved synchronously would
        // pass an ordering assertion it never actually earned.
        await Promise.resolve();
        assert.equal(
          closeStarted,
          false,
          "the store close must not have started before the profile is flushed"
        );
        calls.push("profile");
      },
      closeDatabase: () => {
        closeStarted = true;
        calls.push("close");
        // The wedged case: the write queue is busy with an import, so this
        // never settles and main kills the child.
        return new Promise<void>(() => {
          // never resolves
        });
      },
    });

    const abandoned = Symbol("abandoned");
    const outcome = await Promise.race([
      sequence.then(() => "settled" as const),
      new Promise<typeof abandoned>((resolve) => {
        setTimeout(() => resolve(abandoned), ABANDON_MS).unref();
      }),
    ]);

    assert.equal(
      outcome,
      abandoned,
      "the store close is expected to hang in this scenario"
    );
    assert.deepEqual(
      calls,
      ["profile", "close"],
      "the profile must be flushed even though the store close never returns"
    );
  });

  test("a failing store close still resolves, so the process can exit", async () => {
    const calls: string[] = [];
    await runDbHostCloseSequence({
      stopProfiling: () => {
        calls.push("profile");
        return Promise.resolve();
      },
      closeDatabase: () => {
        calls.push("close");
        return Promise.reject(new Error("store already gone"));
      },
    });
    assert.deepEqual(calls, ["profile", "close"]);
  });

  test("a failing profile flush still closes the store, so a full disk cannot skip it", async () => {
    const calls: string[] = [];
    await runDbHostCloseSequence({
      stopProfiling: () => {
        calls.push("profile");
        return Promise.reject(new Error("ENOSPC writing dbhost.cpuprofile"));
      },
      closeDatabase: () => {
        calls.push("close");
        return Promise.resolve();
      },
    });
    assert.deepEqual(
      calls,
      ["profile", "close"],
      "the store close must run even when the profile write throws"
    );
  });

  test("resolves with neither step wired (profiling off, store never opened)", async () => {
    await runDbHostCloseSequence({});
  });
});
