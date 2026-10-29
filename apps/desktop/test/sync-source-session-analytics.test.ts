import assert from "node:assert/strict";
import { MAX_SESSION_ESTIMATED_COST_USD } from "@repo/cost/session-web-search-cost";
import { test } from "vitest";
import {
  mapSyncedSessionAnalytics,
  resolveSyncedSessionCostUsd,
} from "../src/main/database/sync-source-session-analytics.js";

/**
 * ISS-7176 / ISS-7813: the `session_analytics` → synced-payload mapper.
 *
 * It was extracted from `sync-source.ts` with no test of its own, and it decides
 * the one value this ticket exists to fix — the whole-session cost the cloud
 * stores. The case that matters is not that the mapper copies fields; it is WHICH
 * column the cost comes from, and that `null` survives the trip.
 */

/** A rollup row whose `est_cost` is DELIBERATELY different from the authoritative cost. */
function analyticsRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "s-1",
    started_at: "2026-08-01T00:00:00.000Z",
    started_day: "2026-08-01",
    status: "inactive",
    harness: "claude",
    is_human: 1,
    human_turns: 3,
    agent_turns: 9,
    event_count: 40,
    tool_invocations: 7,
    error_events: 0,
    input_tokens: 1000,
    output_tokens: 250,
    cache_read_tokens: 9_000_000,
    cache_write_tokens: 200_000,
    // The column this mapper used to read. Every assertion below that touches
    // cost is chosen so that reading THIS instead of the parameter fails.
    est_cost: 4.44,
    runtime_ms: 1234,
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  } as never;
}

test("no rollup row omits the section entirely", () => {
  // Omission is distinct from a null cost: the cloud preserves a previously
  // synced rollup when the section is absent, and overwrites when it is present.
  assert.equal(mapSyncedSessionAnalytics(undefined, 12.5), undefined);
});

test("the cost comes from the PARAMETER, not the rollup row's est_cost", () => {
  // The mapper takes the cost as an argument so its SOURCE is the caller's
  // validated choice. Both persisted candidates are nullable and carry the same
  // figure whenever a cost IS known, so a fixture where they AGREE would prove
  // nothing — hence 4.44 vs 9.99.
  //
  // This pins the MAPPER only. Which column the call site actually reads is
  // asserted by `sync-source-session-analytics-wiring.test.ts`.
  const mapped = mapSyncedSessionAnalytics(analyticsRow(), 9.99);
  assert.equal(mapped?.estimatedCostUsd, 9.99);
});

test("an unknown cost travels as null, not 0 and not omitted", () => {
  // The whole point of the column change. A `0` here would be indistinguishable
  // from a subscription session that genuinely cost $0.00, which is the defect.
  const mapped = mapSyncedSessionAnalytics(analyticsRow(), null);
  assert.equal(mapped?.estimatedCostUsd, null);
  assert.equal(Object.hasOwn(mapped ?? {}, "estimatedCostUsd"), true);
});

test("a null cost is still null when the rollup HAS an est_cost", () => {
  // The sharpest form of the same check: a mapper that fell back to the rollup
  // would emit 4.44 here, silently asserting a cost for a session nothing priced.
  const mapped = mapSyncedSessionAnalytics(
    analyticsRow({ est_cost: 4.44 }),
    null
  );
  assert.equal(mapped?.estimatedCostUsd, null);
});

test("a real $0.00 stays 0 and is not confused with unknown", () => {
  // The other side of the distinction the nullable column buys.
  const mapped = mapSyncedSessionAnalytics(analyticsRow(), 0);
  assert.equal(mapped?.estimatedCostUsd, 0);
  assert.notEqual(mapped?.estimatedCostUsd, null);
});

/**
 * ISS-7818 mutation coverage: the SQLite wiring suite proves the same behavior
 * end to end, but Stryker's related-test selection does not associate that
 * indirect load path with this leaf module, so the resolver is also pinned at
 * its direct unit boundary.
 */
test("an unpriced window sends null instead of a partial authoritative cost", () => {
  assert.equal(
    resolveSyncedSessionCostUsd(null, 4.2, [
      { cost_usd_estimated: 1.5 },
      { cost_usd_estimated: null },
    ]),
    null
  );
});

test("a fully priced window sends null when the authoritative cost is unknown", () => {
  assert.equal(resolveSyncedSessionCostUsd(null, null, []), null);
});

test("a fully priced window accepts the authoritative cost", () => {
  assert.equal(
    resolveSyncedSessionCostUsd(null, 9.99, [{ cost_usd_estimated: 1.5 }]),
    9.99
  );
});

test("an entirely unpriced window rejects a partial authoritative cost", () => {
  assert.equal(
    resolveSyncedSessionCostUsd(null, 4.2, [
      { cost_usd_estimated: null },
      { cost_usd_estimated: null },
    ]),
    null
  );
});

test("a valid analytics cost wins before the pricing-window guard", () => {
  assert.equal(
    resolveSyncedSessionCostUsd(4.44, 4.2, [
      { cost_usd_estimated: 1.5 },
      { cost_usd_estimated: null },
    ]),
    4.44
  );
});

test("invalid analytics candidates fall through to a valid authoritative cost", () => {
  assert.equal(resolveSyncedSessionCostUsd(-1, 9.99, []), 9.99);
  assert.equal(
    resolveSyncedSessionCostUsd(Number.POSITIVE_INFINITY, 9.99, []),
    9.99
  );
});

