import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeavyOpGate } from "../src/main/database/db-host/heavy-op-gate.js";

const BOOM = /boom/;

/**
 * The gate is what keeps a get-insights recompute and a backfill/store-op from
 * running concurrently in the single db-host worker (their summed peak was the
 * exit-5 OOM that let the backfill queue grow unbounded). These tests pin the
 * two properties that matter: mutual exclusion, and that a failing op cannot
 * wedge the gate shut for everything after it.
 */
describe("createHeavyOpGate", () => {
  it("never runs two gated ops concurrently (serializes heavy work)", async () => {
    const gate = createHeavyOpGate();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const makeOp = (id: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield across a couple microtask/macrotask turns so a broken gate would
      // certainly interleave.
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(id);
      active--;
      return id;
    };

    const results = await Promise.all([
      gate.runExclusive(makeOp(1)),
      gate.runExclusive(makeOp(2)),
      gate.runExclusive(makeOp(3)),
    ]);

    // At most one op ever in flight, and they run in submission order (FIFO).
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results, [1, 2, 3]);
  });

  it("propagates a task's rejection to its own caller", async () => {
    const gate = createHeavyOpGate();
    await assert.rejects(
      () => gate.runExclusive(() => Promise.reject(new Error("boom"))),
      BOOM
    );
  });

  it("does not let a rejected op wedge the gate for later ops", async () => {
    const gate = createHeavyOpGate();
    // A failing op must not poison the chain.
    const failed = gate
      .runExclusive(() => Promise.reject(new Error("boom")))
      .catch(() => "handled");
    const after = gate.runExclusive(() => Promise.resolve("ok"));

    assert.equal(await failed, "handled");
    assert.equal(await after, "ok");
  });

  it("a slow op delays the next op until it settles (mutual exclusion holds across time)", async () => {
    const gate = createHeavyOpGate();
    const events: string[] = [];

    const slow = gate.runExclusive(async () => {
      events.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("slow:end");
    });
    const fast = gate.runExclusive(() => {
      events.push("fast:run");
      return Promise.resolve();
    });

    await Promise.all([slow, fast]);
    // fast must not run until slow has fully settled.
    assert.deepEqual(events, ["slow:start", "slow:end", "fast:run"]);
  });
});

/**
 * FEA-3150 (FEA-3132 P1): memory-aware ADMISSION. Serialization bounds the peak
 * to a single heavy op; admission additionally holds a heavy op OUT of the
 * worker while it's already under memory pressure, so its peak doesn't land on
 * top of an existing RSS/page-cache high-water. The gate runs the injected
 * `admit` gate (with exclusivity already held) immediately before the op. These
 * tests pin the three properties: admit immediately with no pressure, defer
 * (await) under pressure and run once it clears, and never deadlock (proceed
 * after a bounded wait). The `admit` gate is injected directly so the memory
 * signal itself is exercised in db-host-memory-pressure.test.ts, not re-mocked.
 */
describe("createHeavyOpGate — memory-aware admission (FEA-3150)", () => {
  it("admits a heavy op immediately when there is no memory pressure", async () => {
    const events: string[] = [];
    const gate = createHeavyOpGate({
      admit: () => {
        events.push("admit");
        return Promise.resolve();
      },
    });

    const result = await gate.runExclusive(() => {
      events.push("op");
      return Promise.resolve("done");
    });

    assert.equal(result, "done");
    // admit runs before the op, and the op is not deferred.
    assert.deepEqual(events, ["admit", "op"]);
  });

  it("defers the op while under pressure and admits it once pressure clears", async () => {
    const events: string[] = [];
    // Simulate pressure: the admit gate blocks until `releaseAdmit` is called
    // (standing in for the bounded pressure-clear wait resolving).
    let releaseAdmit: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      releaseAdmit = resolve;
    });

    const gate = createHeavyOpGate({
      admit: async () => {
        events.push("admit:enter");
        await admitted;
        events.push("admit:exit");
      },
    });

    const opDone = gate.runExclusive(() => {
      events.push("op");
      return Promise.resolve();
    });

    // Give the microtask queue a few turns; the op must NOT have run — it's
    // parked in admission behind the still-high pressure.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, ["admit:enter"]);

    // Clear pressure → admission resolves → the op runs.
    releaseAdmit?.();
    await opDone;
    assert.deepEqual(events, ["admit:enter", "admit:exit", "op"]);
  });

  it("does not deadlock: a bounded admission gate that gives up admits the op", async () => {
    // Model the real bounded wait: admit resolves after a capped number of
    // pressure checks even if pressure never clears, so the op still runs.
    let checks = 0;
    const maxChecks = 3;
    const gate = createHeavyOpGate({
      admit: async () => {
        // Always "high", but bounded — proceeds after maxChecks.
        while (checks < maxChecks) {
          checks += 1;
          await Promise.resolve();
        }
      },
    });

    // Even under sustained (simulated) pressure, the op must run — never hang.
    const result = await gate.runExclusive(() => Promise.resolve("ran"));
    assert.equal(result, "ran");
    assert.equal(checks, maxChecks);
  });

  it("still serializes ops with admission enabled (admit runs per-op, in order)", async () => {
    const events: string[] = [];
    const gate = createHeavyOpGate({
      admit: () => {
        events.push("admit");
        return Promise.resolve();
      },
    });

    const a = gate.runExclusive(async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("a:end");
    });
    const b = gate.runExclusive(() => {
      events.push("b");
      return Promise.resolve();
    });

    await Promise.all([a, b]);
    // Each op is admitted immediately before it runs, and b's admission does not
    // happen until a has fully settled (mutual exclusion still holds).
    assert.deepEqual(events, ["admit", "a:start", "a:end", "admit", "b"]);
  });

  it("a rejected op does not wedge the admission gate for later ops", async () => {
    const gate = createHeavyOpGate({
      admit: () => Promise.resolve(),
    });
    const failed = gate
      .runExclusive(() => Promise.reject(new Error("boom")))
      .catch(() => "handled");
    const after = gate.runExclusive(() => Promise.resolve("ok"));

    assert.equal(await failed, "handled");
    assert.equal(await after, "ok");
  });
});
