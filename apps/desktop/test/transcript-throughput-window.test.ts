/**
 * @file transcript-throughput-window.test.ts
 * @description ISS-8507 — the sample store, and the two things that make its
 * rate trustworthy: what it refuses to accept, and what the trim leaves behind.
 *
 * The fixture that keeps reappearing here is `1 byte / 1996 ms` beside four
 * `1000 bytes / 1 ms`. It clears a two-second floor when the floor is measured
 * over the ACCEPTED set, and then the trim removes the long sample and leaves
 * about three milliseconds of evidence. Every accessor reporting the retained
 * set is what makes that case visible instead of green.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  createThroughputWindow,
  MAX_THROUGHPUT_SAMPLES,
  MIN_SAMPLES_FOR_ESTIMATE,
  type ThroughputSample,
} from "../src/main/transcript-sync/transcript-throughput-window.js";
import { declaredFunctionNames } from "./helpers/entrypoint-wiring.js";
import { parseTypeScriptFile } from "./helpers/ts-ast.js";

const WINDOW_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main",
  "transcript-sync",
  "transcript-throughput-window.ts"
);

/** `n` samples at a fixed rate, so a case can state its own arithmetic. */
function evenSamples(count: number, bytes: number, durationMs: number) {
  return Array.from({ length: count }, () => ({ bytes, durationMs }));
}

function addAll(
  window: ReturnType<typeof createThroughputWindow>,
  samples: readonly ThroughputSample[]
): void {
  for (const sample of samples) {
    window.add(sample);
  }
}

test("a sample whose bytes cannot be a byte count is rejected and counted", () => {
  const window = createThroughputWindow();
  const impossible = [
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
  ];
  for (const bytes of impossible) {
    assert.equal(
      window.add({ bytes, durationMs: 10 }),
      false,
      `bytes ${bytes} must be refused`
    );
  }
  assert.equal(window.rejectedSampleCount(), impossible.length);
  assert.equal(window.retainedSampleCount(), 0);
  assert.equal(window.retainedObservedBytes(), 0);
});

test("a duration that is not a positive finite span is rejected, including a backward clock", () => {
  const window = createThroughputWindow();
  // -5 is what a monotonic source running BACKWARD produces: a perfectly finite
  // number that sails through the clock helper, so this predicate is the only
  // thing between it and a negative interval.
  const impossible = [
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const durationMs of impossible) {
    assert.equal(
      window.add({ bytes: 100, durationMs }),
      false,
      `duration ${durationMs} must be refused`
    );
  }
  assert.equal(window.rejectedSampleCount(), impossible.length);
  assert.equal(window.retainedSampleCount(), 0);
});

test("a subnormal duration is accepted but cannot produce a rate", () => {
  const window = createThroughputWindow();
  // Finite and positive, so the per-sample predicate lets it through on purpose.
  // The refusal happens where it can be seen: the derived rate is not finite.
  addAll(window, evenSamples(7, 1000, Number.MIN_VALUE));
  assert.equal(window.retainedSampleCount(), 5);
  assert.equal(window.rateBytesPerMs(), null);
});

test("a duration sum that overflows to infinity yields no rate rather than a zero one", () => {
  const window = createThroughputWindow();
  addAll(window, evenSamples(7, 1000, Number.MAX_VALUE));
  assert.equal(window.rejectedSampleCount(), 0);
  assert.equal(window.retainedSampleCount(), 5);
  // Five MAX_VALUE durations sum to Infinity. A rate of 0 here would extrapolate
  // to an infinite remaining time, so the sum check refuses instead.
  assert.equal(window.rateBytesPerMs(), null);
});

test("a byte sum past the exact-integer range yields no rate", () => {
  const window = createThroughputWindow();
  addAll(window, evenSamples(7, Number.MAX_SAFE_INTEGER, 1));
  assert.equal(window.rejectedSampleCount(), 0);
  assert.equal(window.rateBytesPerMs(), null);
});

test("the window keeps at most MAX_THROUGHPUT_SAMPLES and evicts the oldest", () => {
  const window = createThroughputWindow();
  for (let bytes = 1; bytes <= 20; bytes += 1) {
    window.add({ bytes, durationMs: 1 });
  }
  // 20 added, 16 kept: bytes 5..20 survive. The trim then drops 5 and 20,
  // leaving 6..19 — a sum of 175. Had the NEWEST been evicted instead, the
  // retained set would be 2..15 and this number would be 119.
  assert.equal(window.retainedSampleCount(), MAX_THROUGHPUT_SAMPLES - 2);
  assert.equal(window.retainedObservedBytes(), 175);
  assert.equal(window.isFull(), true);
});

test("no rate is stated below the retained floor, and none on an empty window", () => {
  const empty = createThroughputWindow();
  assert.equal(empty.rateBytesPerMs(), null);
  assert.equal(empty.isFull(), false);

  // Five accepted leaves three retained, which is under the floor of five —
  // the arithmetic that makes SEVEN accepted the real threshold.
  const five = createThroughputWindow();
  addAll(five, evenSamples(5, 100, 10));
  assert.equal(five.retainedSampleCount(), 3);
  assert.equal(five.rateBytesPerMs(), null);
});

test("the trim drops exactly the fastest and the slowest sample by rate", () => {
  const window = createThroughputWindow();
  // Rates 1..7 at a fixed duration. Dropping rate 1 and rate 7 leaves
  // 200+300+400+500+600 = 2000 bytes over 500 ms.
  for (let multiple = 1; multiple <= 7; multiple += 1) {
    window.add({ bytes: multiple * 100, durationMs: 100 });
  }
  assert.equal(window.retainedSampleCount(), MIN_SAMPLES_FOR_ESTIMATE);
  assert.equal(window.retainedObservedBytes(), 2000);
  assert.equal(window.retainedSpanMs(), 500);
  assert.equal(window.rateBytesPerMs(), 4);
});

