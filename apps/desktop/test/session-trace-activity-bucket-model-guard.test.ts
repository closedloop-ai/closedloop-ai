import assert from "node:assert/strict";
import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { afterEach, test } from "vitest";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import { baseSessionTraceInput as baseInput } from "./session-trace-test-utils.js";

/**
 * ISS-8234 — a transcript-named model must not reach `Object.prototype`.
 *
 * `message.model` is copied verbatim from the JSONL into `token_events.model`
 * and read back out with no allow-list anywhere on the path, so `"__proto__"`
 * and `"constructor"` arrive at the per-model cost fold as ordinary keys. On the
 * plain `{}` this fold used to accumulate into, both read back as an INHERITED
 * member — truthy, so the `??` first-write check took them for an already-open
 * entry and the running `+=` landed on `Object.prototype` (or on `Object`)
 * instead. Two harms, and each needs its own assertion below: the process-wide
 * pollution, and the model's dollars silently vanishing from `byModel` while
 * staying in the bucket total.
 */

const POISON_KEYS = ["cIn", "cOut", "cCache"] as const;

/** Bracket access via a constant: a literal `.__proto__` is the deprecated accessor. */
const PROTO_KEY = "__proto__";
const CTOR_KEY = "constructor";

/**
 * Unconditional, and deliberately not the last line of each case: a case that
 * fails mid-way would otherwise leak a polluted `Object.prototype` into every
 * later test sharing this worker, turning one real failure into a file of
 * unrelated red.
 */
afterEach(() => {
  for (const key of POISON_KEYS) {
    Reflect.deleteProperty(Object.prototype, key);
    Reflect.deleteProperty(Object, key);
  }
});

test("a __proto__ model name keeps its own cost entry and never reaches Object.prototype", () => {
  const buckets = bucketsForModel(PROTO_KEY);
  const byModel = mergedByModel(buckets);

  assert.equal(Object.hasOwn(byModel, PROTO_KEY), true);
  assert.deepEqual(byModel[PROTO_KEY], {
    cIn: 1.5,
    cOut: 2.5,
    cCache: 0.25,
  });
  // The assertion that kills the mutation. The one above passes on a fix that
  // only null-prototypes the EMIT, which would leave the pollution untouched.
  // Reflect.get, not `Object.prototype.cIn`: the compiler is right that no such
  // property should exist, and reading it reflectively is the whole assertion.
  assert.equal(Reflect.get(Object.prototype, "cIn"), undefined);
  assert.equal(Object.hasOwn(Object.prototype, "cIn"), false);
});

test("a constructor model name keeps its own cost entry and never reaches Object", () => {
  const buckets = bucketsForModel(CTOR_KEY);
  const byModel = mergedByModel(buckets);

  assert.equal(Object.hasOwn(byModel, CTOR_KEY), true);
  assert.deepEqual(byModel[CTOR_KEY], {
    cIn: 1.5,
    cOut: 2.5,
    cCache: 0.25,
  });
  assert.equal(Reflect.get(Object, "cIn"), undefined);
  assert.equal(Object.hasOwn(Object, "cIn"), false);
});

test("the per-model breakdown reconciles with the bucket total for every model name", () => {
  // The invariant the bug actually broke, and the one that stays meaningful if
  // the fix shape changes: a cost surface whose parts do not sum to the total it
  // belongs to is lying, whatever the mechanism.
  for (const model of ["claude-opus-5", PROTO_KEY, CTOR_KEY]) {
    const buckets = bucketsForModel(model);
    const totals = sumBuckets(buckets);
    const breakdown = sumBreakdown(buckets);

    assert.deepEqual(
      breakdown,
      totals,
      `byModel must reconcile with the bucket totals for model ${model}`
    );
    assert.deepEqual(totals, { cIn: 1.5, cOut: 2.5, cCache: 0.25 });
  }
});

test("an ordinary model name still produces the emitted shape it always did", () => {
  const buckets = bucketsForModel("claude-opus-5");
  const byModel = mergedByModel(buckets);

  assert.deepEqual(byModel, {
    "claude-opus-5": { cIn: 1.5, cOut: 2.5, cCache: 0.25 },
  });
  // Emitted buckets stay normally-prototyped: the null-prototype map is the
  // in-flight accumulator only, and `roundActivityBucket` rebuilds at the wire.
  assert.equal(Object.getPrototypeOf(byModel), Object.prototype);
});

/** Two events on one model, so the fold's create AND update paths both run. */
function bucketsForModel(model: string): ActivityBucket[] {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      tokenEvents: [
        pricedTokenEvent(model, "2026-06-07T12:00:00.000Z"),
        pricedTokenEvent(model, "2026-06-07T12:10:00.000Z"),
      ],
    })
  );
  return fields.activityBuckets ?? [];
}

/**
 * Costs are STORED on the row, so `buildTraceActivityFields` takes its
 * `storedInputCost` branch and never reprices. That keeps every number here a
 * fact about the fold rather than about the pricing table, which has no entry
 * for a model called `__proto__` and would otherwise report a pricing miss.
 */
function pricedTokenEvent(model: string, createdAt: string) {
  return {
    model,
    created_at: createdAt,
    input_tokens: 10,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd_estimated: null,
    input_cost_usd_estimated: 0.75,
    output_cost_usd_estimated: 1.25,
    cache_read_cost_usd_estimated: 0.125,
    cache_creation_cost_usd_estimated: 0,
  };
}

/** The emitted per-model costs, merged across whatever bins they landed in. */
function mergedByModel(buckets: ActivityBucket[]): ActivityBucket["byModel"] {
  const merged: ActivityBucket["byModel"] = {};
  for (const bucket of buckets) {
    for (const model of Object.keys(bucket.byModel)) {
      const costs = bucket.byModel[model];
      const running = Object.hasOwn(merged, model)
        ? merged[model]
        : { cIn: 0, cOut: 0, cCache: 0 };
      Object.defineProperty(merged, model, {
        configurable: true,
        enumerable: true,
        value: {
          cIn: running.cIn + costs.cIn,
          cOut: running.cOut + costs.cOut,
          cCache: running.cCache + costs.cCache,
        },
        writable: true,
      });
    }
  }
  return merged;
}

function sumBuckets(buckets: ActivityBucket[]) {
  return {
    cIn: round(buckets.reduce((sum, b) => sum + b.cIn, 0)),
    cOut: round(buckets.reduce((sum, b) => sum + b.cOut, 0)),
    cCache: round(buckets.reduce((sum, b) => sum + b.cCache, 0)),
  };
}

function sumBreakdown(buckets: ActivityBucket[]) {
  const entries = buckets.flatMap((bucket) =>
    Object.keys(bucket.byModel).map((model) => bucket.byModel[model])
  );
  return {
    cIn: round(entries.reduce((sum, e) => sum + e.cIn, 0)),
    cOut: round(entries.reduce((sum, e) => sum + e.cOut, 0)),
    cCache: round(entries.reduce((sum, e) => sum + e.cCache, 0)),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
