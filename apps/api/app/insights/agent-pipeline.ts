import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import type { AgentPipelineGraphData } from "@repo/api/src/types/insights";
import { Prisma, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";

type AgentPipelineRow = {
  rowType: "node" | "edge";
  sortOrder: number;
  subagentType: string | null;
  total: number | null;
  completed: number | null;
  errors: number | null;
  sessions: number | null;
  avgDuration: number | null;
  source: string | null;
  target: string | null;
  weight: number | null;
};

/**
 * Agent-pipeline graph over the selected session window. The SQL first narrows
 * each session's `agents` JSON into one materialized row set, then derives nodes
 * and edges from that set. This avoids the previous per-session agents x agents
 * cross product before the parent-id filter could apply.
 */
export async function fetchAgentPipelineGraph(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<AgentPipelineGraphData> {
  const rows = await fetchAgentPipelineRows(scopeSql, start, end);
  const nodes = rows
    .filter(isNodeRow)
    .sort(bySortOrder)
    .map((row) => {
      const completed = toNumber(row.completed);
      const errors = toNumber(row.errors);
      const finished = completed + errors;
      return {
        subagentType: row.subagentType,
        total: toNumber(row.total),
        completed,
        errors,
        sessions: toNumber(row.sessions),
        successRate: finished > 0 ? (completed / finished) * 100 : 100,
        avgDuration:
          row.avgDuration === null ? null : toNumber(row.avgDuration),
        trend: [],
      };
    });
  const edges = rows
    .filter(isEdgeRow)
    .sort(bySortOrder)
    .map((row) => ({
      source: row.source,
      target: row.target,
      weight: toNumber(row.weight),
    }));
  return { nodes, edges };
}

function fetchAgentPipelineRows(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<AgentPipelineRow[]> {
  const successPattern = AGENT_SUCCESS_STATUS_TERMS.join("|");
  const failedPattern = AGENT_FAILED_STATUS_TERMS.join("|");
  return withDb((db) =>
    db.$queryRaw<AgentPipelineRow[]>(Prisma.sql`
      WITH agent_rows AS MATERIALIZED (
        SELECT
          s.artifact_id AS session_id,
          NULLIF(elem ->> 'externalAgentId', '') AS external_agent_id,
          CASE
            WHEN btrim(COALESCE(elem ->> 'parentExternalAgentId', '')) <> ''
            THEN elem ->> 'parentExternalAgentId'
            ELSE NULL
          END AS parent_external_agent_id,
          COALESCE(
            NULLIF(btrim(elem ->> 'subagentType'), ''),
            NULLIF(btrim(elem ->> 'type'), ''),
            'unknown'
          ) AS subagent_type,
          lower(COALESCE(elem ->> 'status', '')) AS status,
          CASE
            WHEN jsonb_typeof(elem -> 'startedAt') = 'string'
            THEN elem ->> 'startedAt'
            ELSE NULL
          END AS started_at,
          CASE
            WHEN jsonb_typeof(elem -> 'endedAt') = 'string'
            THEN elem ->> 'endedAt'
            ELSE NULL
          END AS ended_at
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents ELSE '[]'::jsonb END
        ) AS elem
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND jsonb_typeof(elem) = 'object'
          AND (${scopeSql})
      ),
      node_rows AS (
        SELECT
          row_number() OVER (ORDER BY total DESC, subagent_type ASC)::int AS sort_order,
          subagent_type,
          total,
          completed,
          errors,
          sessions,
          avg_duration
        FROM (
          SELECT
            subagent_type,
            COUNT(*)::int AS total,
            SUM(CASE WHEN status ~ ${successPattern} THEN 1 ELSE 0 END)::int AS completed,
            SUM(CASE WHEN status ~ ${failedPattern} THEN 1 ELSE 0 END)::int AS errors,
            COUNT(DISTINCT session_id)::int AS sessions,
            AVG(
              CASE
                WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz))
                ELSE NULL
              END
            )::float8 AS avg_duration
          FROM agent_rows
          GROUP BY subagent_type
        ) node_totals
        ORDER BY total DESC, subagent_type ASC
        LIMIT 50
      ),
      edge_rows AS (
        SELECT
          row_number() OVER (ORDER BY weight DESC, source ASC, target ASC)::int AS sort_order,
          source,
          target,
          weight
        FROM (
          SELECT
            p.subagent_type AS source,
            c.subagent_type AS target,
            COUNT(*)::int AS weight
          FROM agent_rows c
          JOIN agent_rows p
            ON p.session_id = c.session_id
           AND p.external_agent_id = c.parent_external_agent_id
          WHERE c.parent_external_agent_id IS NOT NULL
          GROUP BY p.subagent_type, c.subagent_type
        ) edge_totals
        ORDER BY weight DESC, source ASC, target ASC
        LIMIT 50
      )
      SELECT
        'node'::text AS "rowType",
        sort_order AS "sortOrder",
        subagent_type AS "subagentType",
        total,
        completed,
        errors,
        sessions,
        avg_duration AS "avgDuration",
        NULL::text AS source,
        NULL::text AS target,
        NULL::int AS weight
      FROM node_rows
      UNION ALL
      SELECT
        'edge'::text AS "rowType",
        sort_order AS "sortOrder",
        NULL::text AS "subagentType",
        NULL::int AS total,
        NULL::int AS completed,
        NULL::int AS errors,
        NULL::int AS sessions,
        NULL::float8 AS "avgDuration",
        source,
        target,
        weight
      FROM edge_rows
    `)
  );
}

function isNodeRow(
  row: AgentPipelineRow
): row is AgentPipelineRow & { rowType: "node"; subagentType: string } {
  return row.rowType === "node" && row.subagentType !== null;
}

function isEdgeRow(row: AgentPipelineRow): row is AgentPipelineRow & {
  rowType: "edge";
  source: string;
  target: string;
} {
  return row.rowType === "edge" && row.source !== null && row.target !== null;
}

function bySortOrder(a: AgentPipelineRow, b: AgentPipelineRow): number {
  return toNumber(a.sortOrder) - toNumber(b.sortOrder);
}
