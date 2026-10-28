import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
  branchCostEvidenceByteBudget,
  branchCostEvidenceRowBudget,
  branchCostSubtotalsReconcile,
} from "@repo/api/src/types/branch-usage";
import { Prisma } from "@repo/database";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import { readMaterializedBranchEventAggregates } from "./branch-analytics-rollup";
import {
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
} from "./branch-analytics-rollup-contract";
import {
  accumulateCloudEventTokenTotals,
  applyCloudLifetimeCoverage,
  type CloudCostEvidenceEvent,
  type CloudEventTokenTotals,
  setCloudEventTokenTotal,
  toBranchCostContribution,
} from "./branch-cost-evidence";
import { readBoundedCloudCostEvidence } from "./branch-cost-evidence-reader";
import type { LinkedSession } from "./branch-read-service/session-usage-link-read";
import type {
  ResolvedSessionSpend,
  SessionUsageClient,
  SessionUsageDateWindow,
} from "./branch-read-service/session-usage-window";

/** Resolve one coherent, bounded cloud evidence population for Branch usage. */
export async function resolveSessionEventEvidence(
  db: SessionUsageClient,
  organizationId: string,
  sessions: readonly LinkedSession[],
  dateWindow: SessionUsageDateWindow | undefined,
  options: ResolveSessionEventEvidenceOptions = {}
): Promise<SessionEventEvidence> {
  const windowed = Boolean(dateWindow?.startDate || dateWindow?.endDate);
  const includeCostEvidence = options.includeCostEvidence ?? true;
  if (sessions.length === 0) {
    return { contributions: [] };
  }
  const {
    evidenceRows,
    eventTokenTotals,
    aggregateSnapshots,
    windowedSpend,
    evidenceBudgetExceeded,
  } = await collectSessionEventEvidence(
    db,
    organizationId,
    sessions,
    dateWindow,
    windowed,
    includeCostEvidence
  );
  if (!includeCostEvidence) {
    return {
      contributions: [],
      ...(windowedSpend ? { windowedSpend } : {}),
    };
  }
  const evidencePopulation = compareEvidenceWithAggregate(
    evidenceRows,
    aggregateSnapshots
  );
  const evidencePopulationIncomplete =
    evidenceBudgetExceeded || !evidencePopulation.matches;
  const evidenceAggregateMalformed = [...aggregateSnapshots.values()].some(
    (snapshot) =>
      snapshot.tokenTotal === undefined ||
      snapshot.tokenMalformed ||
      snapshot.costMalformed
  );
  const fallbackSubtotalMalformed = windowed
    ? [...aggregateSnapshots.values()].some(
        (snapshot) => snapshot.costMalformed
      )
    : hasMalformedLifetimeSessionCost(sessions);
  const fallbackMalformed =
    evidencePopulation.malformed ||
    evidenceAggregateMalformed ||
    fallbackSubtotalMalformed ||
    (!windowed && hasMalformedLifetimeSessionTokens(sessions));
  const contributions = evidencePopulationIncomplete
    ? [
        coverageIncompleteContribution(
          windowed
            ? aggregateEventSubtotal(aggregateSnapshots)
            : lifetimeSessionSubtotal(sessions),
          fallbackMalformed,
          fallbackSubtotalMalformed
        ),
      ]
    : evidenceRows.map(toBranchCostContribution);
  if (!evidencePopulationIncomplete && evidenceAggregateMalformed) {
    contributions.push({
      reason: BranchCostCompletenessReason.Malformed,
    });
  }
  if (!(windowed || evidencePopulationIncomplete)) {
    applyCloudLifetimeCoverage(
      sessions,
      evidenceRows,
      contributions,
      eventTokenTotals
    );
  }
  return {
    contributions,
    ...(windowedSpend ? { windowedSpend } : {}),
  };
}

type ResolveSessionEventEvidenceOptions = {
  includeCostEvidence?: boolean;
};

