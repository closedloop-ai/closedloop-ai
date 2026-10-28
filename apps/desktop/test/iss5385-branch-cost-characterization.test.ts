import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type BranchUsageRow,
  priceBranchRows,
  sumStoredBranchCost,
} from "../src/main/branch/branch-usage-projection.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";

/**
 * ISS-5385 / PLN-1771 S0 — CHARACTERIZATION. Pins what these two functions do
 * TODAY, including the answers that are wrong, so a later slice that changes
 * them has to change a test on purpose rather than by accident.
 *
 * Nothing here asserts a behaviour is correct. Several of these assertions pin
 * defects on record (ISS-5384, and ISS-5385's site #4), and the comments say so.
 * The point of the round PLN-1771 covers is that cost becomes deterministic,
 * consistent and understandable; accuracy is a later, separate job (ISS-7361,
 * ISS-4794), so no assertion here claims a dollar figure is right.
 *
 * `priceBranchRows` and `sumStoredBranchCost` are sites #3 and #4 of the
 * nine-site inventory. They price the SAME row array two ways; ISS-5384 removes
 * that mismatch from the branch hourly chart, but the underlying functions still
 * characterize the broader ISS-5385 inconsistency.
 */

/** The tiering model. See the `gpt-5.4 is load-bearing` test below. */
const TIERING_MODEL = "gpt-5.4";
/** A flat-rate model: identical per-row and aggregate pricing. */
const FLAT_MODEL = "claude-sonnet-4-6";
const OBSERVED_AT = new Date("2026-08-01T00:00:00Z");

function row(overrides: Partial<BranchUsageRow> = {}): BranchUsageRow {
  return {
    owner: "alice",
    model: FLAT_MODEL,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billingMode: "api",
    timestamp: OBSERVED_AT,
    ...overrides,
  };
}

