/**
 * ISS-4933 — the `node:test` → Vitest lifecycle mapping, asserted through the
 * production path.
 *
 * This file imports `node:test` exactly as the other 776 main-process suites
 * do, so under `vitest.node.config.ts` it drives the shim through the same
 * alias they do rather than importing it directly — which is what makes it a
 * test of the production path and not of a module in isolation. It runs on the
 * Vitest lane only; nothing here claims to also execute under `tsx --test`, and
 * the cross-runner equivalence is not asserted by a test but was established
 * empirically for ISS-4933 (per-file test-count parity across 772 shared files,
 * plus a counterfactual showing both runners fail the same case when the
 * production code under it is broken).
 *
 * What IS asserted here is every mapping that could change semantics without
 * failing: `before` landing on `beforeEach`, a `{ skip: true }` body still
 * executing, an option object swallowing the callback, `after` firing per test
 * instead of per suite — plus the two options the shim refuses outright.
 *
 * `mock` and the `TestContext` parameter are deliberately absent: the shim does
 * not implement them, `scripts/node-test-census.mjs` routes files that use them
 * to the legacy lane, and ISS-4934 converts them.
 */
import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";

/** Hoisted per Ultracite's `useTopLevelRegex` rule. */
const UNFAITHFUL_OPTION_MESSAGE = /no faithful Vitest equivalent/;

let beforeRuns = 0;
let beforeEachRuns = 0;
let afterEachRuns = 0;
let nestedAfterRuns = 0;
const executedBodies: string[] = [];

before(() => {
  beforeRuns++;
});

beforeEach(() => {
  beforeEachRuns++;
});

afterEach(() => {
  afterEachRuns++;
});

describe("node:test lifecycle under the active runner", () => {
  test("runs a plain test and its per-test hook", () => {
    executedBodies.push("plain");
    assert.equal(beforeRuns, 1, "`before` must run exactly once, before tests");
    assert.equal(beforeEachRuns, 1);
    assert.equal(afterEachRuns, 0, "`afterEach` has not run for this test yet");
  });

  test("accepts an options object between the name and the body", {
    timeout: 30_000,
  }, () => {
    executedBodies.push("with-options");
    // THE mapping assertion. `before` is a suite-level hook in node:test; if it
    // were wired to Vitest's `beforeEach` this would read 2.
    assert.equal(beforeRuns, 1);
    assert.equal(beforeEachRuns, 2);
    assert.equal(afterEachRuns, 1);
  });

  test("does not execute a body behind `{ skip: true }`", {
    skip: true,
  }, () => {
    executedBodies.push("options-skip");
  });

  // biome-ignore lint/suspicious/noSkippedTests: a skipped test IS the fixture — this file exists to prove `.skip` reaches the runner's skip path rather than executing the body, and the assertion that it did is two cases below.
  test.skip("does not execute a body behind `.skip`", () => {
    executedBodies.push("property-skip");
  });

  test("saw neither skipped body execute", () => {
    executedBodies.push("last");
    assert.deepEqual(executedBodies, ["plain", "with-options", "last"]);
    assert.equal(
      beforeEachRuns,
      3,
      "`beforeEach` must run once per EXECUTED test — skipped tests do not count"
    );
  });
});

describe("suite-scoped `after`", () => {
  after(() => {
    nestedAfterRuns++;
  });

  // TWO tests, deliberately. With one, `after` mapped to `afterEach` would also
  // leave the counter at 1 below and the mapping this suite exists to pin would
  // be unpinned — the mirror of the `before` assertion above.
  test("is a no-op until its suite ends", () => {
    assert.equal(nestedAfterRuns, 0);
  });

  test("is still a no-op after a second test in the same suite", () => {
    assert.equal(nestedAfterRuns, 0);
  });
});

test("the nested suite's `after` ran ONCE, when that suite ended", () => {
  // Asserted from OUTSIDE the suite on purpose: an `after` that never fires
  // cannot fail an assertion placed inside itself, so proving the hook runs at
  // all needs an observer that outlives it. `1`, not `>= 1`: two tests ran in
  // that suite, so an `afterEach` mapping reads 2 here.
  assert.equal(nestedAfterRuns, 1);
});

describe("options with no faithful Vitest equivalent", () => {
  // node:test RUNS a `{ todo: true }` body and merely tolerates its failure,
  // and without `--test-only` it ignores `only` entirely. Vitest does neither.
  // The shim refuses both rather than silently changing what a test does — this
  // is the one place its "the bodies are identical, so nothing can weaken"
  // argument would not hold, so it declines instead.
  for (const option of ["todo", "only"] as const) {
    test(`rejects \`{ ${option}: true }\` instead of mapping it`, () => {
      assert.throws(
        () => {
          test(`unreachable ${option}`, { [option]: true }, () => {
            throw new Error("this body must never run");
          });
        },
        UNFAITHFUL_OPTION_MESSAGE,
        `\`{ ${option}: true }\` must be refused, not quietly reinterpreted`
      );
    });
  }
});
