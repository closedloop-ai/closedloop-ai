import "server-only";

import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import type {
  ComplianceItem,
  ComplianceResponse,
} from "@repo/api/src/types/analytics";
import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { Prisma, withDb } from "@repo/database";

type ComplianceQuery = {
  organizationId: string;
  limit: number;
};

type DistributionRow = {
  id: string;
  targetingType: string;
  mode: string;
  catalogItem: { name: string; targetKind: string };
  targetStatuses: { computeTargetId: string | null; status: string }[];
  targetingEntries: { computeTargetId: string | null }[];
};

function getExpectedTargetIds(
  dist: DistributionRow,
  allTargetIds: string[]
): string[] {
  if (dist.targetingType === DistributionTargetingType.All) {
    return allTargetIds;
  }
  return dist.targetingEntries
    .map((e) => e.computeTargetId)
    .filter((id): id is string => id !== null);
}

function classifyTargets(
  targetIds: string[],
  statusByTarget: Map<string, string>
): { notInstalledCount: number; installedTargetIds: string[] } {
  let notInstalledCount = 0;
  const installedTargetIds: string[] = [];

  for (const targetId of targetIds) {
    const status = statusByTarget.get(targetId);
    if (
      !status ||
      status === DistributionTargetStatusValue.Pending ||
      status === DistributionTargetStatusValue.Failed
    ) {
      notInstalledCount++;
    } else if (
      status === DistributionTargetStatusValue.Installed ||
      status === DistributionTargetStatusValue.Enabled
    ) {
      installedTargetIds.push(targetId);
    }
  }

  return { notInstalledCount, installedTargetIds };
}

/**
 * Fat service for the compliance-gaps analytics endpoint.
 *
 * For each auto_install Distribution in the org, computes:
 * - notInstalledCount: targets missing or with pending/failed status.
 * - installedButUnusedCount: targets with installed/enabled status but
 *   zero AgentComponentSessionUsage invocations for the component kind.
 * - totalTargetCount: all-targeting = org compute targets; specific = entry count.
 *
 * Only distributions with at least one gap are returned.
 */
export const complianceService = {
  getCompliance(query: ComplianceQuery): Promise<ComplianceResponse> {
    const { organizationId, limit } = query;

    return withDb(async (db) => {
      // Scan EVERY auto_install distribution in the org, not a `take: limit`
      // slice of them. `limit` caps the number of GAP rows we return for
      // display; it must not cap which distributions we inspect. Applying it to
      // the source query let a gap on the (limit+1)th distribution vanish and
      // the tab falsely claim full compliance (an empty `items` array). The set
      // is org-scoped and bounded by the org's catalog, so a full scan is safe.
      const distributions = await db.distribution.findMany({
        where: {
          organizationId,
          mode: DistributionMode.AutoInstall,
          // ISS-5123: a withdrawn distribution imposes no obligation on anyone,
          // so it cannot produce a compliance gap. Counting it would report
          // machines as non-compliant for a pack the org has stopped offering
          // and can no longer install — a gap no admin could ever close.
          withdrawnAt: null,
        },
        select: {
          id: true,
          targetingType: true,
          mode: true,
          catalogItem: {
            select: {
              name: true,
              targetKind: true,
            },
          },
          targetStatuses: {
            select: {
              computeTargetId: true,
              status: true,
            },
            where: {
              computeTargetId: { not: null },
            },
          },
          targetingEntries: {
            select: {
              computeTargetId: true,
            },
            where: {
              computeTargetId: { not: null },
            },
          },
        },
      });

      if (distributions.length === 0) {
        return { items: [], total: 0, truncated: false };
      }

      const orgComputeTargets = await db.computeTarget.findMany({
        // FEA-2923: exclude the synthetic per-org "cloud" sentinel target from
        // the compliance denominator — it is not a real device and can never
        // have a distribution installed, so counting it would skew coverage.
        where: { organizationId, isCloudSentinel: false },
        select: { id: true },
      });
      const allTargetIds = orgComputeTargets.map((t) => t.id);

      const prepared = distributions
        .map((dist) => prepareComplianceItem(dist, allTargetIds))
        .filter((item): item is PreparedComplianceItem => item !== null);

      // FEA-4024: resolve "installed but unused" for EVERY distribution with a
      // single usage read. The per-distribution loop this replaced awaited its
      // own `agentComponentSessionUsage.findMany` sequentially, so an org with
      // up to `limit` (max 200) auto_install distributions issued that many
      // serial DB round-trips per compliance-dashboard request. We now collect
      // every installed target + component identity once and look usage up in
      // memory.
      const usageIndex = await buildUsageIndex(db, prepared, organizationId);

      const gaps: ComplianceItem[] = [];
      for (const item of prepared) {
        const gap = toComplianceGap(item, usageIndex);
        if (gap) {
          gaps.push(gap);
        }
      }

      // `total` is the full gap count across the whole scan; `items` is the
      // capped page. `truncated` tells the client an empty page never means
      // "compliant" — it distinguishes "no gaps" from "more gaps than shown".
      const items = gaps.slice(0, limit);
      return {
        items,
        total: gaps.length,
        truncated: gaps.length > items.length,
      };
    });
  },
};

