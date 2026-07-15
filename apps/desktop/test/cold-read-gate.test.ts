/**
 * @file cold-read-gate.test.ts
 * @description FEA-3132 (B1/B5) — the cold full-file reads (`parseChatSessionFile`
 * and the cold transcript extraction) are routed through a shared counting
 * semaphore so N concurrent cold reads can't stack their full-file buffers in
 * the one db-host heap. These tests pin the properties that matter: the cap is
 * never exceeded (peak concurrency == max), a rejected task releases its permit
 * (one failing read can't wedge the gate), and the cap is configurable.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createColdReadGate,
  DEFAULT_COLD_READ_CONCURRENCY,
  resolveColdReadConcurrency,
} from "../src/main/collectors/parsing/cold-read-gate.js";

const BOOM = /boom/;

describe("createColdReadGate", () => {
  it("caps concurrent cold reads to the configured max (serializes the overflow)", async () => {
    const MAX = 2;
    const N = 6;
    const gate = createColdReadGate(MAX);

    let active = 0;
    let maxActive = 0;

    const makeRead = (id: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield across a couple of turns so a broken gate would certainly let more
      // than MAX reads co-peak.
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return id;
    };

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => gate.run(makeRead(i)))
    );

    // Never more than MAX reads buffering at once, and every read completed.
    assert.equal(maxActive, MAX);
    assert.deepEqual(
      results,
      Array.from({ length: N }, (_, i) => i)
    );
    assert.equal(gate.active, 0);
  });

  it("serializes strictly at max=1 (single-flight)", async () => {
    const gate = createColdReadGate(1);
    let active = 0;
    let maxActive = 0;

    const makeRead = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };

    await Promise.all([
      gate.run(makeRead()),
      gate.run(makeRead()),
      gate.run(makeRead()),
    ]);

    assert.equal(maxActive, 1);
  });

  it("runs a task below the cap immediately and returns its result", async () => {
    const gate = createColdReadGate(2);
    const value = await gate.run(() => 42);
    assert.equal(value, 42);
  });

  it("releases the permit when a task rejects (a failing read can't wedge the gate)", async () => {
    const gate = createColdReadGate(1);

    const failed = gate
      .run(() => Promise.reject(new Error("boom")))
      .catch(() => "handled");
    const after = gate.run(() => Promise.resolve("ok"));

    assert.equal(await failed, "handled");
    assert.equal(await after, "ok");
    assert.equal(gate.active, 0);
  });

  it("propagates a task's rejection to its own caller", async () => {
    const gate = createColdReadGate(1);
    await assert.rejects(
      () => gate.run(() => Promise.reject(new Error("boom"))),
      BOOM
    );
  });

  it("clamps a non-positive max to 1", async () => {
    const gate = createColdReadGate(0);
    let active = 0;
    let maxActive = 0;
    const makeRead = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };
    await Promise.all([gate.run(makeRead()), gate.run(makeRead())]);
    assert.equal(maxActive, 1);
  });
});

describe("resolveColdReadConcurrency", () => {
  const prev = process.env.COLD_READ_MAX_CONCURRENCY;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.COLD_READ_MAX_CONCURRENCY;
    } else {
      process.env.COLD_READ_MAX_CONCURRENCY = prev;
    }
  });

  it("falls back to the conservative default when unset", () => {
    delete process.env.COLD_READ_MAX_CONCURRENCY;
    assert.equal(resolveColdReadConcurrency(), DEFAULT_COLD_READ_CONCURRENCY);
  });

  it("honors a valid positive override", () => {
    process.env.COLD_READ_MAX_CONCURRENCY = "5";
    assert.equal(resolveColdReadConcurrency(), 5);
  });

  it("ignores a non-positive or non-integer override", () => {
    process.env.COLD_READ_MAX_CONCURRENCY = "0";
    assert.equal(resolveColdReadConcurrency(), DEFAULT_COLD_READ_CONCURRENCY);
    process.env.COLD_READ_MAX_CONCURRENCY = "not-a-number";
    assert.equal(resolveColdReadConcurrency(), DEFAULT_COLD_READ_CONCURRENCY);
  });
});