async function collectSessionEventEvidence(
  db: SessionUsageClient,
  organizationId: string,
  sessions: readonly LinkedSession[],
  dateWindow: SessionUsageDateWindow | undefined,
  windowed: boolean,
  includeCostEvidence: boolean
): Promise<CollectedSessionEventEvidence> {
  const evidenceRows: CloudCostEvidenceEvent[] = [];
  const eventTokenTotals: CloudEventTokenTotals = new Map();
  const aggregateSnapshots = new Map<string, EventAggregateSnapshot>();
  const windowedSpend = windowed
    ? new Map<string, ResolvedSessionSpend>()
    : undefined;
  let evidenceBudgetExceeded = false;
  let retainedEvidenceBytes = 0;
  const chunkSize = includeCostEvidence
    ? SESSION_USAGE_COST_EVIDENCE_SESSION_CHUNK_SIZE
    : SESSION_USAGE_AGGREGATE_ONLY_SESSION_CHUNK_SIZE;
  for (let start = 0; start < sessions.length; start += chunkSize) {
    const ids = sessions
      .slice(start, start + chunkSize)
      .map((session) => session.artifactId);
    const aggregateRows = await readEventAggregates(
      db,
      organizationId,
      ids,
      dateWindow
    );
    for (const row of aggregateRows) {
      mergeAggregatedEventSpend(
        row,
        eventTokenTotals,
        aggregateSnapshots,
        windowedSpend
      );
    }
    if (includeCostEvidence && !evidenceBudgetExceeded) {
      const sample = await readBoundedCloudCostEvidence(
        db,
        organizationId,
        ids,
        dateWindow,
        branchCostEvidenceRowBudget - evidenceRows.length,
        branchCostEvidenceByteBudget - retainedEvidenceBytes
      );
      evidenceRows.push(...sample.rows);
      retainedEvidenceBytes += sample.retainedBytes;
      evidenceBudgetExceeded = sample.exceeded;
    }
  }
  return {
    evidenceRows,
    eventTokenTotals,
    aggregateSnapshots,
    windowedSpend,
    evidenceBudgetExceeded,
  };
}

function mergeAggregatedEventSpend(
  row: EventAggregateRow,
  eventTokenTotals: CloudEventTokenTotals,
  aggregateSnapshots: Map<string, EventAggregateSnapshot>,
  windowedSpend: Map<string, ResolvedSessionSpend> | undefined
): void {
  const tokens = {
    inputTokens: row._sum.inputTokens ?? 0n,
    outputTokens: row._sum.outputTokens ?? 0n,
    cacheReadTokens: row._sum.cacheReadTokens ?? 0n,
    cacheWriteTokens: row._sum.cacheWriteTokens ?? 0n,
  };
  setCloudEventTokenTotal(eventTokenTotals, row.agentSessionId, tokens);
  aggregateSnapshots.set(row.agentSessionId, eventAggregateSnapshot(row));
  if (windowedSpend) {
    const estimatedCostUsd = numberFromDecimal(row._sum.estimatedCost);
    windowedSpend.set(row.agentSessionId, {
      inputTokens: Number(tokens.inputTokens),
      outputTokens: Number(tokens.outputTokens),
      cacheReadTokens: Number(tokens.cacheReadTokens),
      cacheWriteTokens: Number(tokens.cacheWriteTokens),
      estimatedCostUsd,
      hasPricedCost: aggregateHasValidPricedCost(row, estimatedCostUsd),
    });
  }
}

