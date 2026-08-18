/**
 * ISS-5521 / ISS-6462 — the caveat sentences a "Merged PRs" count owes its
 * reader when the server's cohort scan was capped, or when the producer never
 * declared whether it was.
 *
 * Two surfaces render that count off the same `CohortDeliveryMetrics` payload:
 * the Agents component-detail card (`agents/lib/detail-data.ts`) and the Packs
 * performance tile (`packs/lib/merged-prs-readout.ts`). Their HEADLINES name
 * different populations and stay local to each surface; these two sentences are
 * the same claim about the same cap, so restating them per surface is how one of
 * them ends up describing a cap the other has since changed.
 *
 * `shared/lib` rather than a slice: this is cross-feature, and it is pure — it
 * imports the cap from the contract and nothing else.
 */

import { COHORT_SCAN_CAP } from "@repo/api/src/types/analytics";
import { formatNumber } from "./format-utils";

/**
 * The producer declared nothing about its coverage. Not evidence of a cap, so
 * this asserts none — it only withdraws the whole-cohort claim.
 */
export const UNDECLARED_COHORT_COVERAGE_CAVEAT =
  "Counted server-side. This response does not say whether that count covered the whole session cohort or a capped sample of it, so the real number may be higher.";

/**
 * The count covered only the first {@link COHORT_SCAN_CAP} cohort sessions.
 * `subject` is what ran in them, in the reader's words — "component", "pack".
 */
export function cappedCohortScanCaveat(subject: string): string {
  const cap = formatNumber(COHORT_SCAN_CAP);
  // "may be higher", not "is higher": the unscanned remainder can contain no
  // merged PRs at all, or only PRs already counted in the scanned sample, in
  // which case the floor IS the total. Asserting a strict inequality would trade
  // an overstatement of coverage for an overstatement of the count.
  return `This ${subject} ran in more than ${cap} sessions and we count over the first ${cap}. The real number may be higher.`;
}
