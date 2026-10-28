/**
 * @file transcript-inventory-worker-runner.test.ts
 * @description ISS-8376 — the worker transport's own failure modes.
 *
 * Every other suite in this feature injects `runSweep` as a stub, so without
 * this file the runner's whole contract — settle once, never reject, degrade on
 * a dead worker — ships unexercised. The `forkWorker` DI seam exists for exactly
 * this.
 *
 * The contract under test is NEVER REJECTS: the source's honest answer for "no
 * measurement" is the `unavailable` inventory variant, so every failure here
 * must resolve `null` rather than escape as a rejection some caller forgets to
 * catch.
 */
import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { describe, test } from "vitest";
import { runTranscriptInventorySweep } from "../src/main/transcript-sync/transcript-inventory-worker-runner.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import { inventory as validInventory } from "./transcript-analysis-eta-fixtures.js";

type Listener = (value: unknown) => void;

/** A worker stand-in that records what it was told and replays chosen events. */
function fakeWorker(
  script: (emit: (event: string, value?: unknown) => void) => void
) {
  const listeners = new Map<string, Listener[]>();
  let terminated = 0;
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(value);
    }
  };
  const worker = {
    on: (event: string, listener: Listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    postMessage: () => {
      // The runner posts after wiring its listeners, so replay from here.
      script(emit);
    },
    terminate: () => {
      terminated += 1;
      return Promise.resolve(0);
    },
  } as unknown as Worker;
  return { worker, terminated: () => terminated };
}

