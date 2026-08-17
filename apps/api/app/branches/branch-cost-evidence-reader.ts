import { branchCostEvidenceFixedRowBytes } from "@repo/api/src/types/branch-usage";
import { Prisma, type PrismaClient } from "@repo/database";
import type { CloudCostEvidenceEvent } from "./branch-cost-evidence";
import type { SessionUsageDateWindow } from "./branch-read-service/session-usage-window";

/**
 * Read one bounded cloud evidence population in a single PostgreSQL statement.
 * The statement snapshot sizes and returns the same rows, so concurrent writes
 * cannot swap the population or grow provenance between the cap and payload.
 */
export async function readBoundedCloudCostEvidence(
  db: BranchCostEvidenceClient,
  organizationId: string,
  sessionIds: string[],
  dateWindow: SessionUsageDateWindow | undefined,
  remainingRows: number,
  remainingBytes: number
): Promise<{
  rows: CloudCostEvidenceEvent[];
  retainedBytes: number;
  exceeded: boolean;
}> {
  const rawRows = await db.$queryRaw<CloudEvidenceRawRow[]>(Prisma.sql`
    WITH evidence_size AS MATERIALIZED (
      SELECT
        event.id,
        COALESCE(octet_length(event.source_identity::text), 0) +
          ${branchCostEvidenceFixedRowBytes} AS "evidenceBytes"
      FROM agent_session_token_events event
      JOIN session_detail session ON session.artifact_id = event.agent_session_id
      JOIN artifacts artifact ON artifact.id = session.artifact_id
      WHERE event.agent_session_id = ANY(
        ARRAY[${Prisma.join(sessionIds)}]::uuid[]
      )
        AND artifact.organization_id = ${organizationId}::uuid
        ${dateWindow?.startDate ? Prisma.sql`AND event.event_created_at >= ${dateWindow.startDate}` : Prisma.empty}
        ${dateWindow?.endDate ? Prisma.sql`AND event.event_created_at <= ${dateWindow.endDate}` : Prisma.empty}
    ), stats AS (
      SELECT
        COUNT(*)::int AS "evidenceCount",
        COALESCE(SUM("evidenceBytes"), 0)::bigint AS "retainedBytes"
      FROM evidence_size
    ), eligible AS (
      SELECT evidence_size.id
      FROM evidence_size
      CROSS JOIN stats
      WHERE stats."evidenceCount" <= ${Math.max(0, remainingRows)}
        AND stats."retainedBytes" <= ${Math.max(0, remainingBytes)}
    )
    SELECT
      event.id,
      event.agent_session_id AS "agentSessionId",
      event.event_created_at AS "eventCreatedAt",
      event.input_tokens AS "inputTokens",
      event.output_tokens AS "outputTokens",
      event.cache_read_tokens AS "cacheReadTokens",
      event.cache_write_tokens AS "cacheWriteTokens",
      event.estimated_cost AS "estimatedCost",
      event.source_identity AS "sourceIdentity",
      event.cost_completeness AS "costCompleteness",
      event.cost_completeness_reason AS "costCompletenessReason",
      event.subscription_equivalent_cost AS "subscriptionEquivalentCost",
      event.api_estimated_cost AS "apiEstimatedCost",
      stats."evidenceCount",
      stats."retainedBytes"
    FROM stats
    LEFT JOIN eligible ON TRUE
    LEFT JOIN agent_session_token_events event ON event.id = eligible.id
    ORDER BY event.id ASC
  `);
  const stats = rawRows[0];
  if (!stats) {
    return { rows: [], retainedBytes: 0, exceeded: true };
  }
  const evidenceCount = Number(stats.evidenceCount);
  const retainedBytes = Number(stats.retainedBytes);
  const exceeded =
    evidenceCount > Math.max(0, remainingRows) ||
    retainedBytes > Math.max(0, remainingBytes);
  if (exceeded) {
    return { rows: [], retainedBytes: 0, exceeded: true };
  }
  const populatedRows = rawRows.filter(isPopulatedEvidenceRow);
  if (populatedRows.length !== evidenceCount) {
    return { rows: [], retainedBytes: 0, exceeded: true };
  }
  return {
    rows: populatedRows.map((row) => ({
      agentSessionId: row.agentSessionId,
      eventCreatedAt: row.eventCreatedAt,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      estimatedCost: row.estimatedCost,
      sourceIdentity: row.sourceIdentity,
      costCompleteness: row.costCompleteness,
      costCompletenessReason: row.costCompletenessReason,
      subscriptionEquivalentCost: row.subscriptionEquivalentCost,
      apiEstimatedCost: row.apiEstimatedCost,
    })),
    retainedBytes,
    exceeded: false,
  };
}

/** Build the organization/session/date predicate used by the numeric aggregate. */
export function cloudSessionEventWhere(
  organizationId: string,
  sessionIds: string[],
  dateWindow: SessionUsageDateWindow | undefined
): Prisma.AgentSessionTokenEventWhereInput {
  return {
    agentSessionId: { in: sessionIds },
    session: { artifact: { organizationId } },
    ...(dateWindow?.startDate || dateWindow?.endDate
      ? {
          eventCreatedAt: {
            ...(dateWindow.startDate ? { gte: dateWindow.startDate } : {}),
            ...(dateWindow.endDate ? { lte: dateWindow.endDate } : {}),
          },
        }
      : {}),
  };
}

function isPopulatedEvidenceRow(
  row: CloudEvidenceRawRow
): row is PopulatedCloudEvidenceRawRow {
  return row.id !== null && row.agentSessionId !== null;
}

type BranchCostEvidenceClient = Pick<PrismaClient, "$queryRaw">;

type CloudEvidenceRawRow = {
  id: string | null;
  agentSessionId: string | null;
  eventCreatedAt: Date | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadTokens: bigint | null;
  cacheWriteTokens: bigint | null;
  estimatedCost: { toString(): string } | null;
  sourceIdentity: Prisma.JsonValue | null;
  costCompleteness: string | null;
  costCompletenessReason: string | null;
  subscriptionEquivalentCost: { toString(): string } | null;
  apiEstimatedCost: { toString(): string } | null;
  evidenceCount: number;
  retainedBytes: bigint | number;
};

type PopulatedCloudEvidenceRawRow = CloudEvidenceRawRow & {
  id: string;
  agentSessionId: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
};
