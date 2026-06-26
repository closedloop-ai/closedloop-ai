/**
 * @file reconciliation-cause-hint.test.ts
 * @description Unit tests for the drift cause-ranking heuristic (FEA-1436),
 * src/main/reconciliation-cause-hint.ts.
 *
 * The reviewed invariants: (1) drift DIRECTION selects the candidate causes —
 * under-estimate (local < vendor) surfaces vendor-charged-more explanations,
 * over-estimate (local > vendor) surfaces vendor-charged-less explanations;
 * (2) the Anthropic 1-hour cache-write gap is a PERMANENT/expected cause that
 * ranks first when applicable and links to the upstream genai-prices project
 * (a real homepage, not a fabricated issue number); (3) "unknown" is always
 * retained as a fallback so a row is never left unexplained; and (4) zero drift
 * yields no hints.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DriftCauseFeatures,
  rankDriftCauses,
} from "../src/main/reconciliation-cause-hint.js";

function features(overrides: Partial<DriftCauseFeatures>): DriftCauseFeatures {
  return {
    vendor: "anthropic",
    driftMicroCents: 0,
    localMicroCents: 0,
    vendorMicroCents: 0,
    hasCacheWriteTokens: false,
    ...overrides,
  };
}

test("zero drift produces no hints", () => {
  assert.deepEqual(rankDriftCauses(features({ driftMicroCents: 0 })), []);
});

test("under-estimate on Anthropic with cache writes ranks the 1h cache gap first and permanent", () => {
  const hints = rankDriftCauses(
    features({
      vendor: "anthropic",
      driftMicroCents: -5000, // local < vendor
      localMicroCents: 95_000,
      vendorMicroCents: 100_000,
      hasCacheWriteTokens: true,
    })
  );
  assert.equal(hints[0].cause, "cache_write_1h_unmodeled");
  assert.equal(hints[0].permanent, true);
  assert.equal(hints[0].link, "https://github.com/pydantic/genai-prices");
  // Fallback always retained.
  assert.equal(hints.at(-1).cause, "unknown");
});

test("the 1h cache gap is not offered without cache-write tokens or for other vendors", () => {
  // Anthropic under-estimate but no cache writes → not the cache gap.
  const noCache = rankDriftCauses(
    features({
      vendor: "anthropic",
      driftMicroCents: -5000,
      localMicroCents: 95_000,
      vendorMicroCents: 100_000,
      hasCacheWriteTokens: false,
    })
  );
  assert.ok(!noCache.some((h) => h.cause === "cache_write_1h_unmodeled"));

  // Non-Anthropic vendor with cache writes → still not the Anthropic-specific gap.
  const otherVendor = rankDriftCauses(
    features({
      vendor: "openai",
      driftMicroCents: -5000,
      localMicroCents: 95_000,
      vendorMicroCents: 100_000,
      hasCacheWriteTokens: true,
    })
  );
  assert.ok(!otherVendor.some((h) => h.cause === "cache_write_1h_unmodeled"));
});

test("under-estimate with server-side tool use surfaces that cause", () => {
  const hints = rankDriftCauses(
    features({
      vendor: "openai",
      driftMicroCents: -2000,
      localMicroCents: 98_000,
      vendorMicroCents: 100_000,
      hasServerSideToolUse: true,
    })
  );
  assert.ok(hints.some((h) => h.cause === "server_side_tool_use"));
  assert.equal(hints.at(-1).cause, "unknown");
});

test("over-estimate against a non-zero vendor bill suggests a batch discount", () => {
  const hints = rankDriftCauses(
    features({
      vendor: "anthropic",
      driftMicroCents: 20_000, // local > vendor
      localMicroCents: 120_000,
      vendorMicroCents: 100_000,
    })
  );
  assert.equal(hints[0].cause, "batch_api_discount");
  assert.equal(hints.at(-1).cause, "unknown");
  // Batch discount is not a permanent/expected gap.
  assert.equal(hints[0].permanent, false);
});

test("over-estimate against a zero vendor bill suggests credit/trial", () => {
  const hints = rankDriftCauses(
    features({
      vendor: "anthropic",
      driftMicroCents: 50_000,
      localMicroCents: 50_000,
      vendorMicroCents: 0, // vendor billed nothing
    })
  );
  assert.equal(hints[0].cause, "trial_credit");
  assert.ok(!hints.some((h) => h.cause === "batch_api_discount"));
  assert.equal(hints.at(-1).cause, "unknown");
});

test("every hint carries a non-empty title and detail", () => {
  const scenarios: DriftCauseFeatures[] = [
    features({
      driftMicroCents: -5000,
      vendorMicroCents: 100_000,
      hasCacheWriteTokens: true,
    }),
    features({
      driftMicroCents: -5000,
      vendorMicroCents: 100_000,
      hasServerSideToolUse: true,
    }),
    features({
      driftMicroCents: 20_000,
      localMicroCents: 120_000,
      vendorMicroCents: 100_000,
    }),
    features({
      driftMicroCents: 50_000,
      localMicroCents: 50_000,
      vendorMicroCents: 0,
    }),
  ];
  for (const f of scenarios) {
    for (const hint of rankDriftCauses(f)) {
      assert.ok(hint.title.length > 0, `cause ${hint.cause} needs a title`);
      assert.ok(hint.detail.length > 0, `cause ${hint.cause} needs a detail`);
      // Only the permanent known-gap hint carries a link.
      if (hint.permanent) {
        assert.ok(hint.link && hint.link.length > 0);
      }
    }
  }
});
