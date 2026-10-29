import "server-only";

import { isCloudAuthoredRow } from "./identity";

/**
 * The minimal shape the roster fold needs from an `AgentComponent` inventory
 * row: the observing compute target's user id, plus the row's provenance
 * `metadata` so a cloud-authored sentinel row can be skipped. Both are declared
 * optional so a caller that cannot produce a sentinel row (the pack rollup —
 * cloud rows carry no `packId`) need not widen its select for a guard that can
 * never fire there.
 */
export type InstallerRosterRow = {
  metadata?: unknown;
  computeTarget?: { userId: string } | null;
};

/**
 * The distinct users who have the component/pack installed, as stable user ids
 * in row order. The single definition of who counts as an installer — the
 * owner-fallback lane in `component-authors.ts` folds the same set.
 *
 * Deduped on the USER ID, never a display name: two org members can share a
 * name, and a name-keyed set would collapse them into one installer and
 * undercount adoption. Row order is the caller's `orderBy` (both callers read
 * `lastSeenAt DESC NULLS LAST, id ASC`), so the roster leads with the most
 * recently seen install.
 *
 * Names are deliberately NOT resolved here. `AgentComponent`, `ComputeTarget`,
 * and `User` carry independent org foreign keys, so a stale or inconsistent
 * cross-org target link would surface another tenant's name or fallback email
 * through a nested `computeTarget.user` join. Callers resolve these ids through
 * `resolveOwnerFallbackByUserId`, which reads `User` scoped to the organization
 * and drops an id it cannot see.
 *
 * FEA-4247 (same reason `mergeComponentRows` and `resolveDetailAuthors` skip
 * them): a cloud-authored row is NOT an install. It is backfilled onto the org's
 * synthetic "cloud" sentinel compute target when a `CatalogItem` is promoted,
 * and that target's user is the org's earliest active user — so counting it
 * would report a pack nobody installed as "Used by (1) <unrelated person>".
 */
export function installerUserIdsOf(
  rows: readonly InstallerRosterRow[]
): string[] {
  const seen = new Set<string>();
  const userIds: string[] = [];
  for (const row of rows) {
    const userId = row.computeTarget?.userId;
    if (
      userId !== undefined &&
      !(isCloudAuthoredRow({ metadata: row.metadata }) || seen.has(userId))
    ) {
      seen.add(userId);
      userIds.push(userId);
    }
  }
  return userIds;
}
