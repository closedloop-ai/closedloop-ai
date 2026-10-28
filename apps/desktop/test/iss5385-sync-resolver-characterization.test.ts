import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { TokenUsageRow } from "../src/main/agent-sync/agent-session-read-model.js";
import {
  resolveStoredTokenUsageCostUsd,
  resolveTokenUsageCostUsd,
} from "../src/main/agent-sync/agent-session-token-cost-resolution.js";
import {
  type BranchUsageRow,
  priceBranchRows,
  sumStoredBranchCost,
} from "../src/main/branch/branch-usage-projection.js";

/**
 * ISS-5385 / PLN-1771 S0 — CHARACTERIZATION of site #1,
 * `resolveTokenUsageCostUsd`, and its disagreement with sites #3 and #4.
 *
 * Site #1 is the most consequential of the nine because six further call sites
 * consume it — `sync-source.ts` (three), `read-stores.ts`,
 * `session-detail-mappers.ts`, `repository-facet.ts` — in two different shapes.
 * Whatever it decides propagates to the session list, session detail, the sync
 * payload, and the repo facet.
 *
 * As with the sibling branch suite, nothing here asserts a behaviour is
 * correct. These pin what the code does today so a later slice has to change a
 * test deliberately. Accuracy is a separate round (ISS-7361 / ISS-4794).
 *
 * NOT covered here: site #2 (`priceSyncedBranchSession`). Its input is the full
 * `SyncedAgentSession` wire type, which is not cheap to construct by hand; it
 * is characterized in S1 alongside the writer sites, where DB-backed fixtures
 * already exist. Its distinguishing properties are recorded in the
 * three-way-divergence test below so the gap is visible rather than silent.
 */

const FLAT_MODEL = "claude-sonnet-4-6";
const OBSERVED_AT_ISO = "2026-08-01T00:00:00Z";
/** Before the 2026-03-13 `claude-sonnet-4-6` entry change that dropped its long-context input tier. */
const PRE_RATE_CHANGE_ISO = "2026-01-15T00:00:00Z";

function usageRow(overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    session_id: "sess-1",
    model: FLAT_MODEL,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: OBSERVED_AT_ISO,
    ...overrides,
  };
}

/** The same logical usage, in the shape sites #3/#4 read. */
function branchRow(overrides: Partial<BranchUsageRow> = {}): BranchUsageRow {
  return {
    owner: "alice",
    model: FLAT_MODEL,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billingMode: "api",
    timestamp: new Date(OBSERVED_AT_ISO),
    ...overrides,
  };
}