describe("ISS-5385 site #3/#4: the same rows priced two ways", () => {
  test("gpt-5.4 is load-bearing: it is the fixture that can see a tier crossing at all", () => {
    // ISS-5385 requires a long-context fixture because a flat-rate one passes
    // under both a conserved and an unconserved policy and therefore proves
    // nothing. This pins WHICH model satisfies that, so a later edit that
    // swaps the fixture model for a flat one fails here instead of silently
    // making every tier assertion below vacuous.
    const perRequest = 100_000;
    const requests = 4;

    const split = Array.from({ length: requests }, () =>
      estimateTokenCost({
        model: TIERING_MODEL,
        inputTokens: perRequest,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        observedAt: OBSERVED_AT,
      })
    ).reduce((sum, estimate) => sum + (estimate?.costUsd ?? 0), 0);

    const aggregate = estimateTokenCost({
      model: TIERING_MODEL,
      inputTokens: perRequest * requests,
      outputTokens: 1000 * requests,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedAt: OBSERVED_AT,
    });

    assert.ok(aggregate, "the tiering fixture must price at all");
    assert.ok(
      aggregate.costUsd > split,
      "pricing one lifetime aggregate must cost MORE than the same tokens priced per request"
    );

    // The flat model is the negative control: it cannot distinguish the two.
    const flatSplit = Array.from({ length: requests }, () =>
      estimateTokenCost({
        model: FLAT_MODEL,
        inputTokens: perRequest,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        observedAt: OBSERVED_AT,
      })
    ).reduce((sum, estimate) => sum + (estimate?.costUsd ?? 0), 0);
    const flatAggregate = estimateTokenCost({
      model: FLAT_MODEL,
      inputTokens: perRequest * requests,
      outputTokens: 1000 * requests,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedAt: OBSERVED_AT,
    });
    assert.ok(flatAggregate);
    assert.ok(
      Math.abs(flatAggregate.costUsd - flatSplit) < 1e-9,
      "the flat control must NOT distinguish per-request from aggregate pricing"
    );
  });

  test("priceBranchRows prices per row, so a split series costs less than one merged row", () => {
    // This is the property the whole read-order argument rests on: tiers are a
    // per-REQUEST quantity, so the row granularity handed to the pricer decides
    // the answer. Pinned on the tiering model because the flat one cannot show it.
    const perRequest = 100_000;
    const split = priceBranchRows(
      Array.from({ length: 4 }, () =>
        row({
          model: TIERING_MODEL,
          inputTokens: perRequest,
          outputTokens: 1000,
        })
      )
    );
    const merged = priceBranchRows([
      row({
        model: TIERING_MODEL,
        inputTokens: perRequest * 4,
        outputTokens: 4000,
      }),
    ]);

    assert.ok(split !== null && merged !== null);
    assert.ok(
      merged > split,
      "merging rows before pricing crosses a tier no individual request crossed"
    );
  });

  test("the two functions still disagree on the same rows", () => {
    // A stored cost that differs from list price — the normal case, since stored
    // costs went through conservation and these do not — makes the two pricing
    // functions disagree by construction.
    const rows = [
      row({ storedCostUsd: 0.01 }),
      row({ storedCostUsd: 0.01, owner: "bob" }),
    ];

    const stored = sumStoredBranchCost(rows);
    const derived = priceBranchRows(rows);

    assert.equal(stored, 0.02);
    assert.ok(derived !== null);
    assert.notEqual(
      derived,
      stored,
      "site #3 and site #4 return different totals for one row array"
    );
  });

  test("absent cost has two different spellings depending on which site you ask", () => {
    // ISS-5385 property 3: "unknown" is spelled differently per site. Here the
    // SAME rows yield a number from one and null from the other, purely because
    // one re-derives and the other refuses to.
    const neverPriced = [row({ storedCostUsd: null })];

    assert.equal(
      sumStoredBranchCost(neverPriced),
      null,
      "no captured cost anywhere -> null"
    );
    assert.ok(
      priceBranchRows(neverPriced) !== null,
      "the same rows re-derive to a real number"
    );
  });

  test("an unrecognised model name still gets real dollars — the fallback prices anything", () => {
    // Written first as "an unpriceable model returns null". It does not: the
    // FEA-3546 unknown-model fallback prices an unrecognised name at Opus
    // rates, so a name no registry knows yields a confident figure. This is
    // ISS-4794's "a junk model name gets real dollars attached rather than
    // being flagged", reproduced as executable evidence.
    //
    // Pinned as CURRENT behaviour, not as correct. The fix belongs to the
    // accuracy round (ISS-7361 / ISS-4794), not to this plan.
    const unknown = priceBranchRows([
      row({ model: "definitely-not-a-model-xyz" }),
    ]);

    assert.ok(
      unknown !== null,
      "the fallback prices an unrecognised model name"
    );
    assert.ok(unknown > 0);
  });

  test("a model this repo registers as FREE is billed at Opus rates", () => {
    // PR #5498 review (whitlockk): an earlier version of the test above used
    // `big-pickle` as its stand-in for "not a model". It IS a model, an
    // OpenCode-hosted one that a `@closedloop-ai/loops-api` registry priced at rate 0
    // until ISS-12435 removed that registry.
    //
    // That makes it a sharper case than an invented name, so it is kept as its
    // own test rather than dropped: the same FEA-3546 fallback that rescues an
    // unrecognised name also OVERRIDES a known-free one, and bills it at Opus
    // rates.
    const free = priceBranchRows([row({ model: "big-pickle" })]);

    assert.ok(free !== null);
    assert.ok(
      free > 0,
      "a model registered at rate 0 is nonetheless billed by this engine"
    );
  });

  test("two distinct inputs reach the unpriced path: an empty model, and a corrupt TTL split", () => {
    // PR #5498 review (whitlockk): an earlier version of this test claimed an empty
    // model was the ONLY reachable unpriced path. It is not. A malformed
    // cache-write subdivision — `cacheWrite1hTokens` larger than the
    // `cacheWriteTokens` bucket it subdivides — is REFUSED as `invalid_count`
    // (ISS-4730), and `harness-cost-parity.ts:355` checks that BEFORE the model
    // id, deliberately, so a corrupt count is surfaced even on a row whose model
    // would otherwise price. So a perfectly ordinary model name reaches null too.
    //
    // Both are pinned because anything treating null as "we could not price
    // this" has to handle both, and they mean different things: one is a
    // missing identifier, the other is corrupt data the engine refuses to guess at.
    assert.equal(priceBranchRows([row({ model: "" })]), null, "empty model");
    assert.equal(
      priceBranchRows([
        row({ cacheWriteTokens: 100, cacheWrite1hTokens: 500 }),
      ]),
      null,
      "1h subdivision larger than the bucket it subdivides — invalid_count"
    );
    assert.ok(
      priceBranchRows([row({ model: "definitely-not-a-model-xyz" })]) !== null,
      "a non-empty name with valid counts still prices via the fallback"
    );
  });

  test("a zero-token row returns 0, not null — a real $0, indistinguishable from unpriced", () => {
    // `priceBranchRows` returns `anyPriced ? total : null`, and a row with all
    // token counts at zero prices SUCCESSFULLY at exactly $0.00 — so it sets
    // `anyPriced` and returns 0.
    //
    // PR #5498 review (whitlockk): this is NOT a contract violation, and an earlier
    // version of this test wrongly said it was. The docstring promises null
    // "when NOTHING priced"; here something DID price, so the contract holds.
    // What is pinned is the downstream ambiguity: the caller receives the same
    // `0` for a genuinely-free row as it would compute for one it could not
    // price, and only the null/non-null distinction separates them.
    //
    // Related to ISS-4737, which addressed the STORED path
    // (`shared-branches-zero-spend.test.ts`).
    const zeroTokens = priceBranchRows([
      row({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ]);

    assert.equal(
      zeroTokens,
      0,
      "a successfully-priced zero-token row yields 0, not null"
    );
  });

  test("sumStoredBranchCost silently drops unpriced rows from a mixed set", () => {
    // ISS-5385 site #4: an unpriced row contributes nothing and says nothing.
    // The total is indistinguishable from one where those rows did not exist,
    // so a half-priced branch reports a confident, smaller number.
    //
    // Note this behaviour is DELIBERATE per the function's own docstring —
    // un-priced subscription usage must not inflate branch spend. It is pinned
    // here as characterization, not as a defect verdict: what makes it a
    // problem is only that the sibling site re-derives those same rows.
    const halfPriced = [
      row({ storedCostUsd: 0.1 }),
      row({ storedCostUsd: null, owner: "bob" }),
    ];

    assert.equal(sumStoredBranchCost(halfPriced), 0.1);
    assert.equal(
      sumStoredBranchCost([row({ storedCostUsd: 0.1 })]),
      0.1,
      "dropping the unpriced row entirely gives the identical total — the omission is invisible"
    );
  });

  test("both sites agree on the empty set, and agree to say null rather than $0", () => {
    // The one case where the two contracts already line up. Pinned so a later
    // slice cannot regress an empty branch to a fabricated $0.
    assert.equal(priceBranchRows([]), null);
    assert.equal(sumStoredBranchCost([]), null);
  });
});
