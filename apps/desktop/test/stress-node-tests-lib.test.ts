/**
 * ISS-5303 — `scripts/stress-node-tests-lib.mjs`.
 *
 * `stress-node-tests.mjs` cannot be imported or driven here: at module scope it
 * spawns the configured test file up to fifty times and `process.exit(1)`s on
 * the first failure. Its one pure decision — how many iterations to run, and
 * what per-iteration timeouts to hand `spawnSync` — is what this covers.
 *
 * The rejection branches are the point. A `0` iteration count makes the stress
 * tool run nothing and report success, and a `0` timeout makes `spawnSync` kill
 * every child instantly, so both would turn the nightly flake hunt green
 * without hunting anything.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { censusTestFiles } from "../scripts/node-test-census.mjs";
import {
  positiveIntEnv,
  StressLane,
  stressLane,
} from "../scripts/stress-node-tests-lib.mjs";
import {
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const FALLBACK = 50;

describe("ISS-5303: positiveIntEnv bounds the stress-run knobs", () => {
  test("takes a valid positive integer", () => {
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, {
        STRESS_ITERS: "7",
      }),
      7
    );
  });

  test("falls back when the variable is unset", () => {
    assert.equal(positiveIntEnv("STRESS_ITERS", FALLBACK, {}), FALLBACK);
  });

  test("falls back on zero", () => {
    // Zero iterations is the worst outcome available: the loop body never runs
    // and the script prints "0/0 iterations passed" and exits 0.
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "0" }),
      FALLBACK
    );
  });

  test("falls back on a negative value", () => {
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "-3" }),
      FALLBACK
    );
  });

  test("falls back on a non-numeric value", () => {
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "lots" }),
      FALLBACK
    );
  });

  test("falls back on an empty string", () => {
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "" }),
      FALLBACK
    );
  });

  test("truncates a float rather than rejecting it", () => {
    // `Number.parseInt` is lenient by design here, and the value it returns is
    // still a usable iteration count. Pinned because it is the surprising
    // half of the contract: "2.9" is NOT rejected, it becomes 2.
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "2.9" }),
      2
    );
  });

  test("falls back on a fraction below one, which truncates to zero", () => {
    assert.equal(
      positiveIntEnv("STRESS_ITERS", FALLBACK, { STRESS_ITERS: "0.9" }),
      FALLBACK
    );
  });

  test("reads the named variable, not some other one", () => {
    assert.equal(
      positiveIntEnv("STRESS_TIMEOUT_MS", FALLBACK, {
        STRESS_ITERS: "9",
        STRESS_TIMEOUT_MS: "240000",
      }),
      240_000
    );
  });
});

describe("ISS-4934: stressLane takes the lane from the census", () => {
  test("puts a Vitest-lane file on Vitest, not tsx --test", () => {
    // Driven by the REAL census, not a literal: the defect this replaced was
    // `tsx --test` hardcoded for every file, which runs a converted suite up to
    // its first `vi.*` call and then fails with "Vitest failed to access its
    // internal state" — a reproducible failure describing the runner rather
    // than the flake the stress tool exists to hunt.
    const census = censusTestFiles();
    assert.ok(census.vitest.length > 0, "census has no Vitest-lane files");

    assert.equal(stressLane(census.vitest[0], census), StressLane.Vitest);
  });

  test("keeps a legacy-lane file on node:test", () => {
    const census = censusTestFiles();
    assert.ok(census.nodeTest.length > 0, "census has no legacy-lane files");

    assert.equal(stressLane(census.nodeTest[0], census), StressLane.NodeTest);
  });

  test("a file the census does not cover keeps the legacy behaviour", () => {
    // `censusTestFiles` reads `test/*.test.ts` only, so an excluded suite or a
    // typo reaches here in neither list. Routing those to `tsx --test` is what
    // this tool has always done, including its loud error for a missing file.
    assert.equal(
      stressLane("test/prisma-baseline-equivalence.test.ts", { vitest: [] }),
      StressLane.NodeTest
    );
  });
});

describe("ISS-5303: stress-node-tests.mjs is wired to the lib", () => {
  test("imports the helper and does not redeclare it", () => {
    const entrypoint = parseDesktopScript("stress-node-tests.mjs");

    assert.deepEqual(
      namedImportsFrom(entrypoint, "./stress-node-tests-lib.mjs"),
      // ISS-4934 added the lane selector; the entrypoint must reach the census
      // through it rather than picking a runner itself.
      ["StressLane", "positiveIntEnv", "stressLane"]
    );
    assert.equal(
      declaredFunctionNames(entrypoint).includes("positiveIntEnv"),
      false
    );
  });

  test("still derives all three knobs through it", () => {
    // Iteration count, per-test timeout and per-iteration timeout. A call site
    // that drifted back to a bare `Number.parseInt` would lose the positive
    // bound this suite proves.
    const called = calledIdentifiers(
      parseDesktopScript("stress-node-tests.mjs")
    );

    assert.equal(called.filter((name) => name === "positiveIntEnv").length, 3);
  });

  test("ISS-4934: derives the runner through the lane selector", () => {
    // Without this the lib could route perfectly while the entrypoint kept its
    // own hardcoded `tsx --test` argv, and every assertion above would stay
    // green on a stress tool that still runs converted suites on the wrong
    // runner.
    const entrypoint = parseDesktopScript("stress-node-tests.mjs");

    assert.deepEqual(namedImportsFrom(entrypoint, "./node-test-census.mjs"), [
      "censusTestFiles",
    ]);
    assert.equal(
      calledIdentifiers(entrypoint).filter((name) => name === "stressLane")
        .length,
      1
    );
  });
});