describe("ISS-5385 site #1: resolveTokenUsageCostUsd", () => {
  test("a stored cost wins outright, even when it disagrees with list price", () => {
    // The stored value went through conservation at write time; re-deriving it
    // here would undo that. Pinned because S3 changes what "stored" means, and
    // this precedence is the thing it changes.
    const stored = 0.999;
    const row = usageRow({ cost_usd_estimated: stored });

    assert.equal(resolveTokenUsageCostUsd(row), stored);
    assert.notEqual(
      resolveTokenUsageCostUsd(usageRow()),
      stored,
      "the same row without a stored cost derives something else entirely"
    );
  });

  test("a stored cost of exactly 0 is a value, not an absence", () => {
    // `cost_usd_estimated == null` is the absence test, so 0 short-circuits as
    // a real answer. This is the correct half of the null-vs-zero distinction
    // and is pinned so a later refactor does not regress 0 into "unpriced".
    assert.equal(
      resolveStoredTokenUsageCostUsd(usageRow({ cost_usd_estimated: 0 })),
      0
    );
    assert.equal(
      resolveTokenUsageCostUsd(usageRow({ cost_usd_estimated: 0 })),
      0
    );
  });

  test("no stored cost falls through to derivation rather than reporting absence", () => {
    const derived = resolveTokenUsageCostUsd(
      usageRow({ cost_usd_estimated: null })
    );

    assert.ok(derived !== undefined);
    assert.ok(derived > 0);
  });

  test("absence is spelled `undefined` here — a third spelling", () => {
    // ISS-5385 property 3. An empty model is the only input that reaches the
    // unpriced path (see the branch suite), and when it does, site #1 answers
    // `undefined` while sites #3 and #4 answer `null`.
    const unpriced = resolveTokenUsageCostUsd(
      usageRow({ model: "", cost_usd_estimated: null })
    );

    assert.equal(unpriced, undefined);
    assert.equal(priceBranchRows([branchRow({ model: "" })]), null);
    assert.equal(
      sumStoredBranchCost([branchRow({ storedCostUsd: null })]),
      null
    );
  });

  test("site #1 forwards created_at as observedAt — observable across a real rate change", () => {
    // Each site sources `observedAt` from a different field — #1 from the row's
    // `created_at`, #3 from `row.timestamp`, #2 from `session.startedAt`. That
    // divergence is ISS-5385 property 2.
    //
    // PR #5498 review (whitlockk): an earlier version of this test used a date on
    // one side of every pricing window, so dated, missing, and garbage
    // timestamps all produced the same figure — deleting `observedAt` from
    // `resolveTokenUsageCostUsd` would have left it green. This one straddles a
    // REAL window: `claude-sonnet-4-6` carried a long-context input tier of
    // $6.00/M through 2026-03-12 that the entry from 2026-03-13 does not, so a
    // pre-window row costs strictly more than the same row priced undated
    // (which falls to the current entry).
    //
    // The token count is load-bearing and not incidental: the two eras differ
    // only ABOVE the long-context threshold, so this suite's default 1,000-token
    // fixture prices identically in both and would make the assertion vacuous.
    // That is exactly the defect this test was rewritten to fix — do not shrink
    // these counts.
    const overThreshold = { input_tokens: 1_000_000, cost_usd_estimated: null };
    const preWindow = resolveTokenUsageCostUsd(
      usageRow({ ...overThreshold, created_at: PRE_RATE_CHANGE_ISO })
    );
    const undated = resolveTokenUsageCostUsd(
      usageRow({ ...overThreshold, created_at: null })
    );
    const garbageDate = resolveTokenUsageCostUsd(
      usageRow({ ...overThreshold, created_at: "not-a-date" })
    );

    assert.ok(preWindow !== undefined && undated !== undefined);
    assert.ok(
      preWindow > undated,
      "the historical rate must actually be applied — this fails if observedAt stops being forwarded"
    );
    // Tolerance, pinned separately from forwarding: `coerceObservedAt` drops an
    // unusable value rather than refusing the row, so garbage prices as undated.
    assert.equal(
      garbageDate,
      undated,
      "an unparseable timestamp degrades to the undated rate, it does not fail the row"
    );
  });

  test("absence is spelled `undefined` here even on the corrupt-count path", () => {
    // PR #5498 review (whitlockk): the sibling branch suite claimed an empty model
    // was the only reachable unpriced path; it is not — a `cache_write_1h`
    // larger than the `cache_write` bucket it subdivides is refused as
    // `invalid_count` (ISS-4730), checked ahead of the model id. Pinned at site
    // #1 too, because the SPELLING of absence is what differs between the
    // sites, so it has to hold for both ways of reaching it.
    const corruptSplit = resolveTokenUsageCostUsd(
      usageRow({
        cost_usd_estimated: null,
        cache_write_tokens: 100,
        cache_write_1h_tokens: 500,
      })
    );

    assert.equal(corruptSplit, undefined);
  });
});

describe("ISS-5385: the same usage, three sites, three answers", () => {
  test("stored-wins, always-derive, and stored-only diverge on identical data", () => {
    // The core of the ticket, in one assertion. One logical row — same model,
    // same tokens, same instant, same captured cost — read by three sites:
    //
    //   site #1 `resolveTokenUsageCostUsd`  stored wins        -> the stored value
    //   site #3 `priceBranchRows`           always derives     -> list price
    //   site #4 `sumStoredBranchCost`       stored only        -> the stored value
    //
    // #1 and #4 agree here only because a stored cost exists. Remove it and
    // they diverge too (see the next test). Nothing at any call site says which
    // of the three policies is in play.
    const storedCost = 0.42;

    const siteOne = resolveTokenUsageCostUsd(
      usageRow({ cost_usd_estimated: storedCost })
    );
    const siteThree = priceBranchRows([
      branchRow({ storedCostUsd: storedCost }),
    ]);
    const siteFour = sumStoredBranchCost([
      branchRow({ storedCostUsd: storedCost }),
    ]);

    assert.equal(siteOne, storedCost);
    assert.equal(siteFour, storedCost);
    assert.ok(siteThree !== null);
    assert.notEqual(
      siteThree,
      siteOne,
      "the derive-always site disagrees with both stored-reading sites"
    );
  });

  test("with no stored cost the three split differently again", () => {
    // Now #1 and #3 agree (both derive) and #4 is the outlier (reports
    // absence). So which pair agrees depends on the DATA, not on the code —
    // there is no stable subset of these sites a reader can rely on.
    const siteOne = resolveTokenUsageCostUsd(
      usageRow({ cost_usd_estimated: null })
    );
    const siteThree = priceBranchRows([branchRow({ storedCostUsd: null })]);
    const siteFour = sumStoredBranchCost([branchRow({ storedCostUsd: null })]);

    assert.ok(siteOne !== undefined);
    assert.ok(siteThree !== null);
    assert.equal(siteFour, null);
    assert.ok(
      Math.abs(siteThree - siteOne) < 1e-9,
      "both deriving sites agree when neither can read a stored cost"
    );
  });
});
