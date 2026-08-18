import "server-only";

import type {
  RankingItem,
  RankingResponse,
} from "@repo/api/src/types/analytics";
import { withDb } from "@repo/database";
import { collapseToCanonicalFamilies } from "../family-collapse";
import type { MergedComponent } from "../identity";
import { buildOrgComponentPopulation } from "../org-population";

type RankingQuery = {
  organizationId: string;
  kind?: string;
  limit: number;
};

/**
 * Fat service for the ranking/leaderboard analytics endpoint.
 *
 * Stack-ranks the org's agent components by aggregated usage (invocations,
 * distinct sessions, adoption breadth, error rate).
 *
 * ISS-4635: the population and every usage lane come from the SHARED
 * `buildOrgComponentPopulation` + `collapseToCanonicalFamilies` pipeline the
 * catalog list uses, so the two endpoints can no longer disagree. Previously
 * this service built its own:
 *
 *  - it deduped on the RAW `encodeComponentSlug(kind, componentKey, name)`,
 *    skipping the subagent instance rollup (`normalizeSubagentIdentity`) and the
 *    content-hash version families the list collapses, so a single org counted
 *    3311 "components" here against the list's 2132; and
 *  - it aggregated usage ONLY over `agentComponentSessionUsage` rows whose
 *    nullable `agentComponentId` FK pointed at a capped inventory id. Usage that
 *    synced before its inventory row existed (or that the component-sync lane
 *    never linked) carries a NULL FK and was silently dropped — which is why a
 *    whole leaderboard could read `invocations: 0` while the detail endpoint
 *    reported real invocations for the same component, and why the "usage" rank
 *    degenerated into an alphabetical tie-break. The shared population folds
 *    that orphan lane in, exactly as the list and detail reads already did
 *    (the same class of bug FEA-4337 fixed for plugin CHILD usage).
 */
export const rankingService = {
  getRanking(query: RankingQuery): Promise<RankingResponse> {
    const { organizationId, kind, limit } = query;

    return withDb(async (db) => {
      const mergedMap = await buildOrgComponentPopulation(db, {
        organizationId,
        // The endpoint's single-kind facet maps onto the shared multi-kind one.
        kinds: kind ? [kind] : undefined,
      });

      // Collapse the version-keyed buckets into ONE canonical row per component
      // FAMILY — the same projection the catalog list ranks and counts over, so
      // `total` here is the same population the list reports.
      const entries = collapseToCanonicalFamilies(mergedMap).sort(
        (a, b) =>
          b.totalInvocations - a.totalInvocations ||
          displayName(a).localeCompare(displayName(b)) ||
          a.id.localeCompare(b.id)
      );

      const total = entries.length;
      const page = entries.slice(0, limit);

      const items: RankingItem[] = page.map((entry, index) => ({
        slug: entry.slug,
        name: displayName(entry),
        kind: entry.kind,
        rank: index + 1,
        invocations: entry.totalInvocations,
        sessions: entry.sessionIds.size,
        // `collapseToCanonicalFamilies` dedupes `computeTargetIds` across the
        // family's version buckets, so its length IS the distinct device count.
        adoptionBreadth: entry.computeTargetIds.length,
        errorRate:
          entry.totalInvocations > 0
            ? entry.totalErrors / entry.totalInvocations
            : null,
      }));

      return { items, total };
    });
  },
};

/**
 * The leaderboard label for a merged family: its display `name` when the
 * inventory row carried one, else the normalized identity `key` (a usage-only
 * synthetic entry has no `name` — `AgentComponentSessionUsage` carries no name
 * column). Mirrors the catalog list's `e.name ?? e.key` fallback so the two
 * surfaces label the same component identically.
 */
function displayName(entry: MergedComponent): string {
  return entry.name ?? entry.key;
}