async function readEventAggregates(
  db: SessionUsageClient,
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<EventAggregateRow[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const materialized = await readMaterializedEventAggregatesBestEffort(
    db,
    organizationId,
    sessionIds,
    dateWindow
  );
  if (materialized?.status === BranchAnalyticsRollupReadStatus.Available) {
    return materialized.rows.map(eventAggregateRowFromRaw);
  }
  const rows = await db.$queryRaw<EventAggregateRawRow[]>(Prisma.sql`
    WITH requested_sessions AS MATERIALIZED (
      SELECT DISTINCT unnest(
        ARRAY[${Prisma.join(sessionIds)}]::uuid[]
      ) AS id
    )
    SELECT
      event.agent_session_id AS "agentSessionId",
      SUM(event.input_tokens) AS "sumInputTokens",
      SUM(event.output_tokens) AS "sumOutputTokens",
      SUM(event.cache_read_tokens) AS "sumCacheReadTokens",
      SUM(event.cache_write_tokens) AS "sumCacheWriteTokens",
      SUM(event.estimated_cost) AS "sumEstimatedCost",
      MIN(event.input_tokens) AS "minInputTokens",
      MIN(event.output_tokens) AS "minOutputTokens",
      MIN(event.cache_read_tokens) AS "minCacheReadTokens",
      MIN(event.cache_write_tokens) AS "minCacheWriteTokens",
      MIN(event.estimated_cost) AS "minEstimatedCost",
      COUNT(event.estimated_cost) AS "estimatedCostCount",
      COUNT(*) AS "eventCount"
    FROM requested_sessions requested
    JOIN agent_session_token_events event
      ON event.agent_session_id = requested.id
    JOIN session_detail session
      ON session.artifact_id = requested.id
    JOIN artifacts artifact
      ON artifact.id = session.artifact_id
    WHERE artifact.organization_id = ${organizationId}::uuid
      ${dateWindow?.startDate ? Prisma.sql`AND event.event_created_at >= ${dateWindow.startDate}` : Prisma.empty}
      ${dateWindow?.endDate ? Prisma.sql`AND event.event_created_at <= ${dateWindow.endDate}` : Prisma.empty}
    GROUP BY event.agent_session_id
  `);
  return rows.map(eventAggregateRowFromRaw);
}

async function readMaterializedEventAggregatesBestEffort(
  db: SessionUsageClient,
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<BranchAnalyticsRollupReadResult | undefined> {
  try {
    return await readMaterializedBranchEventAggregates(
      db,
      organizationId,
      sessionIds,
      dateWindow
    );
  } catch {
    setAppSpanAttributes({
      "branches.analytics.rollup.read.failure_fell_back": true,
    });
  }
}

function eventAggregateSnapshot(
  row: EventAggregateRow
): EventAggregateSnapshot {
  return {
    count: row._count._all,
    tokenTotal: exactAggregateTokenTotal(row),
    costSubtotalUsd: nullableNumberFromDecimal(row._sum.estimatedCost),
    tokenMalformed: hasMalformedAggregateTokenRow(row),
    costMalformed: isMalformedCost(row._min?.estimatedCost ?? null),
  };
}

function hasMalformedAggregateTokenRow(row: EventAggregateRow): boolean {
  return [
    row._min?.inputTokens,
    row._min?.outputTokens,
    row._min?.cacheReadTokens,
    row._min?.cacheWriteTokens,
  ].some((value) => value !== undefined && value !== null && value < 0n);
}

function exactAggregateTokenTotal(row: EventAggregateRow): bigint | undefined {
  const values = [
    row._sum.inputTokens,
    row._sum.outputTokens,
    row._sum.cacheReadTokens,
    row._sum.cacheWriteTokens,
  ];
  if (values.some((value) => value === null || value < 0n)) {
    return;
  }
  return values.reduce<bigint>((total, value) => total + (value ?? 0n), 0n);
}

function exactSessionTokenTotal(session: LinkedSession): bigint | undefined {
  const values = [
    session.inputTokens,
    session.outputTokens,
    session.cacheReadTokens,
    session.cacheWriteTokens,
  ];
  const exactValues = values.map(exactTokenValue);
  if (exactValues.some((value) => value === undefined)) {
    return;
  }
  return exactValues.reduce<bigint>(
    (total, value) => total + (value ?? 0n),
    0n
  );
}

function exactTokenValue(value: bigint | number): bigint | undefined {
  if (typeof value === "bigint") {
    return value >= 0n ? value : undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

function compareEvidenceWithAggregate(
  evidenceRows: readonly CloudCostEvidenceEvent[],
  aggregateSnapshots: ReadonlyMap<string, EventAggregateSnapshot>
): EvidencePopulationComparison {
  const evidenceTokens = accumulateCloudEventTokenTotals(evidenceRows);
  const evidenceCounts = new Map<string, number>();
  const evidenceCosts = new Map<
    string,
    { observed: boolean; subtotalUsd: number }
  >();
  for (const row of evidenceRows) {
    evidenceCounts.set(
      row.agentSessionId,
      (evidenceCounts.get(row.agentSessionId) ?? 0) + 1
    );
    const cost = evidenceCosts.get(row.agentSessionId) ?? {
      observed: false,
      subtotalUsd: 0,
    };
    if (row.estimatedCost !== null) {
      cost.observed = true;
      cost.subtotalUsd += numberFromDecimal(row.estimatedCost);
    }
    evidenceCosts.set(row.agentSessionId, cost);
  }
  const malformed = hasMalformedEvidenceTokens(
    evidenceTokens,
    aggregateSnapshots
  );
  if (evidenceCounts.size !== aggregateSnapshots.size) {
    return { matches: false, malformed };
  }
  for (const [sessionId, aggregate] of aggregateSnapshots) {
    const cost = evidenceCosts.get(sessionId);
    const evidenceTokenTotal = evidenceTokens.get(sessionId);
    const tokenPopulationMatches =
      evidenceTokenTotal === aggregate.tokenTotal ||
      (evidenceTokenTotal === undefined && aggregate.tokenTotal === undefined);
    if (
      evidenceCounts.get(sessionId) !== aggregate.count ||
      !tokenPopulationMatches ||
      !branchCostSubtotalsReconcile(
        cost?.observed ? cost.subtotalUsd : null,
        aggregate.costSubtotalUsd
      )
    ) {
      return { matches: false, malformed };
    }
  }
  return { matches: true, malformed: false };
}

function hasMalformedEvidenceTokens(
  evidenceTokens: ReadonlyMap<string, bigint | undefined>,
  aggregateSnapshots: ReadonlyMap<string, EventAggregateSnapshot>
): boolean {
  return (
    [...evidenceTokens.values()].some((value) => value === undefined) ||
    [...aggregateSnapshots.values()].some(
      (snapshot) =>
        snapshot.tokenTotal === undefined || snapshot.count === undefined
    )
  );
}

function coverageIncompleteContribution(
  subtotalUsd: number | undefined,
  malformed = false,
  malformedCost = false
): BranchCostEvidenceContribution {
  if (subtotalUsd === undefined || malformedCost) {
    return {
      coverageIncomplete: true,
      ...(malformed ? { reason: BranchCostCompletenessReason.Malformed } : {}),
    };
  }
  if (!(Number.isFinite(subtotalUsd) && subtotalUsd >= 0)) {
    return {
      coverageIncomplete: true,
      reason: BranchCostCompletenessReason.Malformed,
    };
  }
  return {
    coverageIncomplete: true,
    fallbackSubtotalUsd: subtotalUsd,
    ...(malformed ? { reason: BranchCostCompletenessReason.Malformed } : {}),
  };
}

function aggregateEventSubtotal(
  snapshots: ReadonlyMap<string, EventAggregateSnapshot>
): number | undefined {
  let observed = false;
  let subtotalUsd = 0;
  for (const snapshot of snapshots.values()) {
    if (snapshot.costSubtotalUsd !== null) {
      observed = true;
      subtotalUsd += snapshot.costSubtotalUsd;
    }
  }
  return observed ? subtotalUsd : undefined;
}

/**
 * ISS-7813: `undefined` when NOTHING in the set carries a cost, mirroring
 * `aggregateEventSubtotal` above rather than reducing to a bare `0`.
 *
 * `numberFromDecimal` folds a null cost to 0, so a set of exclusively
 * never-priced sessions used to reduce to `0` — and `coverageIncompleteContribution`
 * accepts a finite non-negative subtotal, so that `0` was emitted as a
 * `fallbackSubtotalUsd` and read downstream as a MEASURED $0.00 for a branch
 * nothing priced. Returning `undefined` routes it to the same arm an absent
 * event subtotal already takes, which emits no fallback at all.
 *
 * A set with at least one priced session still sums, and an unpriced sibling
 * still contributes 0 to that sum — unchanged, and out of scope here: whether a
 * partially-priced branch may report a total is the pre-existing `hasPricedCost`
 * question, not this one.
 */
function lifetimeSessionSubtotal(
  sessions: readonly LinkedSession[]
): number | undefined {
  let observed = false;
  let subtotalUsd = 0;
  for (const session of sessions) {
    if (session.estimatedCost !== null) {
      observed = true;
    }
    subtotalUsd += numberFromDecimal(session.estimatedCost);
  }
  return observed ? subtotalUsd : undefined;
}

function hasMalformedLifetimeSessionCost(
  sessions: readonly LinkedSession[]
): boolean {
  return sessions.some((session) => isMalformedCost(session.estimatedCost));
}

function hasMalformedLifetimeSessionTokens(
  sessions: readonly LinkedSession[]
): boolean {
  return sessions.some(
    (session) => exactSessionTokenTotal(session) === undefined
  );
}

function isMalformedCost(
  value: { toString(): string } | number | null
): boolean {
  if (value === null) {
    return false;
  }
  const cost = numberFromDecimal(value);
  return !Number.isFinite(cost) || cost < 0;
}

function aggregateHasValidPricedCost(
  row: EventAggregateRow,
  subtotalUsd: number
): boolean {
  return (
    (row._count.estimatedCost ?? 0) > 0 &&
    Number.isFinite(subtotalUsd) &&
    subtotalUsd >= 0 &&
    !isMalformedCost(row._min?.estimatedCost ?? null)
  );
}

function nullableNumberFromDecimal(
  value: { toString(): string } | number | null
): number | null {
  return value === null ? null : numberFromDecimal(value);
}

function numberFromDecimal(
  value: { toString(): string } | number | null
): number {
  if (value === null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value.toString());
}

function eventAggregateRowFromRaw(
  row: EventAggregateRawRow
): EventAggregateRow {
  if (isPrismaEventAggregateRow(row)) {
    return row;
  }
  return {
    agentSessionId: row.agentSessionId,
    _sum: {
      inputTokens: bigintFromAggregate(row.sumInputTokens),
      outputTokens: bigintFromAggregate(row.sumOutputTokens),
      cacheReadTokens: bigintFromAggregate(row.sumCacheReadTokens),
      cacheWriteTokens: bigintFromAggregate(row.sumCacheWriteTokens),
      estimatedCost: row.sumEstimatedCost,
    },
    _min: {
      inputTokens: bigintFromAggregate(row.minInputTokens),
      outputTokens: bigintFromAggregate(row.minOutputTokens),
      cacheReadTokens: bigintFromAggregate(row.minCacheReadTokens),
      cacheWriteTokens: bigintFromAggregate(row.minCacheWriteTokens),
      estimatedCost: row.minEstimatedCost,
    },
    _count: {
      _all: countFromAggregate(row.eventCount),
      estimatedCost: countFromAggregate(row.estimatedCostCount),
    },
  };
}

function isPrismaEventAggregateRow(
  row: EventAggregateRawRow
): row is EventAggregateRow {
  return "_sum" in row && "_count" in row;
}

function bigintFromAggregate(value: EventAggregateInteger): bigint | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? BigInt(value) : null;
  }
  try {
    return BigInt(value.toString());
  } catch {
    return null;
  }
}

function countFromAggregate(value: EventAggregateInteger): number | undefined {
  const count = bigintFromAggregate(value);
  if (count === null || count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    return;
  }
  return Number(count);
}

type SessionEventEvidence = {
  contributions: BranchCostEvidenceContribution[];
  windowedSpend?: Map<string, ResolvedSessionSpend>;
};

type CollectedSessionEventEvidence = {
  evidenceRows: CloudCostEvidenceEvent[];
  eventTokenTotals: CloudEventTokenTotals;
  aggregateSnapshots: Map<string, EventAggregateSnapshot>;
  windowedSpend: Map<string, ResolvedSessionSpend> | undefined;
  evidenceBudgetExceeded: boolean;
};

type EventAggregateSnapshot = {
  count: number | undefined;
  tokenTotal: bigint | undefined;
  costSubtotalUsd: number | null;
  tokenMalformed: boolean;
  costMalformed: boolean;
};

type EvidencePopulationComparison = {
  matches: boolean;
  malformed: boolean;
};

type EventAggregateRow = {
  agentSessionId: string;
  _sum: {
    inputTokens: bigint | null;
    outputTokens: bigint | null;
    cacheReadTokens: bigint | null;
    cacheWriteTokens: bigint | null;
    estimatedCost: { toString(): string } | null;
  };
  _min?: {
    inputTokens?: bigint | null;
    outputTokens?: bigint | null;
    cacheReadTokens?: bigint | null;
    cacheWriteTokens?: bigint | null;
    estimatedCost: { toString(): string } | number | null;
  };
  _count: { _all: number | undefined; estimatedCost?: number };
};

type EventAggregateRawRow = EventAggregateSqlRow | EventAggregateRow;

type EventAggregateSqlRow = {
  agentSessionId: string;
  sumInputTokens: EventAggregateInteger;
  sumOutputTokens: EventAggregateInteger;
  sumCacheReadTokens: EventAggregateInteger;
  sumCacheWriteTokens: EventAggregateInteger;
  sumEstimatedCost: { toString(): string } | null;
  minInputTokens: EventAggregateInteger;
  minOutputTokens: EventAggregateInteger;
  minCacheReadTokens: EventAggregateInteger;
  minCacheWriteTokens: EventAggregateInteger;
  minEstimatedCost: { toString(): string } | number | null;
  estimatedCostCount: EventAggregateInteger;
  eventCount: EventAggregateInteger;
};

type EventAggregateInteger = bigint | number | { toString(): string } | null;

/** Preserve small chunks for the bounded provenance sample query. */
export const SESSION_USAGE_COST_EVIDENCE_SESSION_CHUNK_SIZE = 1000;

/** Numeric-only aggregate chunks avoid extra round trips on metrics-card reads. */
export const SESSION_USAGE_AGGREGATE_ONLY_SESSION_CHUNK_SIZE = 5000;
