import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessResult,
  ModelTokenUsage,
} from "../src/main/cost/token-usage.js";
import { ReconciliationStatus } from "../src/main/cost/usage-reconciliation.js";
import {
  buildUsageReconciliation,
  computeDerivedCostUsd,
  toCompletedEventUsageReconciliation,
} from "../src/main/cost/usage-reconciliation-event.js";

// claude-opus-4-5 prices at $5/Mtok input (verified against genai-prices).
const OPUS_45: Record<string, ModelTokenUsage> = {
  "claude-opus-4-5": {
    input: 1000,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  },
};

function resultWithCost(totalCostUsd: number | null): HarnessResult {
  return {
    subtype: "success",
    isError: false,
    totalCostUsd,
    numTurns: 5,
    durationMs: 1000,
    durationApiMs: 800,
    stopReason: "end_turn",
    usage: null,
    modelUsage: {},
    permissionDenials: null,
  };
}

test("computeDerivedCostUsd: sums parity cost across models", () => {
  assert.equal(computeDerivedCostUsd(OPUS_45), 0.005);
});

test("FEA-3546: computeDerivedCostUsd prices an unknown model at the Opus-standard fallback (never null)", () => {
  // genai-prices can't price `totally-made-up-model` (no_match); the parity
  // layer's Opus-standard fallback prices it (1000 input tok → $0.005) so a
  // heavily-used newer-model session never derives to null/$0.
  assert.equal(
    computeDerivedCostUsd({
      "totally-made-up-model": {
        input: 1000,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
    }),
    0.005
  );
});

test("computeDerivedCostUsd: null when nothing can be priced (empty model id is a data defect, not a newer model)", () => {
  // An empty model id is `unknown_model` — a data defect the FEA-3546 fallback
  // deliberately does NOT price — so nothing is priced and the derived cost stays
  // null.
  assert.equal(
    computeDerivedCostUsd({
      "": {
        input: 1000,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
    }),
    null
  );
});

test("buildUsageReconciliation: matched when derived ≈ authoritative", () => {
  const fields = buildUsageReconciliation(resultWithCost(0.005), OPUS_45);
  assert.equal(fields.sessionOrigin, "harness_stdout");
  assert.equal(fields.authoritativeCostUsd, 0.005);
  assert.equal(fields.derivedCostUsd, 0.005);
  assert.equal(fields.reconciliation.status, ReconciliationStatus.Matched);
  assert.equal(fields.harnessNumTurns, 5);
  assert.equal(fields.harnessDurationMs, 1000);
});

test("buildUsageReconciliation: drifted when authoritative far exceeds derived", () => {
  // Mirrors a web-search / fast-mode session our derived path does not yet route.
  const fields = buildUsageReconciliation(resultWithCost(1.0), OPUS_45);
  assert.equal(fields.reconciliation.status, ReconciliationStatus.Drifted);
});

test("buildUsageReconciliation: unavailable + persistent_transcript with no result envelope", () => {
  const fields = buildUsageReconciliation(null, OPUS_45);
  assert.equal(fields.sessionOrigin, "persistent_transcript");
  assert.equal(fields.authoritativeCostUsd, null);
  assert.equal(fields.derivedCostUsd, 0.005);
  assert.equal(fields.reconciliation.status, ReconciliationStatus.Unavailable);
  assert.equal(fields.harnessNumTurns, null);
});

test("ISS-5349: the full authoritative envelope reaches the completed-event payload", () => {
  const harnessResult: HarnessResult = {
    subtype: "success",
    isError: false,
    totalCostUsd: 0.005,
    numTurns: 5,
    durationMs: 1000,
    durationApiMs: 800,
    stopReason: "end_turn",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheWrite: 200,
      webSearchRequests: 3,
    },
    modelUsage: {
      "claude-opus-4-5": {
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheCreation: 200,
        costUsd: 0.005,
      },
    },
    permissionDenials: [{ toolName: "Bash", toolUseId: "toolu_01" }],
  };

  const wire = toCompletedEventUsageReconciliation(
    buildUsageReconciliation(harnessResult, OPUS_45)
  );

  // Authoritative cost is Claude Code's own number, verbatim.
  assert.equal(wire.authoritativeCostUsd, 0.005);
  assert.equal(wire.sessionOrigin, "harness_stdout");
  // The four fields the previous seam extracted and then dropped.
  assert.equal(wire.harnessDurationApiMs, 800);
  assert.equal(wire.harnessStopReason, "end_turn");
  assert.deepEqual(wire.harnessUsage, harnessResult.usage);
  assert.deepEqual(wire.harnessModelUsage, harnessResult.modelUsage);
  assert.deepEqual(wire.harnessPermissionDenials, [
    { toolName: "Bash", toolUseId: "toolu_01" },
  ]);
});

test("ISS-5349: an imported transcript omits authoritative fields rather than nulling or zeroing them", () => {
  const wire = toCompletedEventUsageReconciliation(
    buildUsageReconciliation(null, OPUS_45)
  );

  // Provenance is stamped, and the derived figure is still reported — but it is
  // never relabelled as authoritative.
  assert.equal(wire.sessionOrigin, "persistent_transcript");
  assert.equal(wire.authoritativeCostUsd, null);
  assert.equal(wire.derivedCostUsd, 0.005);
  assert.equal(wire.reconciliationStatus, ReconciliationStatus.Unavailable);

  // Cross-repo rule: absent optional fields are OMITTED, not serialized as
  // null, so an older API build sees exactly the payload it sees today.
  for (const key of [
    "harnessDurationApiMs",
    "harnessStopReason",
    "harnessUsage",
    "harnessModelUsage",
    "harnessPermissionDenials",
  ]) {
    assert.equal(
      Object.hasOwn(wire, key),
      false,
      `${key} must be omitted, not present-and-null`
    );
  }

  // And absent accounting is never a fabricated zero.
  assert.notEqual(wire.authoritativeCostUsd, 0);
});
