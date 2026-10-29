/**
 * ISS-7175: "Total Tokens" is ONE quantity — input + output + cache read + cache
 * write — and three sites compute it: the Sessions strip tile, the current period
 * behind its delta chip (`usage-summary.ts`), and the prior period
 * (`usage-comparison.ts`). Each had its own hand-written four-term sum, held in
 * step only by a comment saying they must be.
 *
 * That is the shape of the defect this ticket exists to fix, one level down: the
 * ticket was two LABELS naming different sums, and the fix left three SUMS that
 * nothing stops from diverging. Here the term list is written once, in a shape
 * where dropping a term is a typecheck failure rather than a silent under-report
 * that only shows up as a wrong number on a chip.
 */

/**
 * The four counters, named independently of any one caller's field names — the
 * client contract spells them `totalInputTokens…`, a Prisma `_sum` spells them
 * `inputTokens…`, and neither should have to rename to use this.
 */
export type SessionTokenCounters = {
  input: number | null | undefined;
  output: number | null | undefined;
  cacheRead: number | null | undefined;
  cacheWrite: number | null | undefined;
};

/**
 * A counter this module may reason about — and `undefined` PASSES, deliberately.
 *
 * Absent is not corrupt. These fields are required on the CURRENT contract, but a
 * Desktop build predating them omits them, and rejecting that absence would dash
 * the tile for every version-skewed peer instead of showing them the total they
 * can actually account for. What is rejected is a counter that is PRESENT and
 * unusable: `null` (which the type does not admit but an unparsed wire payload
 * still carries), non-finite, or negative — a negative token count is nonsense no
 * producer means literally.
 *
 * This is the same split `cost-card-presentation.ts` already draws for cost
 * figures, for the same reason.
 */
function isInterpretableCounter(
  value: number | null | undefined
): value is number | undefined {
  return (
    value === undefined ||
    (value !== null && Number.isFinite(value) && value >= 0)
  );
}

/**
 * Total for a caller that RENDERS the figure, so a term it cannot read must not be
 * folded silently into a number a reader will trust.
 *
 * Returns null on a CORRUPT term and the caller renders its unavailable state. An
 * ABSENT term folds to 0 — see the predicate above; that is version skew, not
 * corruption, and dashing on it would punish old clients for a field they never
 * knew to send.
 * Folding a bad term to 0 here would print a confident total that is wrong by
 * exactly that term — the failure the repo names as "never emit a
 * plausible-but-wrong number", and the one the Cost tile beside this already
 * refuses by dashing.
 */
export function resolveSessionTokenTotal(
  counters: SessionTokenCounters
): number | null {
  const terms = [
    counters.input,
    counters.output,
    counters.cacheRead,
    counters.cacheWrite,
  ];
  if (!terms.every(isInterpretableCounter)) {
    return null;
  }
  return terms.reduce<number>((sum, term) => sum + (term ?? 0), 0);
}

/**
 * Total for a database aggregate, where a null `_sum` term means NO ROWS MATCHED
 * rather than corruption — an empty cohort really does total zero, and returning
 * null there would strip the delta chip off every legitimately-empty period.
 *
 * This is the existing `toNumber(...) + toNumber(...)` behavior, kept; the point
 * of routing it through here is the shared term list, not a semantic change.
 */
export function sumSessionTokenCounters(
  counters: SessionTokenCounters
): number {
  return (
    (counters.input ?? 0) +
    (counters.output ?? 0) +
    (counters.cacheRead ?? 0) +
    (counters.cacheWrite ?? 0)
  );
}