describe("transcript inventory worker runner (ISS-8376)", () => {
  test("a successful sweep resolves the inventory", async () => {
    const inventory = validInventory({ revision: 3 });
    const { worker } = fakeWorker((emit) =>
      emit("message", { ok: true, inventory })
    );

    const result = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => worker,
    });

    assert.deepEqual(result, inventory);
  });

  test("a worker-reported failure resolves null, never rejects", async () => {
    const { worker } = fakeWorker((emit) =>
      emit("message", { ok: false, error: "EACCES" })
    );

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("a worker `error` degrades to no measurement rather than hanging", async () => {
    const { worker } = fakeWorker((emit) => emit("error", new Error("boom")));

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("a worker that exits without answering degrades to no measurement", async () => {
    const { worker } = fakeWorker((emit) => emit("exit", 1));

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("a fork that throws degrades instead of escaping to the caller", async () => {
    // The worker entry missing from the build, or threads unavailable.
    const result = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => {
        throw new Error("no such worker entry");
      },
    });

    assert.equal(result, null);
  });

  test("the worker is terminated once, and a late event cannot settle twice", async () => {
    const inventory = validInventory({ revision: 9 });
    const { worker, terminated } = fakeWorker((emit) => {
      emit("message", { ok: true, inventory });
      // A dying worker emits `exit` after answering; the settle-once latch must
      // not turn a delivered measurement into a null.
      emit("exit", 0);
      emit("error", new Error("late"));
    });

    const result = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => worker,
    });

    assert.deepEqual(result, inventory);
    assert.equal(terminated(), 1);
  });

  test("a malformed worker message is treated as no measurement", async () => {
    // The worker payload crosses a thread boundary, so its shape is not
    // guaranteed by the types at runtime.
    const { worker } = fakeWorker((emit) => emit("message", "not an object"));

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("an `ok` reply carrying an unusable inventory is not a measurement", async () => {
    // The shape that used to reach the source and throw on the first read:
    // truthy, so the old `response.ok === true` cast stored it, but with no
    // `enumeratedHarnesses` for the projection to map over.
    const { worker } = fakeWorker((emit) =>
      emit("message", { ok: true, inventory: {} })
    );

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("an inventory carrying an impossible byte count is refused", async () => {
    const { worker } = fakeWorker((emit) =>
      emit("message", {
        ok: true,
        inventory: { ...validInventory(), discoveredBytes: -1 },
      })
    );

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("an inventory naming a harness this build does not know is refused", async () => {
    // Left unchecked this survives the projection as `undefined`, which the
    // renderer's closed enum then rejects — blanking the WHOLE measurement
    // with no signal, indistinguishable from "no sweep yet".
    const { worker } = fakeWorker((emit) =>
      emit("message", {
        ok: true,
        inventory: { ...validInventory(), enumeratedHarnesses: ["gemini"] },
      })
    );

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("an inventory whose session count is impossible is refused", async () => {
    // The whole impossible set for a count, not just negative and non-finite:
    // each renders downstream as a confident number of sessions if accepted.
    for (const sessionCount of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      const { worker } = fakeWorker((emit) =>
        emit("message", {
          ok: true,
          inventory: {
            ...validInventory(),
            sessionsByHarness: [
              { harness: TranscriptSourceHarness.Claude, sessionCount },
            ],
          },
        })
      );

      assert.equal(
        await runTranscriptInventorySweep("/tmp/s", {
          forkWorker: () => worker,
        }),
        null,
        `sessionCount ${String(sessionCount)} must not be accepted`
      );
    }
  });

  test("an inventory naming the same harness twice is refused", async () => {
    // A COLLECTION-level invariant no per-entry check can see: both rows are
    // individually valid. The producer folds over a Map keyed by harness so it
    // cannot emit this today — which is the point, since a boundary validator
    // that takes the producer's word for it is not one. Downstream both rows
    // render and both are summed into the stated total.
    const { worker } = fakeWorker((emit) =>
      emit("message", {
        ok: true,
        inventory: {
          ...validInventory(),
          sessionsByHarness: [
            { harness: TranscriptSourceHarness.Claude, sessionCount: 40 },
            { harness: TranscriptSourceHarness.Claude, sessionCount: 3 },
          ],
        },
      })
    );

    assert.equal(
      await runTranscriptInventorySweep("/tmp/s", { forkWorker: () => worker }),
      null
    );
  });

  test("an inventory naming two DIFFERENT harnesses is accepted — the control", async () => {
    const { worker } = fakeWorker((emit) =>
      emit("message", {
        ok: true,
        inventory: {
          ...validInventory(),
          sessionsByHarness: [
            { harness: TranscriptSourceHarness.Claude, sessionCount: 40 },
            { harness: TranscriptSourceHarness.Codex, sessionCount: 3 },
          ],
        },
      })
    );

    const swept = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => worker,
    });
    assert.equal(swept?.sessionsByHarness.length, 2);
  });

  test("only a broken worker contract is reported, not a measurable failure", async () => {
    const reported: string[] = [];
    const report = (label: string) => () => {
      reported.push(label);
    };

    const malformed = fakeWorker((emit) =>
      emit("message", { ok: true, inventory: {} })
    );
    await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => malformed.worker,
      onMalformedReply: report("malformed"),
    });

    // `ok: false` is the sweep itself throwing — a real machine condition the
    // `unavailable` state already describes. Reporting it would drown the
    // signal that means OUR contract broke.
    const threw = fakeWorker((emit) =>
      emit("message", { ok: false, error: "EACCES" })
    );
    await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => threw.worker,
      onMalformedReply: report("threw"),
    });

    const died = fakeWorker((emit) => emit("exit", 1));
    await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => died.worker,
      onMalformedReply: report("died"),
    });

    const unreadable = fakeWorker((emit) => emit("message", "not an object"));
    await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => unreadable.worker,
      onMalformedReply: report("unreadable"),
    });

    assert.deepEqual(reported, ["malformed"]);
  });

  test("a burst of malformed replies is reported once", async () => {
    let reports = 0;
    const { worker } = fakeWorker((emit) => {
      emit("message", { ok: true, inventory: {} });
      emit("message", { ok: true, inventory: {} });
      emit("message", { ok: true, inventory: {} });
    });

    const result = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => worker,
      onMalformedReply: () => {
        reports += 1;
      },
    });

    assert.equal(result, null);
    assert.equal(reports, 1);
  });

  test("a sound inventory reports nothing", async () => {
    const reported: string[] = [];
    const { worker } = fakeWorker((emit) =>
      emit("message", { ok: true, inventory: validInventory() })
    );

    const result = await runTranscriptInventorySweep("/tmp/s", {
      forkWorker: () => worker,
      onMalformedReply: () => reported.push("reported"),
    });

    assert.notEqual(result, null);
    assert.deepEqual(reported, []);
  });
});
