import {
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import type {
  TokenCostSummary,
  TokenSourceIdentity,
} from "@repo/api/src/types/token-cost-provenance";
import { branchUsageEventFingerprintSql } from "./branch-usage-event-fingerprint.js";
import type { DbHostPrisma } from "./prisma-client.js";
import {
  parseStoredTokenCostSummary,
  parseStoredTokenSourceIdentity,
} from "./token-event-contract.js";

/**
 * Read bounded Desktop provenance for an already-scoped event population.
 * Numeric event rows stay on the lightweight serving query; one atomic evidence
 * statement sizes persisted JSON and returns it only when the shared cap passes.
 */
export async function readBoundedBranchUsageCostEvidence(
  prisma: DbHostPrisma,
  events: readonly BranchUsageCostEvidenceKey[]
): Promise<BranchUsageCostEvidenceRead> {
  if (events.length > branchCostEvidenceRowBudget) {
    return { rows: [], exceeded: true };
  }
  const distinctEvents = new Map(
    events.map((event) => [event.eventRowId, event.eventFingerprint] as const)
  );
  if (distinctEvents.size !== events.length) {
    return { rows: [], exceeded: true };
  }
  if (distinctEvents.size === 0) {
    return { rows: [], exceeded: false };
  }
  const idSql = sqliteRowIdList([...distinctEvents.keys()]);
  const rawRows = await prisma.client.$queryRawUnsafe<EvidenceRawRow[]>(
    `WITH evidence_size AS MATERIALIZED (
       SELECT
         te.rowid AS event_row_id,
         ${branchUsageEventFingerprintSql("te")} AS event_fingerprint,
         length(CAST(COALESCE(te.source_identity, '') AS BLOB)) +
           length(CAST(COALESCE(te.cost_summary, '') AS BLOB)) +
           ${branchCostEvidenceFixedRowBytes} AS evidence_bytes
       FROM token_events te
       WHERE te.rowid IN (${idSql})
     ), stats AS (
       SELECT
         COUNT(*) AS evidence_count,
         COALESCE(SUM(evidence_bytes), 0) AS retained_bytes
       FROM evidence_size
     ), eligible AS (
       SELECT evidence_size.event_row_id, evidence_size.event_fingerprint
       FROM evidence_size
       CROSS JOIN stats
       WHERE stats.evidence_count = ${distinctEvents.size}
         AND stats.retained_bytes <= ${branchCostEvidenceByteBudget}
     )
     SELECT
       CAST(eligible.event_row_id AS TEXT) AS event_row_id,
       eligible.event_fingerprint,
       te.source_identity AS source_identity,
       te.cost_summary AS cost_summary,
       stats.evidence_count,
       stats.retained_bytes
     FROM stats
     LEFT JOIN eligible ON TRUE
     LEFT JOIN token_events te ON te.rowid = eligible.event_row_id
     ORDER BY eligible.event_row_id ASC`
  );
  const stats = rawRows[0];
  if (
    !stats ||
    Number(stats.evidence_count) !== distinctEvents.size ||
    Number(stats.retained_bytes) > branchCostEvidenceByteBudget ||
    rawRows.length !== distinctEvents.size
  ) {
    return { rows: [], exceeded: true };
  }
  const populatedRows = rawRows.filter(isPopulatedEvidenceRow);
  if (populatedRows.length !== rawRows.length) {
    return { rows: [], exceeded: true };
  }
  for (const row of populatedRows) {
    if (distinctEvents.get(row.event_row_id) !== row.event_fingerprint) {
      return { rows: [], exceeded: true };
    }
  }
  return {
    rows: populatedRows.map((row) => ({
      eventRowId: row.event_row_id,
      sourceIdentity: parseStoredTokenSourceIdentity(row.source_identity),
      costSummary: parseStoredTokenCostSummary(row.cost_summary),
    })),
    exceeded: false,
  };
}

function isPopulatedEvidenceRow(
  row: EvidenceRawRow
): row is PopulatedEvidenceRawRow {
  return row.event_row_id !== null && row.event_fingerprint !== null;
}

function sqliteRowIdList(values: readonly string[]): string {
  for (const value of values) {
    if (!sqliteRowIdPattern.test(value)) {
      throw new Error("Branch cost evidence received an invalid SQLite row id");
    }
  }
  return values.join(",");
}

export type BranchUsageCostEvidenceRow = {
  eventRowId: string;
  sourceIdentity?: TokenSourceIdentity;
  costSummary?: TokenCostSummary;
};

export type BranchUsageCostEvidenceKey = {
  eventRowId: string;
  eventFingerprint: string;
};

export type BranchUsageCostEvidenceRead = {
  rows: BranchUsageCostEvidenceRow[];
  exceeded: boolean;
};

type EvidenceRawRow = {
  event_row_id: string | null;
  event_fingerprint: string | null;
  source_identity: string | null;
  cost_summary: string | null;
  evidence_count: number;
  retained_bytes: number;
};

type PopulatedEvidenceRawRow = EvidenceRawRow & {
  event_row_id: string;
  event_fingerprint: string;
};

const sqliteRowIdPattern = /^[1-9]\d*$/;
