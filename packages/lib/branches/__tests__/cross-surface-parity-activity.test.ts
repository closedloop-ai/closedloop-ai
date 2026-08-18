import { describe, expect, it } from "vitest";
import { computeExpectedActivityRollup } from "./cross-surface-parity-fixture";

/**
 * Locks the FEA-2276 activity-rollup expectation the two cross-surface parity
 * tests assert against (apps/api cloud + apps/desktop local). If the scenario or
 * the shared kernels change, this test forces the expected numbers to be
 * re-derived intentionally rather than silently drifting on either surface.
 */
describe("computeExpectedActivityRollup (cross-surface scenario)", () => {
  const rollup = computeExpectedActivityRollup();

  it("aggregates `implement` across the two sessions that ran it (beta even-split ÷ 2)", () => {
    const implement = rollup.activities.find((a) => a.phase === "implement");
    expect(implement).toEqual({
      phase: "implement",
      costUsd: 0.425, // alpha 0.30 + beta 0.25/2 (beta touches 2 branches)
      inputTokens: 110, // 60 + 50 (tokens are NOT even-split)
      outputTokens: 200, // 120 + 80
      segmentCount: 2,
      sessionCount: 2,
    });
  });

  it("keeps `review` as its own single-session aggregate", () => {
    const review = rollup.activities.find((a) => a.phase === "review");
    expect(review).toEqual({
      phase: "review",
      costUsd: 0.2,
      inputTokens: 40,
      outputTokens: 80,
      segmentCount: 1,
      sessionCount: 1,
    });
  });

  it("orders activities by the canonical taxonomy (implement before review)", () => {
    expect(rollup.activities.map((a) => a.phase)).toEqual([
      "implement",
      "review",
    ]);
  });

  it("routes the untiled session's POSITIVE spend + tokens to `unattributed`", () => {
    expect(rollup.unattributed).toMatchObject({
      phase: "unattributed",
      inputTokens: 10, // gamma's untiled tokens
      outputTokens: 20,
      segmentCount: 0,
      sessionCount: 1, // only gamma has no tiling
    });
    // gamma's positive, un-tiled spend — surfaced, never dropped (float residual
    // from the even-split total minus attributed, so compared close-to).
    expect(rollup.unattributed.costUsd).toBeCloseTo(0.25, 9);
  });

  it("reconciles: Σ(activities) + unattributed == the even-split branch total", () => {
    const attributed = rollup.activities.reduce(
      (sum, a) => sum + (a.costUsd ?? 0),
      0
    );
    // 0.5 + 0.25/2 + 0.25 = 0.875 (beta even-split across 2 branches).
    expect(rollup.totalCostUsd).toBe(0.875);
    expect(attributed + (rollup.unattributed.costUsd ?? 0)).toBeCloseTo(
      0.875,
      9
    );
  });

  it("reports that at least one session carried a tiling", () => {
    expect(rollup.hasAnySegments).toBe(true);
  });
});
