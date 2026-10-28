import {
  type AgentComponentFrequency,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { z } from "zod";
import { PLUGIN_CHILD_KINDS_SQL_LIST } from "../database/db-helpers.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { pluginPackCandidates } from "./agent-component-pack-identity.js";
import {
  PLUGIN_CHILD_IDENTITY_SQL,
  PLUGIN_CHILD_OWNER_SQL,
} from "./agent-components-usage-sql.js";
import { rawKeyInClause } from "./hash-scope-predicates.js";
import {
  matchingUsageRawKeys,
  resolveDetailInventoryScope,
} from "./shared-agent-components-api.js";

type ReadPrisma = Pick<DesktopPrisma, "client">;
export type LocalComponentUsageScope = { clause: string; params: string[] };

/** Uses the existing local detail identity resolver and SQL admission rules, without loading session histories. */
export async function resolveLocalComponentUsageScope(
  prisma: ReadPrisma,
  slug: string
): Promise<LocalComponentUsageScope> {
  const scope = await resolveDetailInventoryScope(prisma, slug);
  if (!scope) {
    return { clause: "1 = 0", params: [] };
  }
  const { kind, key } = scope.parts;
  if (kind === AgentComponentKind.Plugin) {
    if (scope.inventoryRows.length === 0) {
      return { clause: "1 = 0", params: [] };
    }
    const packs = pluginPackCandidates({
      packIds: new Set(
        scope.inventoryRows.flatMap((row) => (row.pack_id ? [row.pack_id] : []))
      ),
      representative: { component_key: key },
    });
    return {
      clause: `EXISTS (SELECT 1 FROM agent_components ac WHERE ${PLUGIN_CHILD_IDENTITY_SQL}
        AND ac.pack_id IN (SELECT value FROM json_each(?)) AND ac.component_key IS NOT NULL
        AND ac.uninstalled_at IS NULL AND ${PLUGIN_CHILD_OWNER_SQL}
        AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST}))`,
      params: [JSON.stringify([...packs])],
    };
  }
  const rawKeys = await matchingUsageRawKeys(prisma, kind, key);
  const predicate = rawKeyInClause(rawKeys, "acsu.component_key");
  return {
    clause: `acsu.component_kind = ? AND ${predicate.clause}`,
    params: [kind, ...predicate.params],
  };
}

export async function resolveLocalComponentSessionIds(
  prisma: ReadPrisma,
  slug: string
): Promise<readonly string[]> {
  const scope = await resolveLocalComponentUsageScope(prisma, slug);
  const rows = await prisma.client.$queryRawUnsafe<{ session_id: string }[]>(
    `SELECT DISTINCT acsu.session_id FROM agent_component_session_usage acsu WHERE ${scope.clause}`,
    ...scope.params
  );
  return rows.map((row) => row.session_id);
}

export async function queryAgentComponentFrequencyLocal(
  prisma: ReadPrisma,
  slug: string,
  windowDays: number,
  now = new Date()
): Promise<AgentComponentFrequency> {
  z.number().int().min(1).max(365).parse(windowDays);
  const scope = await resolveLocalComponentUsageScope(prisma, slug);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const firstDay = new Date(today);
  firstDay.setUTCDate(firstDay.getUTCDate() - windowDays + 1);
  const endDay = new Date(today);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const rows = await prisma.client.$queryRawUnsafe<
    { day: string; invocations: bigint | number; minimum: bigint | number }[]
  >(
    `
    SELECT date(s.started_at) AS day, SUM(acsu.invocations) AS invocations, MIN(acsu.invocations) AS minimum
    FROM agent_component_session_usage acsu INNER JOIN sessions s ON s.id = acsu.session_id
    WHERE (${scope.clause}) AND julianday(s.started_at) >= julianday(?) AND julianday(s.started_at) < julianday(?)
    GROUP BY date(s.started_at) ORDER BY day`,
    ...scope.params,
    firstDay.toISOString(),
    endDay.toISOString()
  );
  const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const byDay = new Map(
    rows.map((row) => {
      count.parse(Number(row.minimum));
      return [row.day, count.parse(Number(row.invocations))] as const;
    })
  );
  const points: AgentComponentFrequency["points"] = [];
  for (let offset = 0; offset < windowDays; offset += 1) {
    const day = new Date(firstDay);
    day.setUTCDate(day.getUTCDate() + offset);
    const key = day.toISOString().slice(0, 10);
    points.push({ day: key, invocations: byDay.get(key) ?? 0 });
  }
  return { windowDays, points };
}