test("a real zero analytics cost wins over the authoritative fallback", () => {
  assert.equal(resolveSyncedSessionCostUsd(0, 9.99, []), 0);
});

test("is_human is a boolean, both ways", () => {
  assert.equal(
    mapSyncedSessionAnalytics(analyticsRow({ is_human: 1 }), 1)?.isHuman,
    true
  );
  assert.equal(
    mapSyncedSessionAnalytics(analyticsRow({ is_human: 0 }), 1)?.isHuman,
    false
  );
  // Non-zero is human, not just literal 1.
  assert.equal(
    mapSyncedSessionAnalytics(analyticsRow({ is_human: 2 }), 1)?.isHuman,
    true
  );
});

test("token counts carry through BigInt-safely and are not swapped", () => {
  // Distinct values per counter, so a copy/paste transposition between the four
  // `tokenCountValue` calls fails rather than passing on equal numbers.
  const mapped = mapSyncedSessionAnalytics(
    analyticsRow({
      input_tokens: 1n,
      output_tokens: 2n,
      cache_read_tokens: 3n,
      cache_write_tokens: 4n,
    }),
    1
  );
  assert.equal(mapped?.inputTokens, 1);
  assert.equal(mapped?.outputTokens, 2);
  assert.equal(mapped?.cacheReadTokens, 3);
  assert.equal(mapped?.cacheWriteTokens, 4);
});

test("the remaining scalars are carried, including the nullable ones", () => {
  const mapped = mapSyncedSessionAnalytics(
    analyticsRow({
      runtime_ms: null,
      updated_at: null,
      status: null,
      harness: null,
    }),
    1
  );
  assert.equal(mapped?.humanTurns, 3);
  assert.equal(mapped?.agentTurns, 9);
  assert.equal(mapped?.eventCount, 40);
  assert.equal(mapped?.toolInvocations, 7);
  assert.equal(mapped?.errorEvents, 0);
  assert.equal(mapped?.runtimeMs, null);
  assert.equal(mapped?.updatedAt, null);
  assert.equal(mapped?.status, null);
  assert.equal(mapped?.harness, null);
});

/**
 * Stryker (ISS-7813): the four `tokenCountValue` field labels all survived
 * mutation to `""`, because nothing asserted them. They are not decoration —
 * `readStorageTokenCount` throws `InvalidTokenCountError` carrying the label, so
 * it is the only thing distinguishing a corrupt cache-write count from a corrupt
 * input count in the resulting message. Blanking them all would leave four
 * different corruptions reporting the same anonymous error, which is exactly the
 * "surface it where the context is richest" rule this repo states for bad data.
 */
for (const [column, label] of [
  ["input_tokens", "analytics.input"],
  ["output_tokens", "analytics.output"],
  ["cache_read_tokens", "analytics.cacheRead"],
  ["cache_write_tokens", "analytics.cacheWrite"],
] as const) {
  test(`a corrupt ${column} names ${label} in the error`, () => {
    assert.throws(
      () => mapSyncedSessionAnalytics(analyticsRow({ [column]: -1 }), 1),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(label.replace(".", "\\.")));
        return true;
      }
    );
  });
}

/**
 * ISS-7818 review (whitlockk): the runtime lies a SQLite `REAL` column can tell.
 *
 * Both inputs below are forbidden by the parameter type and reachable in
 * persistence, which is exactly the trust boundary the AGENTS.md carve-out says
 * must be tested rather than skipped as type-forbidden.
 */
test("a blank persisted cost is unknown, not a measured zero", () => {
  // `Number("")` is 0, so without the typeof gate EITHER candidate fabricates a
  // confident $0.00 through the one path that looks validated.
  assert.equal(resolveSyncedSessionCostUsd("" as never, null, []), null);
  assert.equal(resolveSyncedSessionCostUsd(null, "" as never, []), null);
});

test("a blank analytics cost falls through to a valid authoritative cost", () => {
  // The sharper form of the same gate: a fabricated 0 would WIN the first link
  // and this assertion would never reach the second one.
  assert.equal(resolveSyncedSessionCostUsd("" as never, 9.99, []), 9.99);
});

test("a cost past the destination column's range is unknown, not a failed ingest", () => {
  // $100,000,000 clears `z.number().finite().nonnegative()` at the ingress and
  // then overflows `Decimal(14, 6)`, rolling back every session in the batch.
  assert.equal(resolveSyncedSessionCostUsd(100_000_000, null, []), null);
  assert.equal(resolveSyncedSessionCostUsd(null, 100_000_000, []), null);
});

test("the largest storable cost is still a cost", () => {
  // The bound is inclusive. A ceiling that refused its own maximum would turn a
  // figure the column CAN hold into a fabricated unknown.
  assert.equal(
    resolveSyncedSessionCostUsd(MAX_SESSION_ESTIMATED_COST_USD, null, []),
    MAX_SESSION_ESTIMATED_COST_USD
  );
});

test("a persisted cost is canonicalized to the scale the cloud stores", () => {
  // A seventh decimal place is resolved here, so the figure this producer sends
  // is the figure `roundCost` writes rather than one the cloud silently changes.
  assert.equal(resolveSyncedSessionCostUsd(1.234_567_8, null, []), 1.234_568);
});
