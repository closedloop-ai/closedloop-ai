import "server-only";

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  decodeDetailRouteKey,
  resolveDetailIdentityScope,
} from "../content-hash-identity";
import { detailUsageLaneWheres } from "../detail-usage-reads";
import {
  buildChildIdentityPackLookup,
  detailChildUsageStatementWheres,
  loadDetailChildIdentityLookup,
  pluginPackCandidates,
} from "../plugin-child-usage";
import {
  DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
  detailUsageIdentityMatcher,
} from "./detail-usage-identity";

/** Canonical component population, applied before the Sessions list's facets, totals and paging. */
export async function buildComponentSessionScope(
  organizationId: string,
  slug: string
): Promise<Prisma.SessionDetailWhereInput> {
  return {
    artifact: { organizationId },
    componentUsages: {
      some: await buildComponentUsageScope(organizationId, slug),
    },
  };
}

export function buildComponentUsageScope(
  organizationId: string,
  slug: string
): Promise<Prisma.AgentComponentSessionUsageWhereInput> {
  const identity = decodeDetailRouteKey(slug);
  if (!identity) {
    return Promise.resolve(emptyUsageScope(organizationId));
  }
  return withDb.tx(
    async (tx) => {
      const scope = await resolveDetailIdentityScope(
        tx,
        organizationId,
        identity.kind,
        identity.fingerprint,
        identity.key
      );
      if (scope.orphanOnly) {
        return {
          OR: detailUsageLaneWheres(
            organizationId,
            identity.kind,
            scope.key,
            scope.keys,
            scope.usageContentScope
          ),
        };
      }
      const inventoryWhere: Prisma.AgentComponentWhereInput = {
        organizationId,
        componentKind: identity.kind,
        uninstalledAt: null,
        ...scope.inventoryWhere,
      };
      const inventoryRows = await tx.agentComponent.findMany({
        where: inventoryWhere,
        select: {
          componentKind: true,
          componentKey: true,
          name: true,
          packId: true,
        },
      });
      if (inventoryRows.length === 0) {
        return {
          OR: detailUsageLaneWheres(
            organizationId,
            identity.kind,
            scope.key,
            scope.keys,
            scope.usageContentScope
          ),
        };
      }
      if (identity.kind === AgentComponentKind.Plugin) {
        return pluginUsageScope(tx, organizationId, inventoryRows, scope.key);
      }
      // The own-FK lane permits legacy missing own identities. Resolve only its
      // distinct identity keys, then reuse the detail's exact admission test.
      const ownLane: Prisma.AgentComponentSessionUsageWhereInput = {
        agentComponent: inventoryWhere,
        session: { artifact: { organizationId } },
      };
      const ownKeys = await tx.agentComponentSessionUsage.groupBy({
        by: ["componentKind", "componentKey"],
        where: ownLane,
      });
      const matches = ownKeys.filter(
        detailUsageIdentityMatcher({
          kind: identity.kind,
          key: scope.key,
          keys: scope.keys,
          inventoryRows,
        })
      );
      const lanes = detailUsageLaneWheres(
        organizationId,
        identity.kind,
        scope.key,
        scope.keys,
        null
      );
      if (matches.length > 0) {
        lanes.push({ AND: [ownLane, rawIdentityWhere(matches)] });
      }
      return { OR: lanes };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
}

async function pluginUsageScope(
  tx: TransactionClient,
  organizationId: string,
  rows: readonly { packId: string | null }[],
  key: string
): Promise<Prisma.AgentComponentSessionUsageWhereInput> {
  const packs = pluginPackCandidates({
    packIds: new Set(rows.flatMap((row) => (row.packId ? [row.packId] : []))),
    key,
  });
  const lookup = await loadDetailChildIdentityLookup(
    tx,
    [...packs],
    organizationId
  );
  if (lookup.identityPrefilter.length === 0) {
    return emptyUsageScope(organizationId);
  }
  const predicates = detailChildUsageStatementWheres(
    lookup.identityPrefilter,
    organizationId
  );
  const belongs = buildChildIdentityPackLookup(lookup.packIdsByIdentity);
  const matches: { componentKind: string; componentKey: string }[] = [];
  for (const where of predicates) {
    const keys = await tx.agentComponentSessionUsage.groupBy({
      by: ["componentKind", "componentKey"],
      where,
    });
    matches.push(
      ...keys.filter((row) => belongs(row.componentKind, row.componentKey))
    );
  }
  if (matches.length === 0) {
    return emptyUsageScope(organizationId);
  }
  return { AND: [{ OR: predicates }, rawIdentityWhere(matches)] };
}

function rawIdentityWhere(
  rows: readonly { componentKind: string; componentKey: string }[]
): Prisma.AgentComponentSessionUsageWhereInput {
  const keysByKind = new Map<string, Set<string>>();
  for (const row of rows) {
    const keys = keysByKind.get(row.componentKind) ?? new Set<string>();
    keys.add(row.componentKey);
    keysByKind.set(row.componentKind, keys);
  }
  return {
    OR: [...keysByKind].map(([componentKind, keys]) => ({
      componentKind,
      componentKey: { in: [...keys] },
    })),
  };
}
function emptyUsageScope(
  organizationId: string
): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    agentSessionId: { in: [] },
    session: { artifact: { organizationId } },
  };
}