type PrismaDb = Parameters<Parameters<typeof withDb>[0]>[0];

type PreparedComplianceItem = {
  dist: DistributionRow;
  totalTargetCount: number;
  notInstalledCount: number;
  installedTargetIds: string[];
  componentKind: string;
  normalizedName: string;
};

// NUL separator for the composite usage-lookup key — it cannot appear in a
// component kind or a normalized component name.
const USAGE_KEY_SEP = "\u0000";

function usageKey(
  componentKind: string,
  normalizedName: string,
  targetId: string
): string {
  return `${componentKind}${USAGE_KEY_SEP}${normalizedName}${USAGE_KEY_SEP}${targetId}`;
}

function prepareComplianceItem(
  dist: DistributionRow,
  allTargetIds: string[]
): PreparedComplianceItem | null {
  const targetIds = getExpectedTargetIds(dist, allTargetIds);
  const totalTargetCount = targetIds.length;

  if (totalTargetCount === 0) {
    return null;
  }

  const statusByTarget = new Map<string, string>();
  for (const ts of dist.targetStatuses) {
    if (ts.computeTargetId) {
      statusByTarget.set(ts.computeTargetId, ts.status);
    }
  }

  const { notInstalledCount, installedTargetIds } = classifyTargets(
    targetIds,
    statusByTarget
  );

  return {
    dist,
    totalTargetCount,
    notInstalledCount,
    installedTargetIds,
    componentKind: dist.catalogItem.targetKind,
    normalizedName: normalizeComponentKey(dist.catalogItem.name),
  };
}

function toComplianceGap(
  item: PreparedComplianceItem,
  usageIndex: Set<string>
): ComplianceItem | null {
  const { dist, componentKind, normalizedName } = item;

  let installedButUnusedCount = 0;
  for (const targetId of item.installedTargetIds) {
    if (!usageIndex.has(usageKey(componentKind, normalizedName, targetId))) {
      installedButUnusedCount++;
    }
  }

  if (item.notInstalledCount === 0 && installedButUnusedCount === 0) {
    return null;
  }

  return {
    distributionId: dist.id,
    catalogItemName: dist.catalogItem.name,
    kind: dist.catalogItem.targetKind,
    mode: dist.mode,
    notInstalledCount: item.notInstalledCount,
    installedButUnusedCount,
    totalTargetCount: item.totalTargetCount,
  };
}

/**
 * Resolve which (componentKind, normalized component identity, computeTarget)
 * triples have at least one real invocation — the set that marks an installed
 * target as "used" for its distribution's component. Two bounded reads,
 * independent of distribution count: a GROUP BY over usage (DISTINCT pushed
 * into PostgreSQL) then one keyed fetch of the owning components.
 *
 * Match usage to the SPECIFIC distributed component, not merely any component
 * of the same kind. There is no FK from CatalogItem/Distribution to the
 * installed AgentComponent, so the tightest available identity link is the
 * component's name/componentKey vs. the catalog item's name (the same
 * normalization the shared `normalizeComponentKey` SSOT applies inside
 * `encodeComponentSlug`: prefer componentKey, fall back to name,
 * lowercased+trimmed). Constraining the AgentComponent this way means
 * "installed but unused" no longer counts a target as utilizing the component
 * just because it invoked some other command/skill of that kind.
 */
