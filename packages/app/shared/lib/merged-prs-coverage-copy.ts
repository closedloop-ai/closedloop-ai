/**
 * ISS-5521 / ISS-6462 — the caveat sentences a "Merged PRs" count owes its
 * reader when the server declared it counted over a bounded sample of the
 * cohort, or when the producer never declared whether it did.
 *
 * Two surfaces render that count off the same `CohortDeliveryMetrics` payload:
 * the Agents component-detail card (`agents/lib/detail-data.ts`) and the Packs
 * performance tile (`packs/lib/merged-prs-readout.ts`). Their HEADLINES name
 * different populations and stay local to each surface; these two sentences are
 * the same claim about the same cap, so restating them per surface is how one of
 * them ends up describing a cap the other has since changed.
 *
 * `shared/lib` rather than a slice: this is cross-feature, and it is pure.
 */

/**
 * The producer declared nothing about its coverage. Not evidence of a cap, so
 * this asserts none — it only withdraws the whole-cohort claim.
 */
export const UNDECLARED_COHORT_COVERAGE_CAVEAT =
  "Counted server-side. This response does not say whether that count covered the whole session cohort or a capped sample of it, so the real number may be higher.";

/**
 * The count covered a bounded sample of the cohort's sessions. `subject` is
 * what ran in them, in the reader's words — "component", "pack".
 *
 * ISS-9853: names no number and no order, because two producers put the reader
 * here — a server predating ISS-9853 counted the first 2,000 sessions in
 * arbitrary order, and a current server counts every session behind the usage
 * lane's most-recent rows when that lane hit its bound (ISS-9852). "A single
 * bounded read" is the one thing both did.
 */
export function cappedCohortScanCaveat(subject: string): string {
  // "may be higher", not "is higher": the uncounted remainder can contain no
  // merged PRs at all, or only PRs already counted in the sample, in which case
  // the floor IS the total. Asserting a strict inequality would trade an
  // overstatement of coverage for an overstatement of the count.
  return `This ${subject} ran in more sessions than this count covers; we counted the ones a single bounded read returned. The real number may be higher.`;
}
