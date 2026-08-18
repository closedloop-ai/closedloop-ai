import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARNESS_RECONCILIATION_TOLERANCE,
  ReconciliationStatus,
  reconcileSessionCost,
} from "../src/main/cost/usage-reconciliation.js";
import { CORPUS_ORACLE_TOLERANCE } from "./golden/golden-cost-oracle-tolerance.js";

test("matched: derived equals authoritative", () => {
  const r = reconcileSessionCost({
    derivedCostUsd: 1.23,
    authoritativeCostUsd: 1.23,
  });
  assert.equal(r.status, ReconciliationStatus.Matched);
  assert.equal(r.deltaUsd, 0);
  assert.equal(r.relativeDelta, 0);
});

test("matched: within the $0.01 absolute floor on tiny totals", () => {
  const r = reconcileSessionCost({
    derivedCostUsd: 0.005,
    authoritativeCostUsd: 0.012,
  });
  // |delta| = 0.007 <= max(0.01, 2% of 0.012) = 0.01
  assert.equal(r.status, ReconciliationStatus.Matched);
});

test("matched: within the 2% relative tolerance on large totals", () => {
  const r = reconcileSessionCost({
    derivedCostUsd: 100,
    authoritativeCostUsd: 101,
  });
  // |delta| = 1 <= max(0.01, 2% of 101 = 2.02)
  assert.equal(r.status, ReconciliationStatus.Matched);
});

test("drifted: derived undercounts authoritative beyond tolerance", () => {
  // Mirrors the real web-search / fast-mode undercount: our derived number is
  // low because it omits Claude Code's extra cost terms.
  const r = reconcileSessionCost({
    derivedCostUsd: 1.0,
    authoritativeCostUsd: 1.5,
  });
  assert.equal(r.status, ReconciliationStatus.Drifted);
  assert.equal(r.deltaUsd, -0.5);
  assert.ok(r.relativeDelta && r.relativeDelta > 0.3);
});

test("drifted: authoritative present but derived unpriced", () => {
  const r = reconcileSessionCost({
    derivedCostUsd: null,
    authoritativeCostUsd: 2.0,
  });
  assert.equal(r.status, ReconciliationStatus.Drifted);
  assert.equal(r.deltaUsd, null);
});

test("unavailable: no authoritative total (persistent transcript)", () => {
  const r = reconcileSessionCost({
    derivedCostUsd: 3.0,
    authoritativeCostUsd: null,
  });
  assert.equal(r.status, ReconciliationStatus.Unavailable);
  assert.equal(r.deltaUsd, null);
  assert.equal(r.relativeDelta, null);
});

// --- Tolerance profiles (PRD-538 R3 / ISS-5352) ------------------------------
// The optional `tolerance` argument exists so the golden-corpus oracle can
// compare two same-engine numbers tightly. Pin BOTH the default (so the runtime
// profile cannot be loosened by accident) and each profile's boundary on both
// sides (so a one-sided test cannot hide an off-by-one in the comparison).

test("default tolerance is the harness profile — omitting the argument changes nothing", () => {
  // Sits inside the 2% band but far outside the corpus profile, so an accidental
  // swap of the default would flip this to drifted.
  const input = { derivedCostUsd: 99.0, authoritativeCostUsd: 100.0 };
  const implicit = reconcileSessionCost(input);
  const explicit = reconcileSessionCost(
    input,
    HARNESS_RECONCILIATION_TOLERANCE
  );
  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.status, ReconciliationStatus.Matched);
});

test("harness profile boundary: exactly at tolerance matches, a hair beyond drifts", () => {
  // tolerance = max($0.01, 2% × 100) = $2.00
  assert.equal(
    reconcileSessionCost({ derivedCostUsd: 98.0, authoritativeCostUsd: 100.0 })
      .status,
    ReconciliationStatus.Matched
  );
  assert.equal(
    reconcileSessionCost({ derivedCostUsd: 97.99, authoritativeCostUsd: 100.0 })
      .status,
    ReconciliationStatus.Drifted
  );
});

test("corpus profile declares exactly the measured $1e-9 / 0% band", () => {
  // Pinned as a VALUE, not only through behavior: the two probes below bracket
  // the boundary within a factor of two, so a mutation to e.g. 1.5e-9 would
  // slip past them. Literals are written out rather than derived from the
  // constant, so loosening the profile fails here first.
  assert.deepEqual(CORPUS_ORACLE_TOLERANCE, {
    absoluteUsd: 1e-9,
    relative: 0,
  });
});

test("corpus profile boundary: sub-nano deltas match, just over 1e-9 does not", () => {
  // The corpus oracle's whole point is that it must NOT absorb a real cost
  // delta the harness profile would swallow whole.
  assert.equal(
    reconcileSessionCost(
      { derivedCostUsd: 60.000_000_000_5, authoritativeCostUsd: 60.0 },
      CORPUS_ORACLE_TOLERANCE
    ).status,
    ReconciliationStatus.Matched
  );
  // |delta| = 9.99997e-10 — the largest representable step below the band at
  // this scale (ulp(60) = 2^-47), so the inclusive `<=` boundary is exercised
  // from underneath rather than from a decade away.
  assert.equal(
    reconcileSessionCost(
      { derivedCostUsd: 60.000_000_001, authoritativeCostUsd: 60.0 },
      CORPUS_ORACLE_TOLERANCE
    ).status,
    ReconciliationStatus.Matched
  );
  // |delta| = 2.0e-9 — just over the band, and ~6 orders of magnitude BELOW a
  // cent. This is the probe that pins the declared 1e-9: the earlier
  // cent-scale drift assertion below still passes at absoluteUsd = 0.009, so
  // without this case nothing constrained the constant to a nano-dollar at
  // all. It is also ~5 orders above the corpus's measured 3.55e-15 ULP noise
  // floor, so real float noise can never reach it.
  assert.equal(
    reconcileSessionCost(
      { derivedCostUsd: 60.000_000_002, authoritativeCostUsd: 60.0 },
      CORPUS_ORACLE_TOLERANCE
    ).status,
    ReconciliationStatus.Drifted
  );
  assert.equal(
    reconcileSessionCost(
      { derivedCostUsd: 60.01, authoritativeCostUsd: 60.0 },
      CORPUS_ORACLE_TOLERANCE
    ).status,
    ReconciliationStatus.Drifted
  );
  // The same delta under the runtime profile is a match — proving the two
  // profiles are genuinely different and the corpus one is doing real work.
  assert.equal(
    reconcileSessionCost({ derivedCostUsd: 60.01, authoritativeCostUsd: 60.0 })
      .status,
    ReconciliationStatus.Matched
  );
});

test("corpus profile: unavailable still wins over a tight tolerance", () => {
  // Tightening the band must never turn a missing oracle into a comparison.
  const r = reconcileSessionCost(
    { derivedCostUsd: 60.0, authoritativeCostUsd: null },
    CORPUS_ORACLE_TOLERANCE
  );
  assert.equal(r.status, ReconciliationStatus.Unavailable);
  assert.notEqual(r.status, ReconciliationStatus.Matched);
});