async function buildUsageIndex(
  db: PrismaDb,
  prepared: PreparedComplianceItem[],
  organizationId: string
): Promise<Set<string>> {
  // Collapse the distributions to their distinct (kind, normalized-name)
  // identities. The identity `OR` below carries only the per-identity
  // name/componentKey match — at most one branch per identity, bounded by the
  // org's catalog rather than the (max 200) distribution count. The union of
  // installed targets is hoisted into a SINGLE top-level `computeTargetId IN`
  // filter (below) so a large org's target ids are bound once, not repeated
  // per identity; otherwise enough all-target distributions push Prisma past
  // PostgreSQL's bind-parameter ceiling before the query runs. The in-memory
  // triple key discards the resulting superset (a usage row whose target
  // belongs to a different identity's installed set).
  const identities = new Map<
    string,
    { componentKind: string; normalizedName: string }
  >();
  const allTargetIds = new Set<string>();
  for (const item of prepared) {
    if (item.installedTargetIds.length === 0) {
      continue;
    }
    for (const id of item.installedTargetIds) {
      allTargetIds.add(id);
    }
    const key = `${item.componentKind}${USAGE_KEY_SEP}${item.normalizedName}`;
    if (!identities.has(key)) {
      identities.set(key, {
        componentKind: item.componentKind,
        normalizedName: item.normalizedName,
      });
    }
  }

  const usageIndex = new Set<string>();
  if (identities.size === 0) {
    return usageIndex;
  }

  // Push the DISTINCT into PostgreSQL via GROUP BY instead of materializing
  // every matching historical usage row and de-duping in memory (Prisma's
  // `distinct` runs client-side). A hot org can accumulate millions of usage
  // rows for a handful of installed components, so the existence collapse must
  // happen in the database — GROUP BY returns one row per (component, kind).
  const usageGroups = await db.agentComponentSessionUsage.groupBy({
    by: ["agentComponentId", "componentKind"],
    where: {
      invocationCount: { gt: 0 },
      agentComponent: {
        organizationId,
        computeTargetId: { in: Array.from(allTargetIds) },
      },
      OR: Array.from(identities.values(), (identity) => ({
        componentKind: identity.componentKind,
        agentComponent: {
          OR: [
            {
              componentKey: {
                equals: identity.normalizedName,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              componentKey: null,
              name: {
                equals: identity.normalizedName,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          ],
        },
      })),
    },
  });

  if (usageGroups.length === 0) {
    return usageIndex;
  }

  // Resolve the owning component identities in one bounded read — one row per
  // distinct installed component that has usage, never per usage row.
  const componentIds = Array.from(
    new Set(
      usageGroups
        .map((group) => group.agentComponentId)
        .filter((id): id is string => id !== null)
    )
  );
  const components = await db.agentComponent.findMany({
    where: { id: { in: componentIds }, organizationId },
    select: { id: true, componentKey: true, name: true, computeTargetId: true },
  });
  const componentById = new Map(components.map((c) => [c.id, c]));

  for (const group of usageGroups) {
    const component = group.agentComponentId
      ? componentById.get(group.agentComponentId)
      : undefined;
    if (!component?.computeTargetId) {
      continue;
    }
    // Mirror the case-insensitive DB match: the effective identity value is the
    // componentKey when present, else the name, lowercased only (NOT trimmed —
    // `insensitive` folds case exactly as the `where` above does).
    const effectiveKey = (
      component.componentKey ??
      component.name ??
      ""
    ).toLowerCase();
    usageIndex.add(
      usageKey(group.componentKind, effectiveKey, component.computeTargetId)
    );
  }

  return usageIndex;
}