test("one fast outlier moves the trimmed rate under 5% where the untrimmed aggregate moves over 50%", () => {
  const baseline = createThroughputWindow();
  addAll(baseline, evenSamples(7, 1000, 100));
  const baseRate = baseline.rateBytesPerMs();
  assert.equal(baseRate, 10);

  const withOutlier = createThroughputWindow();
  addAll(withOutlier, evenSamples(6, 1000, 100));
  withOutlier.add({ bytes: 100_000, durationMs: 100 });
  const trimmedRate = withOutlier.rateBytesPerMs();
  assert.notEqual(trimmedRate, null);

  // The untrimmed aggregate over the same seven samples, computed here because
  // the window deliberately does not expose one: 106000 bytes over 700 ms.
  const untrimmedRate = (6 * 1000 + 100_000) / 700;
  assert.ok(
    Math.abs(untrimmedRate - 10) / 10 > 0.5,
    `untrimmed rate ${untrimmedRate} should be more than 50% off the baseline`
  );
  assert.ok(
    Math.abs((trimmedRate ?? 0) - 10) / 10 < 0.05,
    `trimmed rate ${trimmedRate} should be within 5% of the baseline`
  );
});

test("the rate is duration-weighted, so a 1 ms interval cannot outvote a 3 s one", () => {
  const window = createThroughputWindow();
  addAll(window, evenSamples(4, 1, 1));
  addAll(window, evenSamples(3, 6000, 3000));
  // Retained after the trim: three of the 1 B / 1 ms samples and two of the
  // 6000 B / 3000 ms ones. Aggregate: 12003 bytes over 6003 ms.
  assert.equal(window.retainedObservedBytes(), 12_003);
  assert.equal(window.retainedSpanMs(), 6003);
  assert.equal(window.rateBytesPerMs(), 12_003 / 6003);
  // A mean of per-sample rates over the same retained set would be 1.4, giving
  // the four one-millisecond samples the same say as the three-second ones.
  assert.notEqual(window.rateBytesPerMs(), 1.4);
});

test("the retained accessors report the trimmed set, not everything accepted", () => {
  const window = createThroughputWindow();
  window.add({ bytes: 1, durationMs: 1996 });
  addAll(window, evenSamples(4, 1000, 1));
  // Accepted span is 2000 ms; the trim removes the long sample, so the evidence
  // actually behind a rate is 3 ms. A floor read from the accepted set would
  // pass here and the published number would rest on those 3 ms.
  assert.equal(window.retainedSampleCount(), 3);
  assert.equal(window.retainedSpanMs(), 3);
  assert.equal(window.retainedObservedBytes(), 3000);
  assert.equal(window.rateBytesPerMs(), null);
});

test("rejected samples contribute to neither the span nor the byte total", () => {
  const window = createThroughputWindow();
  addAll(window, evenSamples(7, 100, 10));
  window.add({ bytes: -1, durationMs: 10 });
  window.add({ bytes: 100, durationMs: 0 });
  assert.equal(window.rejectedSampleCount(), 2);
  assert.equal(window.retainedSampleCount(), 5);
  assert.equal(window.retainedObservedBytes(), 500);
  assert.equal(window.retainedSpanMs(), 50);
});

test("the module declares no local copy of a canonical math helper", () => {
  // `clamp`, `clamp01`, `median` and `round` are canonical @repo/api exports and
  // `isMeasurableByteSize` is this directory's own byte predicate. Re-DECLARING
  // any of them here is the SSOT-drift-by-copy regression this pins — and only
  // that: `declaredFunctionNames` sees function declarations, so this says
  // nothing about whether the canonical one is used. The reuse itself is
  // exercised by the byte-rejection case at the top of this file, which drives
  // the real predicate.
  const source = parseTypeScriptFile(WINDOW_SOURCE);
  const declared = declaredFunctionNames(source);
  for (const forbidden of ["clamp", "clamp01", "median", "round"]) {
    assert.ok(
      !declared.includes(forbidden),
      `${forbidden} must be imported from its canonical owner, never re-declared`
    );
  }
  assert.ok(!declared.includes("isMeasurableByteSize"));
});

test("the retained count never falls while accepted samples accumulate", () => {
  // Regression: the trim runs only once the floor is reached, so reporting the
  // ACCEPTED set below it made this count climb 1,2,3,4 and then drop to 3 on
  // the fifth accepted sample — a consumer watching the evidence behind its
  // estimate saw it shrink at the moment it grew. Nothing is retained until the
  // trim can leave a quorum.
  const window = createThroughputWindow();
  const counts: number[] = [];
  for (let index = 0; index < MAX_THROUGHPUT_SAMPLES + 4; index += 1) {
    window.add({ bytes: 100, durationMs: 10 });
    counts.push(window.retainedSampleCount());
  }
  for (let index = 1; index < counts.length; index += 1) {
    assert.ok(
      counts[index] >= counts[index - 1],
      `count fell from ${counts[index - 1]} to ${counts[index]} on sample ${index + 1}`
    );
  }
  // The first four accepted retain nothing at all, rather than themselves.
  assert.deepEqual(counts.slice(0, MIN_SAMPLES_FOR_ESTIMATE - 1), [0, 0, 0, 0]);
  assert.equal(counts[MIN_SAMPLES_FOR_ESTIMATE - 1], 3);
});
