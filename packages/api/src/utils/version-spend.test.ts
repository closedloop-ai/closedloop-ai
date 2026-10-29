/**
 * ISS-10467 (operator ruling, marisolashgrove 2026-09-26): the one fold both the
 * cloud and the desktop version-usage producers drive.
 *
 * What these cases hold, and each would fail under exactly one way of collapsing
 * the contract:
 *
 *  - MEASURED ZERO vs NOTHING MEASURED. `0` is a fact ("priced, and it was
 *    free"); `null` is the absence of one. A fold that returned `0` for an
 *    all-unmeasured set publishes a measurement nobody took.
 *  - PARTIAL COVERAGE IS A FLOOR, NOT A BLANK. A partially priced set still has
 *    a real usable sum, so it is published WITH the floor flag — never discarded
 *    (root AGENTS.md) and never bare.
 *  - THE TWO TERMS ARE INDEPENDENT. One absent operand must not take the other
 *    with it.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_VERSION_SPEND,
  foldVersionSpend,
  type VersionSpendMember,
} from "./version-spend.ts";

function member(
  tokens: number | null | undefined,
  costUsd: number | null | undefined
): VersionSpendMember {
  return { tokens, costUsd };
}

describe("foldVersionSpend (ISS-10467)", () => {
  it("sums both terms over a fully covered session set", () => {
    expect(
      foldVersionSpend([member(1000, 1.5), member(250, 2.25)])
    ).toStrictEqual({
      totalTokens: 1250,
      totalTokensPartial: false,
      estimatedCostUsd: 3.75,
      estimatedCostPartial: false,
    });
  });

  it("reports NOTHING MEASURED as null, never as a zero total", () => {
    // The whole reason the panel can render a dash: an empty member set and a set
    // of entirely unmeasured members are both "we did not measure this", and a
    // `0` here would reach the surface as `$0.00`.
    expect(foldVersionSpend([])).toStrictEqual(EMPTY_VERSION_SPEND);
    expect(
      foldVersionSpend([member(null, null), member(null, null)])
    ).toStrictEqual(EMPTY_VERSION_SPEND);
  });

  it("keeps a MEASURED zero as the measurement it is", () => {
    // The counterpart of the case above — collapsing either direction fails
    // exactly one of the two. A session that was priced and cost nothing, and
    // reported no model spend, is a real zero.
    expect(foldVersionSpend([member(0, 0)])).toStrictEqual({
      totalTokens: 0,
      totalTokensPartial: false,
      estimatedCostUsd: 0,
      estimatedCostPartial: false,
    });
  });

  it("publishes a partially covered sum AND marks it a floor", () => {
    const spend = foldVersionSpend([member(1000, 4), member(null, null)]);
    // Published: discarding a real partial sum is the failure root AGENTS.md
    // names, and a floor is usable where a blank is not.
    expect(spend.totalTokens).toBe(1000);
    expect(spend.estimatedCostUsd).toBe(4);
    // And disclosed: bare, it would claim a total over a set half of which
    // reported nothing.
    expect(spend.totalTokensPartial).toBe(true);
    expect(spend.estimatedCostPartial).toBe(true);
  });

  it("marks only the term that is actually short", () => {
    // ONE ABSENT OPERAND MUST NOT TAKE THE OTHER WITH IT: this session was priced
    // but reported no token counters, so the cost sum is complete and exact while
    // the token sum is a floor. A fold that shared one coverage verdict between
    // the two would stamp a floor marker on an exact figure.
    const spend = foldVersionSpend([member(1000, 4), member(null, 6)]);

    expect(spend.estimatedCostUsd).toBe(10);
    expect(spend.estimatedCostPartial).toBe(false);
    expect(spend.totalTokens).toBe(1000);
    expect(spend.totalTokensPartial).toBe(true);
  });

  it("refuses the whole impossible set rather than folding it to a number", () => {
    // `NaN < 0` and `Infinity < 0` are both false, so a comparison-only guard
    // admits these and the sum beside them renders `NaN` — a figure that is not
    // merely wrong but unreadable. A negative is nonsense no producer means.
    const spend = foldVersionSpend([
      member(Number.NaN, Number.POSITIVE_INFINITY),
      member(-5, -1),
      member(700, 3),
    ]);

    expect(spend.totalTokens).toBe(700);
    expect(spend.estimatedCostUsd).toBe(3);
    // The rejected members are coverage HOLES, not silent drops: the surviving
    // figures are floors over the three-member set.
    expect(spend.totalTokensPartial).toBe(true);
    expect(spend.estimatedCostPartial).toBe(true);
  });

  it("treats an omitted term the same as an explicit null", () => {
    // A version-skewed producer omits a field rather than nulling it, and the
    // member type admits `undefined` for exactly that reason.
    expect(foldVersionSpend([member(undefined, undefined)])).toStrictEqual(
      EMPTY_VERSION_SPEND
    );
  });
});
