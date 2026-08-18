import { describe, expect, it } from "vitest";
import { MERGED_TRACE_IDLE_THRESHOLD_MS } from "../merged-trace";
import {
  CROSS_SURFACE_IDLE_THRESHOLD_MS,
  CROSS_SURFACE_SESSIONS,
  computeExpectedBranchRollup,
  computeExpectedMergedTrace,
  paritySessionUsageSortKey,
} from "./cross-surface-parity-fixture";

/**
 * PLN-1389 Phase 0 — unit test for the cross-surface parity SSOT. Both parity
 * tests (cloud + desktop-local) assert their live branch read against the values
 * this module computes, so a bug in the module's OWN arithmetic would bake the
 * SAME wrong expectation into both — they'd "agree" and pass. This pins the
 * compute functions to hand-computed constants so that can't happen, and asserts
 * the idle threshold is the kernel's (not a stale copy).
 */

// Hand-computed epoch-ms for the three fixed session starts.
const T_ALPHA = Date.parse("2026-06-15T10:00:00.000Z"); // userA, cost 0.5
const T_BETA = Date.parse("2026-06-15T10:05:00.000Z"); // userB, cost 0.25, branchCount 2
const T_GAMMA = Date.parse("2026-06-15T10:40:00.000Z"); // userA, cost 0.25, no tiling

describe("cross-surface-parity-fixture (SSOT)", () => {
  it("idle threshold is the merged-trace kernel constant, not a copy", () => {
    expect(CROSS_SURFACE_IDLE_THRESHOLD_MS).toBe(
      MERGED_TRACE_IDLE_THRESHOLD_MS
    );
    // Sanity: the scenario's two gaps (5 min, 35 min) both exceed the threshold,
    // so every session boundary yields an `idle` — the shape the tests assert.
    expect(CROSS_SURFACE_IDLE_THRESHOLD_MS).toBe(120_000);
  });

  it("computeExpectedBranchRollup sums usage across both users (hand-computed)", () => {
    expect(computeExpectedBranchRollup()).toEqual({
      sessionCount: 3,
      inputTokens: 160, // 100 + 50 + 10
      outputTokens: 300, // 200 + 80 + 20
      cacheReadTokens: 420, // 300 + 120 + 0
      cacheWriteTokens: 50, // 40 + 10 + 0
      estimatedCostUsd: 0.875, // EVEN-SPLIT: 0.5 + 0.25/2 (beta ÷ 2) + 0.25
      // Per-session costs stay RAW (not even-split) on both surfaces.
      perSession: [
        {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 300,
          cacheWriteTokens: 40,
          estimatedCostUsd: 0.5,
        },
        {
          inputTokens: 50,
          outputTokens: 80,
          cacheReadTokens: 120,
          cacheWriteTokens: 10,
          estimatedCostUsd: 0.25,
        },
        {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0.25,
        },
      ],
    });
  });

  it("per-session multiset is order-independent via the sort key", () => {
    const { perSession } = computeExpectedBranchRollup();
    // The scenario order and a reversed order collapse to the same multiset.
    const forward = perSession.map(paritySessionUsageSortKey).sort();
    const reversed = [...perSession]
      .reverse()
      .map(paritySessionUsageSortKey)
      .sort();
    expect(forward).toEqual(reversed);
    // Three distinct usage tuples (no accidental collision).
    expect(new Set(forward).size).toBe(3);
  });

  it("computeExpectedMergedTrace pins ordering + idle synthesis (hand-computed)", () => {
    // Chronological: alpha(10:00) → idle → beta(10:05) → idle → gamma(10:40).
    // Each idle is stamped at the PREVIOUS instant and carries the gap.
    expect(computeExpectedMergedTrace()).toEqual([
      { type: "sessionstart", tMs: T_ALPHA, gapMs: null },
      { type: "idle", tMs: T_ALPHA, gapMs: 300_000 }, // 5 min
      { type: "sessionstart", tMs: T_BETA, gapMs: null },
      { type: "idle", tMs: T_BETA, gapMs: 2_100_000 }, // 35 min
      { type: "sessionstart", tMs: T_GAMMA, gapMs: null },
    ]);
  });

  it("sessionstart instants are strictly ascending (mis-order would fail)", () => {
    const starts = computeExpectedMergedTrace()
      .filter((item) => item.type === "sessionstart")
      .map((item) => item.tMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts).toEqual([T_ALPHA, T_BETA, T_GAMMA]);
  });

  it("scenario shape the tests rely on holds (2 users, one multi-branch session, all priced)", () => {
    expect(CROSS_SURFACE_SESSIONS).toHaveLength(3);
    expect(new Set(CROSS_SURFACE_SESSIONS.map((s) => s.userId)).size).toBe(2);
    // FEA-2276: exactly one session even-splits across >1 branch (beta, divisor 2).
    expect(
      CROSS_SURFACE_SESSIONS.filter((s) => (s.branchCount ?? 1) > 1)
    ).toHaveLength(1);
    // Every session is priced (> 0), so the untiled `unattributed` case carries
    // POSITIVE spend, not a hidden zero.
    expect(
      CROSS_SURFACE_SESSIONS.every((s) => s.usage.estimatedCostUsd > 0)
    ).toBe(true);
  });
});
