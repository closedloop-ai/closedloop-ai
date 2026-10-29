/**
 * ISS-12552 (PRD-800 "Rollout"): a flip is a
 * full corpus re-derive, so a changed verdict acts only after it holds, and a
 * flip never re-lists a maintenance pass midway: it queues at most one more
 * pass behind the one in flight.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { createParsePolicyMaintenanceRerun } from "../src/main/dashboard/parse-policy-maintenance-rerun.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
} from "../src/main/parse-policy/parse-policy.js";
import {
  createParsePolicyController,
  notifyParsePolicyFlip,
  PARSE_POLICY_FLIP_HOLD_MS,
  subscribeParsePolicyFlips,
} from "../src/main/parse-policy/parse-policy-resolver.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  setEffectiveParsePolicy(PARSE_POLICY_BASE);
});

/**
 * The controller over a verdict the test sets, with a hold clock the test
 * advances, flipping into the real hub, and the real rerun listener over a
 * maintenance runtime whose passes the test settles.
 */
function rig() {
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  let now = 0;
  let verdict: boolean | undefined;
  let notify: (() => void) | null = null;
  const persists: boolean[] = [];
  let persisted: string | null = null;
  let pass: { promise: Promise<void>; settle: () => void } | null = null;
  let reruns = 0;
  const startPass = (): void => {
    let settle = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    }).then(() => {
      pass = null;
    });
    pass = { promise, settle };
  };
  cleanups.push(
    subscribeParsePolicyFlips(
      createParsePolicyMaintenanceRerun({
        isScheduled: () => true,
        currentPass: () => pass?.promise ?? null,
        isClosed: () => false,
        rerun: () => {
          reruns += 1;
          startPass();
        },
      })
    )
  );
  const controller = createParsePolicyController({
    readPersisted: () => persisted,
    persist: (onFor) => {
      persisted = onFor;
      persists.push(onFor !== null);
    },
    readOrganization: () => "org-1",
    readVerdict: () => verdict,
    subscribe: (listener) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    onFlip: notifyParsePolicyFlip,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  controller.start();
  cleanups.push(() => controller.dispose());
  return {
    persists,
    reruns: () => reruns,
    answer(next: boolean | undefined) {
      verdict = next;
      notify?.();
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.run();
        } else if (timer.live) {
          timers.push(timer);
        }
      }
    },
    startBootPass: startPass,
    async settlePass() {
      const current = pass;
      if (!current) {
        throw new Error("no pass is in flight");
      }
      current.settle();
      await current.promise;
      await Promise.resolve();
    },
  };
}

describe("a parse-policy flip holds, then reruns maintenance behind the pass in flight", () => {
  test("a ring edit that bounces back within the hold causes no rebuild", () => {
    const r = rig();
    r.answer(true);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS - 1);
    r.answer(false);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(r.persists, []);
    assert.equal(r.reruns(), 0);
  });

  test("a verdict that holds flips once, when the hold ends", () => {
    const r = rig();
    r.answer(true);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS - 1);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    r.answer(true);
    r.advance(1);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.deepEqual(r.persists, [true]);
    assert.equal(r.reruns(), 1);
  });

  test("two flips cause at most two rebuilds, and the second waits for the first pass", async () => {
    const r = rig();
    r.answer(true);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    assert.equal(r.reruns(), 1);

    r.answer(false);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.equal(r.reruns(), 1, "no pass is re-listed while one runs");

    await r.settlePass();
    assert.equal(r.reruns(), 2);
    await r.settlePass();
    assert.equal(r.reruns(), 2);
  });

  test("flips during the boot pass queue exactly one more pass after it", async () => {
    const r = rig();
    r.startBootPass();
    r.answer(true);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    r.answer(false);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    r.answer(true);
    r.advance(PARSE_POLICY_FLIP_HOLD_MS);
    assert.deepEqual(r.persists, [true, false, true]);
    assert.equal(r.reruns(), 0);

    await r.settlePass();
    assert.equal(r.reruns(), 1);
    await r.settlePass();
    assert.equal(r.reruns(), 1);
  });
});
