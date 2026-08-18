/**
 * Why a branch-detail card has no comparison to show (ISS-4686).
 *
 * Its own module, with NO imports: the copy map, the resolver and the e2e specs
 * all key off these values, and the copy/e2e side must not have to pull in the
 * resolver (and through it the design-system delta primitives) just to name a
 * reason.
 */

/** Why a card has no comparison to show. Drives the delta-slot copy. */
export const BranchNoComparisonReason = {
  /** No baseline supplied at all (today's state on every surface). */
  NotComputed: "not_computed",
  /**
   * A baseline arrived with NO scope, or with one this client doesn't recognise.
   * Unreachable through our own types, but reachable on the wire from a producer
   * that predates ISS-4686 or ships a scope added after this build — an unknown
   * provenance degrades to "cannot compare", never to a silent verdict, and
   * never to a concrete reason that would describe it wrongly.
   */
  UnknownScope: "unknown_scope",
  /** The baseline covers a different population than the value (corpus vs branch). */
  ScopeMismatch: "scope_mismatch",
  /** The baseline measures something else than the value (different span). */
  BasisMismatch: "basis_mismatch",
  /**
   * Same population, same measurement — but the KPI's own `value` is not the
   * number this card renders, and `deltaPct` is a statement about THAT value.
   */
  ValueMismatch: "value_mismatch",
  /** There is no value to compare against; the caption carries the reason. */
  ValueUnavailable: "value_unavailable",
} as const;
export type BranchNoComparisonReason =
  (typeof BranchNoComparisonReason)[keyof typeof BranchNoComparisonReason];
