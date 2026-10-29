/**
 * ISS-10467 (operator ruling, marisolashgrove 2026-09-26) — the TOKEN and COST
 * aggregates behind ONE content version's sessions.
 *
 * The ticket always asked the drill-down for "invocations, sessions, and the
 * token/cost aggregates", and the panel shipped without the last pair: the
 * producer held every session's priced cost and token counters and folded
 * neither. The ruling is that they belong there for `skill` and `command` — the
 * kinds that are most of the corpus — so this is the fold both producers drive.
 *
 * ONE DERIVATION, TWO ADAPTERS. The cloud reads `SessionDetail` rows and the
 * desktop reads its synced session records; the two hold different row shapes
 * and the same question, so each normalizes its own rows into
 * {@link VersionSpendMember} and neither owns the arithmetic. A second fold is
 * how Local and Cloud come to answer one contract with two numbers.
 *
 * COVERAGE IS PUBLISHED, NOT ROUNDED AWAY. A session set whose cost is priced
 * for some members and not others still has a real, usable sum — it is a FLOOR,
 * and a floor labelled as a floor is worth more than a blank (root AGENTS.md:
 * use partial results, disclose the shortfall beside them). What may never
 * happen is the sum being published bare, because that claims a total nobody
 * measured. `null` is reserved for the case where NOTHING was measured, which is
 * the ISS-5363 "not computed" the panel renders as a dash rather than as `$0.00`.
 */

import { locPerDollarCostMeasured } from "./loc-per-dollar.ts";

/**
 * One session behind a version, normalized.
 *
 * A session the producer holds NO record for is still a member, carrying `null`
 * in both terms: that is what makes the coverage verdict below describe the
 * version's whole session set rather than only the rows that happened to load.
 */
export type VersionSpendMember = {
  /**
   * Tokens this session reported — input + output + cache read + cache write,
   * already resolved by its owner (`sumSessionTokenCounters` on a DB aggregate,
   * `resolveSessionTokenTotal` on a wire record). `null` is "no measurement",
   * never "zero tokens".
   */
  tokens: number | null | undefined;
  /** This session's estimated USD cost; `null`/absent when nothing priced it. */
  costUsd: number | null | undefined;
};

/** One version's folded token/cost readout. */
export type VersionSpend = {
  /** Tokens summed across the version's sessions; `null` when none reported. */
  totalTokens: number | null;
  /**
   * Whether {@link totalTokens} is a FLOOR — some session in the set reported no
   * token measurement, so the real total is at least this.
   */
  totalTokensPartial: boolean;
  /** Estimated USD summed across the version's sessions; `null` when unpriced. */
  estimatedCostUsd: number | null;
  /** Whether {@link estimatedCostUsd} is a FLOOR, for the same reason. */
  estimatedCostPartial: boolean;
};

/**
 * The canonical "nothing was computed" spend — every figure in its unmeasured
 * state, no figure marked as a floor.
 *
 * Spread into the not-computed entry on BOTH producers, the way
 * `EMPTY_COHORT_DELIVERY_METRICS` already is, so a revision this surface cannot
 * measure reads the same on web and desktop.
 */
export const EMPTY_VERSION_SPEND: VersionSpend = {
  totalTokens: null,
  totalTokensPartial: false,
  estimatedCostUsd: null,
  estimatedCostPartial: false,
};

/**
 * Fold a version's session members into its token/cost readout.
 *
 * Each term is counted independently: a session priced but missing its token
 * counters contributes to the cost sum and to the token coverage hole, and
 * nothing about one term suppresses the other. Collapsing them would take a
 * computable figure away because its sibling was absent — the failure root
 * AGENTS.md names, and the same rule `unversionedDisclosure` already follows one
 * layer out.
 */
export function foldVersionSpend(
  members: Iterable<VersionSpendMember>
): VersionSpend {
  let tokens = 0;
  let tokensMeasured = 0;
  let cost = 0;
  let costMeasured = 0;
  let total = 0;
  for (const member of members) {
    total += 1;
    if (isMeasuredTokenCount(member.tokens)) {
      tokens += member.tokens;
      tokensMeasured += 1;
    }
    // The LOC/$ population's own predicate (ISS-11226), not a fourth spelling of
    // it: "was this session priced?" must have ONE answer, or this panel and the
    // ratio row above it weigh the same session differently.
    if (locPerDollarCostMeasured(member.costUsd)) {
      cost += member.costUsd;
      costMeasured += 1;
    }
  }
  return {
    totalTokens: tokensMeasured === 0 ? null : tokens,
    totalTokensPartial: tokensMeasured > 0 && tokensMeasured < total,
    estimatedCostUsd: costMeasured === 0 ? null : cost,
    estimatedCostPartial: costMeasured > 0 && costMeasured < total,
  };
}

/**
 * Whether a token counter is a usable measurement.
 *
 * Deliberately NOT {@link locPerDollarCostMeasured}, whose contract is the LOC/$
 * DENOMINATOR's membership rule and whose docstring reasons about pricing; the
 * two tests happen to agree today and mean different things, so binding tokens
 * to the cost rule would make a later change to either silently move the other.
 *
 * Rejects the whole impossible set rather than the half that is easy to
 * remember: `NaN < 0` and `Infinity < 0` are both false, so a comparison-only
 * guard admits a non-finite counter and the sum beside it renders `NaN`.
 */
function isMeasuredTokenCount(
  value: number | null | undefined
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
