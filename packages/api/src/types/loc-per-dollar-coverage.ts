/**
 * ISS-7705 — the coverage verdict published alongside the Sessions LOC/$ ratio.
 *
 * The ratio's NUMERATOR (merged gross lines) and its DENOMINATOR (session cost)
 * are aggregated from two independently-scoped reads, so a cohort where merged
 * PR/LOC evidence is reachable while the matching session cost is not INFLATES
 * the published number. This module is the contract that lets the producer say
 * "the denominator does not cover the numerator" instead of publishing a
 * confident ratio it cannot stand behind.
 *
 * Lightweight and dependency-free (no Zod, no heavy transitive graph) because a
 * `"use client"` summary card imports it to render the reason sentence.
 */

/**
 * Why the denominator does not cover the numerator, or that it does.
 *
 * REACHABILITY IS PER PRODUCER, and not every member is reachable on either.
 * An earlier version of this docstring said every non-`Complete` member was a
 * state a real read can reach; that was already untrue when written, and the
 * TypedSQL rewrite made it untrue in a second place. A client author deciding
 * whether to handle a member needs the real answer:
 *
 * | member              | Prisma path | TypedSQL path |
 * | ------------------- | ----------- | ------------- |
 * | `Complete`          | yes         | yes           |
 * | `Stale`             | yes         | yes           |
 * | `MigrationPending`  | yes         | yes           |
 * | `Missing`           | yes         | NO            |
 * | `Failed`            | yes         | NO            |
 * | `CostBasisExcluded` | NO          | NO            |
 *
 * `Missing` — the TypedSQL statement windows its numerator on the SAME
 * `last_activity_at` the divisor uses, so `excludedSessionCount` (numerator
 * minus covered) is identically 0 and the state cannot fire. That is the
 * correct outcome rather than a defect: it would mean the card had found merged
 * lines whose cost the page's own divisor had not counted. Ruled 2026-09-09 —
 * keep the field emitted, let the state go dead (ISS-9754).
 *
 * `Failed` — the Prisma reader catches and degrades to `null`
 * (`loc-per-dollar-coverage.ts`, the catch that keeps a gate from vetoing every
 * headline on the card). The TypedSQL reader has no catch and sits in a bare
 * `Promise.all`, so a coverage-read failure rejects the WHOLE usage summary
 * instead of degrading to this state. Tracked in ISS-9757.
 *
 * `CostBasisExcluded` — unreachable on BOTH, since #6885: ISS-6526 added the
 * total basis but still carried an API-billed branch behind a flag, and #6885
 * deleted that branch. `resolveLocPerDollarCostBasis` is now the only producer
 * of `excludedUsd` and returns a hardcoded 0, so the `> 0` detector can never
 * fire. Kept in the enum because it is on the wire.
 *
 * See `apps/api/app/agent-sessions/service/loc-per-dollar-coverage.ts` for the
 * detector behind each, and `docs/session-derived-data-lifecycle.md` for the
 * lifecycle transition it corresponds to.
 */
export const LocPerDollarCoverageState = {
  /** The denominator cohort covers every numerator-bearing session. */
  Complete: "complete",
  /**
   * At least one numerator-bearing session is absent from the denominator
   * cohort, so its merged lines are counted against nobody's dollars.
   */
  Missing: "missing",
  /**
   * At least one numerator-bearing session carries no `dataRevision` at all —
   * its derived cost was never stamped with a parser revision, so it cannot be
   * validated against one.
   */
  Stale: "stale",
  /**
   * At least one numerator-bearing session has a chunked replacement STAGED and
   * not yet committed (`pendingChunkRevision`), so its derived children are
   * mid-replacement and its published cost describes a snapshot the producer has
   * already begun superseding.
   */
  MigrationPending: "migration_pending",
  /**
   * The coverage probe itself did not complete, so coverage is UNVERIFIED.
   *
   * Not the same as `Complete`, and deliberately not folded into it: an
   * unanswered question is not a clean bill of health, and publishing the ratio
   * here would assert a coverage nobody established. The summary's other
   * aggregates had already succeeded, so the read degrades to "no ratio" rather
   * than failing the whole response (AGENTS.md: complete the action if you can
   * do so without lying).
   */
  Failed: "failed",
  /**
   * NO LONGER REACHABLE ON EITHER PRODUCER — see the reachability table above.
   *
   * It meant: the denominator's cost BASIS is narrower than the window's real
   * spend, because the divisor read the API-billed ledger only and
   * subscription-covered work in the range was missing from it. ISS-6526 added
   * the total basis behind a flag; #6885 then deleted the API-billed branch
   * outright, leaving `resolveLocPerDollarCostBasis` returning a hardcoded
   * `excludedUsd: 0`. With nothing able to produce a non-zero figure, the
   * `> 0` detector cannot fire.
   *
   * Kept because it is on the wire and an older client may still switch on it.
   * `loc-per-dollar-basis.test.ts` pins the zero, so a basis that genuinely
   * excludes spend fails there and brings whoever adds it back to this comment.
   */
  CostBasisExcluded: "cost_basis_excluded",
} as const;
export type LocPerDollarCoverageState =
  (typeof LocPerDollarCoverageState)[keyof typeof LocPerDollarCoverageState];

/**
 * The coverage verdict plus the four populations AC2 exposes to telemetry.
 *
 * Counts are over the NUMERATOR cohort (sessions carrying the merged-PR links
 * the lines came from) and the DENOMINATOR cohort (sessions whose cost the
 * divisor sums), never over the whole org.
 */
export type LocPerDollarCoverage = {
  state: LocPerDollarCoverageState;
  /** Sessions carrying the session→PR links the merged lines were read through. */
  numeratorSessionCount: number;
  /** Sessions whose cost the published divisor actually sums. */
  denominatorSessionCount: number;
  /**
   * Numerator-bearing sessions the denominator cohort does NOT contain. Zero
   * does not by itself mean complete — the basis can still be narrowed.
   *
   * ZERO BY CONSTRUCTION on the TypedSQL producer, which windows its numerator
   * on the same `last_activity_at` the divisor uses (ISS-9754). Treat a flat 0
   * from that producer as the contract rather than as a signal that stopped
   * moving; only the Prisma path can report a non-zero figure here.
   *
   * AND EVEN NON-ZERO, THESE COUNT THE COVERAGE COHORT, not the sessions whose
   * pull requests produced the lines the card divides. The coverage cohort is
   * selected on delivery LINKS; it does not apply the merged-PR admission the
   * LOC statement uses, so a non-zero figure here is not evidence that the card
   * found merged lines (whitlockk on #6976). ISS-9904 narrows the gap.
   */
  excludedSessionCount: number;
  /**
   * USD the divisor is built from. WHICH ledgers that is depends on the
   * request's basis (ISS-6526): every ledger on the total basis, the API-billed
   * one alone otherwise. Do not assume either.
   */
  costBasisCoveredUsd: number;
  /**
   * USD spent in this WINDOW that the divisor's ledgers leave out — zero on the
   * total basis, the subscription-covered spend on the API-billed one.
   * Window-scoped, not numerator-cohort-scoped — do not read it as the spend
   * behind the counted lines.
   */
  costBasisExcludedUsd: number;
};
