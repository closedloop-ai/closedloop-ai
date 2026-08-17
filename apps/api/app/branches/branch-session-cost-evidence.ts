import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
  branchCostEvidenceByteBudget,
  branchCostEvidenceRowBudget,
  branchCostSubtotalsReconcile,
} from "@repo/api/src/types/branch-usage";
import {
  accumulateCloudEventTokenTotals,
  applyCloudLifetimeCoverage,
  type CloudCostEvidenceEvent,
  type CloudEventTokenTotals,
  setCloudEventTokenTotal,
  toBranchCostContribution,
} from "./branch-cost-evidence";
import {
  cloudSessionEventWhere,
  readBoundedCloudCostEvidence,
} from "./branch-cost-evidence-reader";
import type {
  LinkedSession,
  SessionUsageClient,
  SessionUsageDateWindow,
  WindowedSessionSpend,
} from "./branch-read-service/session-usage-window";

/** Resolve one coherent, bounded cloud evidence population for Branch usage. */
export async function resolveSessionEventEvidence(
  db: SessionUsageClient,
  organizationId: string,
  sessions: readonly LinkedSession[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<SessionEventEvidence> {
  const windowed = Boolean(dateWindow?.startDate || dateWindow?.endDate);
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
    windowed
  );
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

async function collectSessionEventEvidence(
  db: SessionUsageClient,
  organizationId: string,
  sessions: readonly LinkedSession[],
  dateWindow: SessionUsageDateWindow | undefined,
  windowed: boolean
): Promise<CollectedSessionEventEvidence> {
  const evidenceRows: CloudCostEvidenceEvent[] = [];
  const eventTokenTotals: CloudEventTokenTotals = new Map();
  const aggregateSnapshots = new Map<string, EventAggregateSnapshot>();
  const windowedSpend = windowed
    ? new Map<string, WindowedSessionSpend>()
    : undefined;
  let evidenceBudgetExceeded = false;
  let retainedEvidenceBytes = 0;
  for (
    let start = 0;
    start < sessions.length;
    start += sessionUsageEventSessionChunkSize
  ) {
    const ids = sessions
      .slice(start, start + sessionUsageEventSessionChunkSize)
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
    if (!evidenceBudgetExceeded) {
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
  windowedSpend: Map<string, WindowedSessionSpend> | undefined
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
    windowedSpend.set(row.agentSessionId, {
      inputTokens: Number(tokens.inputTokens),
      outputTokens: Number(tokens.outputTokens),
      cacheReadTokens: Number(tokens.cacheReadTokens),
      cacheWriteTokens: Number(tokens.cacheWriteTokens),
      estimatedCostUsd: numberFromDecimal(row._sum.estimatedCost),
    });
  }
}

async function readEventAggregates(
  db: SessionUsageClient,
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<EventAggregateRow[]> {
  const rows = await db.agentSessionTokenEvent.groupBy({
    by: ["agentSessionId"],
    where: cloudSessionEventWhere(organizationId, [...sessionIds], dateWindow),
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      estimatedCost: true,
    },
    _min: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      estimatedCost: true,
    },
    _count: { _all: true, estimatedCost: true },
  });
  return rows;
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
      (snapshot) => snapshot.tokenTotal === undefined
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

function lifetimeSessionSubtotal(sessions: readonly LinkedSession[]): number {
  return sessions.reduce(
    (total, session) => total + numberFromDecimal(session.estimatedCost),
    0
  );
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

type SessionEventEvidence = {
  contributions: BranchCostEvidenceContribution[];
  windowedSpend?: Map<string, WindowedSessionSpend>;
};

type CollectedSessionEventEvidence = {
  evidenceRows: CloudCostEvidenceEvent[];
  eventTokenTotals: CloudEventTokenTotals;
  aggregateSnapshots: Map<string, EventAggregateSnapshot>;
  windowedSpend: Map<string, WindowedSessionSpend> | undefined;
  evidenceBudgetExceeded: boolean;
};

type EventAggregateSnapshot = {
  count: number;
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
  _count: { _all: number; estimatedCost?: number };
};

const sessionUsageEventSessionChunkSize = 1000;
