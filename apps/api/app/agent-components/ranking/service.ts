import "server-only";

import {
  encodeComponentSlug,
  normalizeComponentKey,
} from "@repo/api/src/types/agent-component-analytics";
import type {
  RankingItem,
  RankingResponse,
} from "@repo/api/src/types/analytics";
import { withDb } from "@repo/database";

type RankingQuery = {
  organizationId: string;
  kind?: string;
  limit: number;
};

type MergedRankEntry = {
  slug: string;
  name: string;
  kind: string;
  totalInvocations: number;
  totalErrors: number;
  sessionCount: number;
  deviceIds: Set<string>;
};

/**
 * Fat service for the ranking/leaderboard analytics endpoint.
 *
 * Stack-ranks AgentComponent inventory rows org-wide by aggregated usage
 * (invocationCount, sessions, adoptionBreadth, errorRate). Components are
 * deduped by org-level identity (kind + normalizedKey) before ranking.
 */
export const rankingService = {
  getRanking(query: RankingQuery): Promise<RankingResponse> {
    const { organizationId, kind, limit } = query;

    return withDb(async (db) => {
      const inventoryRows = await db.agentComponent.findMany({
        where: {
          organizationId,
          ...(kind ? { componentKind: kind } : {}),
          uninstalledAt: null,
        },
        select: {
          componentKind: true,
          componentKey: true,
          name: true,
          computeTargetId: true,
          sessionUsages: {
            select: {
              invocationCount: true,
              errorCount: true,
              session: {
                select: {
                  artifact: {
                    select: {
                      organizationId: true,
                    },
                  },
                },
              },
            },
            where: {
              session: {
                artifact: {
                  organizationId,
                },
              },
            },
          },
        },
      });

      const mergedMap = new Map<string, MergedRankEntry>();

      for (const row of inventoryRows) {
        const normalizedKey = normalizeComponentKey(row.componentKey, row.name);
        const slug = encodeComponentSlug(
          row.componentKind,
          row.componentKey,
          row.name
        );

        let merged = mergedMap.get(slug);
        if (!merged) {
          merged = {
            slug,
            name: row.name ?? row.componentKey ?? normalizedKey,
            kind: row.componentKind,
            totalInvocations: 0,
            totalErrors: 0,
            sessionCount: 0,
            deviceIds: new Set(),
          };
          mergedMap.set(slug, merged);
        }

        merged.deviceIds.add(row.computeTargetId);

        for (const usage of row.sessionUsages) {
          if (usage.session.artifact?.organizationId !== organizationId) {
            continue;
          }
          merged.totalInvocations += usage.invocationCount;
          merged.totalErrors += usage.errorCount;
          merged.sessionCount += 1;
        }
      }

      const entries = Array.from(mergedMap.values()).sort((a, b) => {
        const cmp = b.totalInvocations - a.totalInvocations;
        return cmp === 0 ? a.name.localeCompare(b.name) : cmp;
      });

      const total = entries.length;
      const page = entries.slice(0, limit);

      const items: RankingItem[] = page.map((m, idx) => ({
        slug: m.slug,
        name: m.name,
        kind: m.kind,
        rank: idx + 1,
        invocations: m.totalInvocations,
        sessions: m.sessionCount,
        adoptionBreadth: m.deviceIds.size,
        errorRate:
          m.totalInvocations > 0 ? m.totalErrors / m.totalInvocations : null,
      }));

      return { items, total };
    });
  },
};
