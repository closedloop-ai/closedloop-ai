import "server-only";

import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import type {
  ComplianceItem,
  ComplianceResponse,
} from "@repo/api/src/types/analytics";
import { withDb } from "@repo/database";

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
  if (dist.targetingType === "all") {
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
    if (!status || status === "pending" || status === "failed") {
      notInstalledCount++;
    } else if (status === "installed" || status === "enabled") {
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
      const distributions = await db.distribution.findMany({
        where: {
          organizationId,
          mode: "auto_install",
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
        take: limit,
      });

      if (distributions.length === 0) {
        return { items: [], total: 0 };
      }

      const orgComputeTargets = await db.computeTarget.findMany({
        // FEA-2923: exclude the synthetic per-org "cloud" sentinel target from
        // the compliance denominator — it is not a real device and can never
        // have a distribution installed, so counting it would skew coverage.
        where: { organizationId, isCloudSentinel: false },
        select: { id: true },
      });
      const allTargetIds = orgComputeTargets.map((t) => t.id);

      const items: ComplianceItem[] = [];

      for (const dist of distributions) {
        const item = await buildComplianceItem(
          db,
          dist,
          allTargetIds,
          organizationId
        );
        if (item) {
          items.push(item);
        }
      }

      return { items, total: items.length };
    });
  },
};

type PrismaDb = Parameters<Parameters<typeof withDb>[0]>[0];

async function buildComplianceItem(
  db: PrismaDb,
  dist: DistributionRow,
  allTargetIds: string[],
  organizationId: string
): Promise<ComplianceItem | null> {
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

  const installedButUnusedCount = await countInstalledButUnused(
    db,
    installedTargetIds,
    dist.catalogItem.targetKind,
    dist.catalogItem.name,
    organizationId
  );

  if (notInstalledCount === 0 && installedButUnusedCount === 0) {
    return null;
  }

  return {
    distributionId: dist.id,
    catalogItemName: dist.catalogItem.name,
    kind: dist.catalogItem.targetKind,
    mode: dist.mode,
    notInstalledCount,
    installedButUnusedCount,
    totalTargetCount,
  };
}

async function countInstalledButUnused(
  db: PrismaDb,
  installedTargetIds: string[],
  componentKind: string,
  catalogItemName: string,
  organizationId: string
): Promise<number> {
  if (installedTargetIds.length === 0) {
    return 0;
  }

  // Match usage to the SPECIFIC distributed component, not merely any component
  // of the same kind. There is no FK from CatalogItem/Distribution to the
  // installed AgentComponent, so the tightest available identity link is the
  // component's name/componentKey vs. the catalog item's name (the same
  // normalization the shared `normalizeComponentKey` SSOT applies inside
  // `encodeComponentSlug`: prefer componentKey, fall back to name,
  // lowercased+trimmed). Constraining the AgentComponent this way means
  // "installed but unused" no longer counts a target as utilizing the
  // component just because it invoked some other command/skill of that kind.
  const normalizedCatalogName = normalizeComponentKey(catalogItemName);

  const usageRows = await db.agentComponentSessionUsage.findMany({
    where: {
      componentKind,
      agentComponent: {
        computeTargetId: { in: installedTargetIds },
        organizationId,
        OR: [
          {
            componentKey: {
              equals: normalizedCatalogName,
              mode: "insensitive",
            },
          },
          {
            componentKey: null,
            name: { equals: normalizedCatalogName, mode: "insensitive" },
          },
        ],
      },
      invocationCount: { gt: 0 },
    },
    select: {
      agentComponent: {
        select: { computeTargetId: true },
      },
    },
    distinct: ["agentComponentId"],
  });

  const targetIdsWithUsage = new Set(
    usageRows
      .map((u) => u.agentComponent?.computeTargetId)
      .filter((id): id is string => id !== null && id !== undefined)
  );

  return installedTargetIds.filter((id) => !targetIdsWithUsage.has(id)).length;
}
