import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { SessionFacetFilterInput } from "./records";
import type { UsageSqlFacetCount } from "./usage-sql-reader";

/**
 * A selection that cannot match. DISTINCT from `[]`, which every statement reads
 * as "no filter" — returning `[]` for a self read with no resolved viewer would
 * widen the read to the whole organization, which is the precise failure
 * FEA-3534 exists to prevent. Mirrors the live builder's `{ in: [] }`.
 */
const IMPOSSIBLE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * ISS-12251: the Owner, matched against the assignee — the `userIds` facet
 * intersected with the singular `userId` deep link (operator ruling, Kerensa Whitlock
 * 2026-10-13), as the live builder ANDs them on the one column. An empty
 * intersection fails CLOSED: `[]` means "no filter" to every statement.
 */
export function resolveOwnerUserIds(input: SessionFacetFilterInput): string[] {
  const userIds = input.filters.userIds ?? [];
  const deepLink = resolveOwnerDeepLink(input.filters);
  if (deepLink === null) {
    return [...userIds];
  }
  if (userIds.length === 0 || userIds.includes(deepLink)) {
    return [deepLink];
  }
  return [IMPOSSIBLE_ID];
}

/**
 * The singular `userId` deep link, which `viewerScope=self` drops in favor of
 * the viewer (the live builder's `applyArtifactPersonFilters`).
 */
function resolveOwnerDeepLink(
  filters: SessionFacetFilterInput["filters"]
): string | null {
  if (filters.viewerScope === AgentSessionViewerScope.Self || !filters.userId) {
    return null;
  }
  return filters.userId;
}

/**
 * The Owner arm of `sessionFacetCounts` skips `$4` so the facet can widen its
 * own selection (ISS-5283), but the live path keeps the `userId` deep link on
 * its Owner counts (FEA-4304, `facet-count-where.ts`). The arm is grouped by
 * the assignee, so keeping only the deep-linked owner's row is that conjunct.
 */
export function pinOwnerArmToDeepLink(
  rows: UsageSqlFacetCount[],
  filters: SessionFacetFilterInput["filters"]
): UsageSqlFacetCount[] {
  const deepLink = resolveOwnerDeepLink(filters);
  if (deepLink === null) {
    return rows;
  }
  return rows.filter(
    (row) => row.dimension !== "owner" || row.value === deepLink
  );
}

/**
 * ISS-12251 D-4: the `viewerScope=self` scope, matched against Created by. It
 * replaces the singular `userId` with the authenticated viewer's id, so a
 * forged or dropped `userId` cannot widen a self read. A self request with no
 * resolved `viewerId` fails CLOSED: `[]` means "no filter" to every statement
 * and would widen the read to the whole org.
 *
 * The Owner facet cannot widen it: it is a separate conjunct on a different
 * column, so a self read filtered by Owner is "my sessions that X owns", never
 * "X's sessions".
 */
export function resolveCreatorUserIds(
  input: SessionFacetFilterInput
): string[] {
  if (input.filters.viewerScope !== AgentSessionViewerScope.Self) {
    return [];
  }
  return [input.viewerId ?? IMPOSSIBLE_ID];
}
