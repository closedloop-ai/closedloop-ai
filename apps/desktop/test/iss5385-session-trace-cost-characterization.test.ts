import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput,
  traceTimelineRow,
  traceTokenEvent,
} from "./session-trace-test-utils.js";

/**
 * ISS-5385 / PLN-1771 S0 — CHARACTERIZATION of site #5, the per-component cost
 * fold inside `buildTraceActivityFields` that feeds the session-detail activity
 * strip.
 *
 * Site #5 is the only one of the nine that reads cost as FOUR separate stored
 * columns rather than one, and its stored-vs-derive gate is all-four-or-nothing.
 * That combination produces the defect PLN-1771 S0 requires pinning explicitly:
 * a row carrying SOME stored components silently contributes $0 for the rest.
 *
 * As with the sibling suites, nothing here asserts a behaviour is correct.
 * Accuracy is a separate round (ISS-7361 / ISS-4794); this round is about cost
 * being deterministic, consistent and understandable.
 */

const START = "2026-06-07T12:00:00.000Z";
const EVENT_AT = "2026-06-07T12:10:00.000Z";
const END = "2026-06-07T12:20:00.000Z";

type TraceTokenEvent = ReturnType<typeof traceTokenEvent>;

function tokenEvent(overrides: Partial<TraceTokenEvent> = {}): TraceTokenEvent {
  return {
    ...traceTokenEvent(EVENT_AT),
    input_tokens: 100_000,
    output_tokens: 50_000,
    cache_read_tokens: 10_000,
    cache_write_tokens: 10_000,
    ...overrides,
  };
}

/** Sum every bucket, the way the strip's own total does. */
function foldCost(event: TraceTokenEvent): {
  input: number;
  output: number;
  cache: number;
} {
  const fields = buildSessionTraceSyncFields(
    baseSessionTraceInput({
      startedAt: START,
      endedAt: END,
      updatedAt: END,
      timelineRows: [traceTimelineRow(START), traceTimelineRow(END)],
      tokenEvents: [event],
    })
  );
  const buckets = fields.activityBuckets ?? [];
  if (buckets.length === 0) {
    // A fixture problem, not a failed expectation — every test below reads a
    // per-component total off these buckets and would silently read 0.
    throw new Error("the fixture produced no activity buckets");
  }
  return {
    input: buckets.reduce((sum, bucket) => sum + bucket.cIn, 0),
    output: buckets.reduce((sum, bucket) => sum + bucket.cOut, 0),
    cache: buckets.reduce((sum, bucket) => sum + bucket.cCache, 0),
  };
}

describe("ISS-5385 site #5: the all-four-null stored-cost gate", () => {
  test("a row with NO stored costs derives all four components", () => {
    // The negative control for every test below. `traceTokenEvent`'s model is
    // "opus" — non-empty, so the FEA-3546 fallback always prices it.
    const derived = foldCost(tokenEvent());

    assert.ok(derived.input > 0);
    assert.ok(derived.output > 0);
    assert.ok(derived.cache > 0);
  });

  test("a row with ALL FOUR stored costs uses them and derives nothing", () => {
    // The other clean case. `cCache` is the sum of the two stored cache columns.
    const stored = foldCost(
      tokenEvent({
        input_cost_usd_estimated: 1,
        output_cost_usd_estimated: 2,
        cache_read_cost_usd_estimated: 4,
        cache_creation_cost_usd_estimated: 8,
      })
    );

    assert.equal(stored.input, 1);
    assert.equal(stored.output, 2);
    assert.equal(stored.cache, 12);
  });

  test("ONE stored component silently zeroes the other three", () => {
    // PLN-1771 S0's named defect. The derive gate is
    //   storedInput == null && storedOutput == null && storedCacheRead == null
    //     && storedCacheCreation == null
    // so a single non-null column makes `fallbackCost` undefined, and every
    // remaining component falls to its `?? 0` tail. The row's real output and
    // cache spend is not merely unknown — it is reported as zero.
    const partial = foldCost(tokenEvent({ input_cost_usd_estimated: 1 }));

    assert.equal(partial.input, 1);
    assert.equal(partial.output, 0, "output is FABRICATED as $0, not derived");
    assert.equal(partial.cache, 0, "cache is FABRICATED as $0, not derived");
  });

  test("adding a stored input cost makes the SAME row report less total spend", () => {
    // The consequence, stated as the property that makes it a defect rather
    // than a policy: strictly MORE information about a row lowers its reported
    // cost. Nothing anywhere signals that the drop is a gate, not a measurement.
    const unpriced = foldCost(tokenEvent());
    const partial = foldCost(tokenEvent({ input_cost_usd_estimated: 1 }));

    const unpricedTotal = unpriced.input + unpriced.output + unpriced.cache;
    const partialTotal = partial.input + partial.output + partial.cache;

    assert.ok(
      partialTotal < unpricedTotal,
      "adding a stored component must not be able to lower the total — but it does"
    );
  });

  test("the four-term cache sum never actually mixes stored with derived", () => {
    // `cCache` reads as a blend:
    //   (storedRead ?? 0) + (storedCreation ?? 0)
    //     + (fallback?.cacheRead ?? 0) + (fallback?.cacheWrite ?? 0)
    // but the all-four-null gate makes the halves mutually exclusive — whenever
    // either stored term is present, `fallback` is undefined, and vice versa.
    // Pinned because the expression invites a future edit that loosens the gate
    // to a per-column one, which would silently start DOUBLE-COUNTING cache.
    const storedCacheOnly = foldCost(
      tokenEvent({ cache_read_cost_usd_estimated: 4 })
    );

    assert.equal(
      storedCacheOnly.cache,
      4,
      "no derived cache is added on top of the stored term"
    );
    assert.equal(storedCacheOnly.input, 0);
    assert.equal(storedCacheOnly.output, 0);
  });

  test("a stored 0 is a value here too, and it arms the gate", () => {
    // `nullableNumber` distinguishes 0 from null, so a legitimately-zero input
    // cost — a cached-only request, say — reads as "stored" and suppresses
    // derivation for the other three. This is the narrowest input that
    // reproduces the defect: a single honest 0.
    const zeroArmed = foldCost(tokenEvent({ input_cost_usd_estimated: 0 }));

    assert.equal(zeroArmed.input, 0);
    assert.equal(zeroArmed.output, 0);
    assert.equal(zeroArmed.cache, 0);
  });

  test("absence is spelled `$0` here — the fourth spelling across the nine sites", () => {
    // ISS-5385 property 3, completed. Site #1 answers `undefined`, sites #3/#4
    // answer `null`, and site #5 answers a confident 0 that is indistinguishable
    // from a row that genuinely cost nothing. Only the last of the four can
    // mislead a reader, because only the last is a number.
    const partial = foldCost(tokenEvent({ input_cost_usd_estimated: 1 }));
    const genuinelyFree = foldCost(
      tokenEvent({
        input_cost_usd_estimated: 1,
        output_cost_usd_estimated: 0,
        cache_read_cost_usd_estimated: 0,
        cache_creation_cost_usd_estimated: 0,
      })
    );

    assert.deepEqual(
      partial,
      genuinelyFree,
      "an unpriced row and a free row are byte-identical downstream"
    );
  });
});
