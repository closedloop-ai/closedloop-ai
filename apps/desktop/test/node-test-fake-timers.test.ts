/**
 * ISS-4934 — the two silent node:test/Vitest fake-timer differences, pinned.
 *
 * Every assertion here is written so that the NAIVE translation
 * (`vi.useFakeTimers({ toFake: apis })`, i.e. dropping the epoch-0 origin and
 * the implicit clear functions) fails it. That is the whole point: a
 * fake-timer conversion that quietly stops advancing, or quietly stops
 * cancelling, turns 26 suites into tests that cannot fail, and nothing else in
 * the tree would notice.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { vi } from "vitest";
import {
  nodeTestTimers,
  nodeTestTimersToFake,
} from "./support/node-test-fake-timers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("nodeTestTimers", () => {
  test("starts the clock at epoch 0, as node:test does and Vitest does not", () => {
    nodeTestTimers.enable(["Date"]);
    assert.equal(
      Date.now(),
      0,
      "node:test's mock.timers starts a faked Date at 0; Vitest's default is the real wall clock, so a TTL or freshness assertion would silently change what it measures"
    );
  });

  test("honours an explicit now, so a suite can still pin its own origin", () => {
    nodeTestTimers.enable(["Date"], { now: 1_700_000_000_000 });
    assert.equal(Date.now(), 1_700_000_000_000);
  });

  test("fakes clearTimeout alongside setTimeout, so cancellation still cancels", () => {
    nodeTestTimers.enable(["setTimeout"]);
    let fired = false;
    const handle = setTimeout(() => {
      fired = true;
    }, 10);
    clearTimeout(handle);
    nodeTestTimers.tick(50);
    assert.equal(
      fired,
      false,
      "a REAL clearTimeout handed a fake handle is a no-op, so the callback fires anyway and a 'cleanup cancels the timer' test passes its setup and proves nothing"
    );
  });

  test("fakes clearInterval alongside setInterval", () => {
    nodeTestTimers.enable(["setInterval"]);
    let ticks = 0;
    const handle = setInterval(() => {
      ticks += 1;
    }, 10);
    nodeTestTimers.tick(25);
    clearInterval(handle);
    nodeTestTimers.tick(100);
    assert.equal(ticks, 2, "the interval must stop at clearInterval");
  });

  test("advances a faked Date in step with the timers", () => {
    nodeTestTimers.enable(["Date", "setInterval"]);
    let ticks = 0;
    setInterval(() => {
      ticks += 1;
    }, 10);
    nodeTestTimers.tick(35);
    assert.equal(ticks, 3);
    assert.equal(Date.now(), 35);
  });

  test("hands the real clock back on reset", () => {
    // Asserted through `vi.isFakeTimers()` rather than by bounding `Date.now()`
    // against a constant: that would be a real-clock value reaching a bounded
    // assertion, which `no-timing-assertions` rejects and which would in any
    // case only prove the clock is not at epoch 0, not that it is real.
    nodeTestTimers.enable(["Date"]);
    assert.equal(vi.isFakeTimers(), true, "enable() must install a fake clock");
    nodeTestTimers.reset();
    assert.equal(
      vi.isFakeTimers(),
      false,
      "mock.timers.reset() maps to vi.useRealTimers(); a leaked fake clock would strand every later test in this file at epoch 0"
    );
  });
});

describe("nodeTestTimersToFake", () => {
  test("adds each api's clear function and nothing else", () => {
    assert.deepEqual(nodeTestTimersToFake(["setTimeout"]), [
      "setTimeout",
      "clearTimeout",
    ]);
    assert.deepEqual(nodeTestTimersToFake(["setImmediate"]), [
      "setImmediate",
      "clearImmediate",
    ]);
    // Date has no clear function, and must not pull in unrelated timers —
    // faking `setTimeout` in a Date-only suite would freeze awaits that the
    // node:test original ran against the real event loop.
    assert.deepEqual(nodeTestTimersToFake(["Date"]), ["Date"]);
  });

  test("de-duplicates rather than repeating an entry", () => {
    assert.deepEqual(nodeTestTimersToFake(["setTimeout", "setTimeout"]), [
      "setTimeout",
      "clearTimeout",
    ]);
  });
});
