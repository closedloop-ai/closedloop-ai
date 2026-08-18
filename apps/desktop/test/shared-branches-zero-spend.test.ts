import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchKpiState } from "@repo/api/src/types/branch.js";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

/**
 * ISS-4737 — the desktop-local AI-spend KPI must follow the SAME null-on-zero
 * rule as the cloud producer (`branch-read-service.getBranchAnalytics`) and the
 * client-side filtered re-projection (`deriveFilteredBranchAnalytics`), all three
 * now routed through `@repo/lib/branches/spend-kpi`.
 *
 * The local producer used to gate availability on `sumStoredBranchCost`'s
 * null-vs-number alone: a session with a captured cost of exactly $0 is PRICED,
 * so the sum returned a real 0 and the card rendered `$0` — asserting the work
 * was free — while the cloud producer reported the same corpus as no-data. The
 * pre-existing "no priced cost" case lives in `shared-branches-api.test.ts`
 * (FEA-2051); this focused sibling covers the priced-but-zero-sum case rather
 * than growing that shrink-only grandfathered file.
 */

/** One captured usage row for `sessionId` at `costUsd`, priced (never null). */
function pricedUsageRow(sessionId: string, costUsd: number) {
  return {
    session_id: sessionId,
    model: "claude-sonnet-4-5",
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: null,
    cost_usd_estimated: costUsd,
  };
}

describe("desktop-local AI spend is null-on-zero (ISS-4737)", () => {
  test("a PRICED session whose captured cost is exactly $0 reports unavailable, not $0", async () => {
    const source = makeSource({
      links: [link({ branch_name: "zero", session_id: "s-zero" })],
      usageTokens: [pricedUsageRow("s-zero", 0)],
    });

    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.totalSpendUsd.state, BranchKpiState.Unavailable);
    assert.equal(analytics.totalSpendUsd.value, null);
    // The corpus is NOT empty — the sibling count KPI still reports a real
    // number, so this is the spend rule firing, not an empty-corpus fallthrough.
    assert.equal(analytics.activeBranchCount.state, BranchKpiState.Available);
    assert.equal(analytics.activeBranchCount.value, 1);
  });

  test("several priced sessions summing to exactly $0 report unavailable", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "zero-a", session_id: "s-a" }),
        link({ branch_name: "zero-b", session_id: "s-b" }),
      ],
      usageTokens: [pricedUsageRow("s-a", 0), pricedUsageRow("s-b", 0)],
    });

    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.totalSpendUsd.state, BranchKpiState.Unavailable);
    assert.equal(analytics.totalSpendUsd.value, null);
  });

  /**
   * ISS-4737 (#4244 review, chatgpt-codex P1) — a CORRUPT stored cost collapses
   * to the same graceful "No data", but not silently: the Node-side producer
   * routes it through `writePersistentLog` first (see `buildBranchAnalyticsResult`
   * in `shared-branches-api.ts`), so bad persisted rows stay diagnosable instead
   * of reading as an ordinary unpriced corpus.
   *
   * This asserts the OBSERVABLE contract on this surface — a corrupt total never
   * reaches the card as a fabricated figure, and the reporting path does not
   * break the read. The log call itself is asserted on the cloud producer, whose
   * suite has the `@repo/observability/log` mock convention
   * (`apps/api/app/branches/branch-analytics-kpis.test.ts`); the shared predicate
   * that decides "corrupt vs merely unreportable" is pinned directly in
   * `packages/lib/branches/spend-kpi.test.ts`.
   */
  test("a corrupt NEGATIVE stored cost reports unavailable rather than a fabricated figure", async () => {
    const source = makeSource({
      links: [link({ branch_name: "corrupt", session_id: "s-neg" })],
      usageTokens: [pricedUsageRow("s-neg", -12.5)],
    });

    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.totalSpendUsd.state, BranchKpiState.Unavailable);
    assert.equal(analytics.totalSpendUsd.value, null);
    // Corpus is non-empty, so this is the spend rule firing, not an empty read.
    assert.equal(analytics.activeBranchCount.value, 1);
  });

  test("a real positive total is still reported, with a $0 session in the mix", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "zero-a", session_id: "s-a" }),
        link({ branch_name: "priced-b", session_id: "s-b" }),
      ],
      usageTokens: [pricedUsageRow("s-a", 0), pricedUsageRow("s-b", 0.42)],
    });

    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.totalSpendUsd.state, BranchKpiState.Available);
    assert.equal(analytics.totalSpendUsd.value, 0.42);
  });
});
