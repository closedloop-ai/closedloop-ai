import type { BranchRow } from "@repo/api/src/types/branch";
import { readSessionBranchCounts } from "../database/branch-reads";

/**
 * ISS-4689 — the wire even-split divisor for a set of list items: how many
 * DISTINCT branches each of their sessions touched, GLOBALLY.
 *
 * The values come from {@link readSessionBranchCounts}, restricted by the
 * pre-publication denominator-authority population. Product-visible rows use a
 * separate key set, so publication eligibility cannot shrink this divisor.
 *
 * Keys are scoped to the sessions the CALLER's items actually reference, so a
 * paginated or id-narrowed response carries a page-sized map rather than a
 * corpus-sized one, while each value stays the session's global count. Bounding
 * the id list also keeps the `IN (…)` well inside SQLite's parameter limit.
 */
export function readGlobalBranchCountsForItems(
  prisma: Parameters<typeof readSessionBranchCounts>[0],
  items: readonly BranchRow[],
  denominatorKeys?: ReadonlyArray<{
    repoFullName: string | null;
    branchName: string;
  }>
): Promise<Map<string, number>> {
  const sessionIds = new Set<string>();
  for (const item of items) {
    for (const sessionId of item.sessionIds) {
      sessionIds.add(sessionId);
    }
  }
  return readSessionBranchCounts(prisma, [...sessionIds], denominatorKeys);
}
