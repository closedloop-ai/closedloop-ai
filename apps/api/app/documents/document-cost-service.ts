import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  DOCUMENT_COST_BATCH_SIZE,
  type DocumentCost,
  type DocumentCostsRequest,
  type DocumentCostsResponse,
  documentCostsResponseSchema,
} from "@repo/api/src/types/document-costs";
import {
  DOCUMENT_METRIC_TREND_DAYS,
  documentMetricTrendStart,
} from "@repo/api/src/types/document-list-summary";
import { RELATED_SESSION_ELIGIBLE_KINDS } from "@repo/api/src/types/provenance-relationship";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  classifySessionLinkKind,
  sessionProvenanceLinkWhere,
} from "@/app/agent-sessions/service/provenance-eligibility";
import { chunksOf } from "@/lib/chunks-of";
import { toNumber } from "@/lib/prisma-number";
import {
  aggregateCostTrendlines,
  type DocumentCostPopulation,
  foldDocumentCost,
  foldDocumentTrendline,
  InvalidCostEvidenceReason,
  summarizeCostCoverage,
} from "./document-cost-coverage";

export const documentCostService = {
  /** Costs for the requested document ids. */
  read(
    organizationId: string,
    request: Omit<DocumentCostsRequest, "scope">
  ): Promise<DocumentCostsResponse> {
    return readCostBatch(organizationId, request, new Date());
  },

  /**
   * ISS-12600: costs over a scoped population the caller resolved from the
   * request's scope in one snapshot (`documentCostScopeService`).
   */
  readPopulation(
    organizationId: string,
    request: DocumentCostsRequest,
    artifactIds: readonly string[],
    now: Date
  ): Promise<DocumentCostsResponse> {
    return readScopedCosts(organizationId, request, now, artifactIds);
  },
};

/** Every document id `where` matches, read in id-ordered pages. */
export async function readDocumentCostPopulation(
  where: Prisma.ArtifactWhereInput
): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | undefined;
  while (true) {
    const page = await withDb((db) =>
      db.artifact.findMany({
        where,
        select: { id: true },
        orderBy: { id: "asc" },
        take: DOCUMENT_COST_BATCH_SIZE,
        ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      })
    );
    ids.push(...page.map((row) => row.id));
    afterId = page.at(-1)?.id;
    if (page.length < DOCUMENT_COST_BATCH_SIZE) {
      return ids;
    }
  }
}

async function readCostBatch(
  organizationId: string,
  request: DocumentCostsRequest,
  now: Date
): Promise<DocumentCostsResponse> {
  const evidence = await collectCostEvidence(organizationId, request, now);
  foldDocuments(evidence);
  return documentCostsResponseSchema.parse({
    trendlines: aggregateEvidenceTrendlines(now, evidence),
    sessionCosts: sessionCostRows(evidence),
    artifacts: artifactCostRows(evidence),
  });
}

async function readSessionCosts(
  organizationId: string,
  sessionIds: string[],
  window: DocumentCostsRequest,
  evidence: CostEvidence,
  now: Date
) {
  const where: Prisma.SessionDetailWhereInput = {
    artifactId: { in: sessionIds },
    artifact: { is: { organizationId } },
  };
  const sessions = await withDb((db) =>
    db.sessionDetail.findMany({
      where,
      select: {
        artifactId: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
  const eventWhere: Prisma.AgentSessionTokenEventWhereInput = {
    agentSessionId: { in: sessionIds },
    session: { is: where },
  };
  // Lifetime counters establish coverage only. They never contribute dollars.
  const coverage = await withDb((db) =>
    db.agentSessionTokenEvent.groupBy({
      by: ["agentSessionId"],
      where: eventWhere,
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    })
  );
  const windowed = await withDb((db) =>
    db.agentSessionTokenEvent.groupBy({
      by: ["agentSessionId", "costCompleteness"],
      where: {
        ...eventWhere,
        eventCreatedAt: {
          ...(window.startDate ? { gte: new Date(window.startDate) } : {}),
          ...(window.endDate ? { lt: new Date(window.endDate) } : {}),
        },
      },
      _sum: { estimatedCost: true },
      _min: { estimatedCost: true },
      _count: { _all: true, estimatedCost: true },
    })
  );
  const coverageById = new Map(
    coverage.map((row) => [row.agentSessionId, row._sum])
  );
  const windowCosts = foldWindowCosts(organizationId, windowed);
  const daily = await readDailySessionCosts(organizationId, sessionIds, now);
  for (const session of sessions) {
    const hasCoverage = sessionHasCoverage(
      organizationId,
      session,
      coverageById.get(session.artifactId)
    );
    evidence.trends.set(
      session.artifactId,
      sessionTrendline(hasCoverage, daily.get(session.artifactId))
    );
    if (hasCoverage) {
      const cost = windowCosts.has(session.artifactId)
        ? windowCosts.get(session.artifactId)
        : 0;
      evidence.costs.set(session.artifactId, cost);
    } else {
      evidence.costs.set(session.artifactId, undefined);
    }
  }
}

const TOKEN_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

async function readScopedCosts(
  organizationId: string,
  request: DocumentCostsRequest,
  now: Date,
  artifactIds: readonly string[]
): Promise<DocumentCostsResponse> {
  const population = emptyCostEvidence([], new Map());
  for (const pageIds of chunksOf(artifactIds, DOCUMENT_COST_BATCH_SIZE)) {
    mergeCostEvidence(
      population,
      await collectCostEvidence(
        organizationId,
        {
          artifactIds: pageIds,
          startDate: request.startDate,
          endDate: request.endDate,
        },
        now,
        pageIds
      )
    );
  }
  // One fold over the merged pages, so a session re-read on a later page
  // cannot leave documents folded from different evidence.
  foldDocuments(population);
  const summary = summarizeCostCoverage(
    population,
    (artifactId) => population.documentCosts.get(artifactId),
    (sessionId) => population.costs.get(sessionId)
  );
  return documentCostsResponseSchema.parse({
    ...exactCostEvidence(request, population),
    trendlines: aggregateEvidenceTrendlines(now, population),
    coverage: summary.coverage,
    ...optionalCost("totalEstimatedCost", summary.total),
    ...optionalCost("medianEstimatedCost", summary.median),
    ...optionalCost(
      "measuredSubsetTotalEstimatedCost",
      summary.measuredSubsetTotal
    ),
    ...optionalCost(
      "measuredSubsetMedianEstimatedCost",
      summary.measuredSubsetMedian
    ),
  });
}

/**
 * UTC event activity for the same sessions over the sparkline's own 14 days;
 * coverage is checked by the caller. The list's date window bounds the totals,
 * not this read, so no bin outside the window reads as a measured zero.
 */
async function readDailySessionCosts(
  organizationId: string,
  sessionIds: string[],
  now: Date
) {
  const start = documentMetricTrendStart(now);
  const trends = new Map(sessionIds.map((id) => [id, zeroTrendline()]));
  if (sessionIds.length === 0) {
    return trends;
  }
  const bins = await withDb((db) =>
    db.$queryRaw<DailyCostBin[]>(
      dailySessionCostsSql(organizationId, sessionIds, start, now)
    )
  );
  for (const bin of bins) {
    addDailyCost(trends, bin, organizationId);
  }
  return trends;
}

function zeroTrendline(): (number | null)[] {
  return new Array(DOCUMENT_METRIC_TREND_DAYS).fill(0);
}

function unknownTrendline(): (number | null)[] {
  return new Array(DOCUMENT_METRIC_TREND_DAYS).fill(null);
}

function sessionTrendline(
  covered: boolean,
  daily: (number | null)[] | undefined
) {
  return covered ? (daily ?? zeroTrendline()) : unknownTrendline();
}

function addDailyCost(
  trends: Map<string, (number | null)[]>,
  bin: DailyCostBin,
  organizationId: string
) {
  const values = trends.get(bin.agentSessionId);
  if (!values || bin.day < 0 || bin.day >= values.length) {
    return;
  }
  if (bin.invalidEventId !== null) {
    reportInvalidCostEvidence(organizationId, {
      tokenEventId: bin.invalidEventId,
    });
    values[bin.day] = null;
    return;
  }
  if (!bin.measured || bin.cost === null) {
    values[bin.day] = null;
    return;
  }
  values[bin.day] = toNumber(bin.cost);
}

function exactCostEvidence(
  request: DocumentCostsRequest,
  evidence: CostEvidence
) {
  if (request.scope?.artifactIds === undefined) {
    return { artifacts: [] };
  }
  return {
    artifacts: artifactCostRows(evidence),
    sessionCosts: sessionCostRows(evidence),
  };
}

type DailyCostBin = {
  agentSessionId: string;
  day: number;
  cost: Prisma.Decimal | null;
  measured: boolean;
  invalidEventId: string | null;
};

/**
 * One row per session per UTC day. `measured` is false when any event that day
 * is not Complete or is unpriced; COALESCE keeps a NULL completeness from being
 * skipped by BOOL_AND. Org isolation enters through session_detail → artifacts,
 * as token events carry no organization of their own.
 */
function dailySessionCostsSql(
  organizationId: string,
  sessionIds: string[],
  start: Date,
  now: Date
): Prisma.Sql {
  const startAt = start.toISOString();
  return Prisma.sql`
    SELECT
      e.agent_session_id::text AS "agentSessionId",
      FLOOR(
        EXTRACT(EPOCH FROM (e.event_created_at - ${startAt}::timestamp)) / 86400
      )::int AS day,
      SUM(e.estimated_cost) AS cost,
      BOOL_AND(
        COALESCE(
          e.cost_completeness = ${TokenCostCompleteness.Complete}
            AND e.estimated_cost IS NOT NULL,
          false
        )
      ) AS measured,
      MIN(e.id::text) FILTER (
        WHERE e.cost_completeness = ${TokenCostCompleteness.Complete}
          AND (
            e.estimated_cost < 0
            OR e.estimated_cost = 'NaN'::numeric
          )
      ) AS "invalidEventId"
    FROM agent_session_token_events e
    JOIN session_detail sd ON sd.artifact_id = e.agent_session_id
    JOIN artifacts a
      ON a.id = sd.artifact_id
      AND a.organization_id = ${organizationId}::uuid
    WHERE e.agent_session_id = ANY(${sessionIds}::uuid[])
      AND e.event_created_at >= ${startAt}::timestamp
      AND e.event_created_at < ${now.toISOString()}::timestamp
    GROUP BY 1, 2
  `;
}

async function collectCostEvidence(
  organizationId: string,
  request: DocumentCostsRequest,
  now: Date,
  scopedArtifactIds?: string[]
): Promise<CostEvidence> {
  const artifacts = scopedArtifactIds
    ? scopedArtifactIds.map((id) => ({ id }))
    : await withDb((db) =>
        db.artifact.findMany({
          where: {
            organizationId,
            id: { in: [...new Set(request.artifactIds)] },
            type: ArtifactType.Document,
            subtype: {
              in: [
                DocumentType.Prd,
                DocumentType.ImplementationPlan,
                DocumentType.Doc,
                DocumentType.Feature,
              ],
            },
          },
          select: { id: true },
        })
      );
  const artifactIds = artifacts.map((artifact) => artifact.id);
  const links =
    artifactIds.length === 0
      ? []
      : await withDb((db) =>
          db.artifactLink.findMany({
            where: sessionProvenanceLinkWhere(
              organizationId,
              artifactIds,
              RELATED_SESSION_ELIGIBLE_KINDS
            ),
            select: {
              sourceId: true,
              targetId: true,
              linkType: true,
              branchParticipation: true,
              metadata: true,
            },
          })
        );
  const sessionsByArtifact = new Map(
    artifactIds.map((id) => [id, new Set<string>()])
  );
  for (const link of links) {
    if (
      RELATED_SESSION_ELIGIBLE_KINDS.includes(classifySessionLinkKind(link))
    ) {
      sessionsByArtifact.get(link.targetId)?.add(link.sourceId);
    }
  }
  const evidence = emptyCostEvidence(artifactIds, sessionsByArtifact);
  // Serial chunks bound both the IN predicates and pool acquisition.
  for (const chunk of chunksOf(
    populationSessionIds(evidence),
    DOCUMENT_COST_BATCH_SIZE
  )) {
    await readSessionCosts(organizationId, chunk, request, evidence, now);
  }
  return evidence;
}

/** Folds each document's cost and daily spend once for every consumer. */
function foldDocuments(evidence: CostEvidence) {
  for (const artifactId of evidence.artifactIds) {
    const sessions = evidence.sessionsByArtifact.get(artifactId) ?? new Set();
    evidence.documentCosts.set(
      artifactId,
      foldDocumentCost(sessions, (sessionId) => evidence.costs.get(sessionId))
    );
    evidence.documentTrends.set(
      artifactId,
      foldDocumentTrendline(sessions, evidence.trends)
    );
  }
}

function foldWindowCosts(
  organizationId: string,
  rows: WindowedCostRow[]
): Map<string, number | undefined> {
  const windowCosts = new Map<string, number | undefined>();
  for (const row of rows) {
    const complete = row.costCompleteness === TokenCostCompleteness.Complete;
    const missingPrice = row._count.estimatedCost !== row._count._all;
    const sum = toNumber(row._sum.estimatedCost);
    // Checked over the priced events alone, so a missing price elsewhere in
    // the window cannot hide a known-corrupt one; the total stays unknown.
    const invalid =
      complete &&
      (!Number.isFinite(sum) || toNumber(row._min.estimatedCost) < 0);
    if (invalid) {
      reportInvalidCostEvidence(organizationId, {
        agentSessionId: row.agentSessionId,
        reason: InvalidCostEvidenceReason.WindowCost,
      });
    }
    if (
      !complete ||
      missingPrice ||
      invalid ||
      (windowCosts.has(row.agentSessionId) &&
        windowCosts.get(row.agentSessionId) === undefined)
    ) {
      windowCosts.set(row.agentSessionId, undefined);
    } else {
      windowCosts.set(
        row.agentSessionId,
        (windowCosts.get(row.agentSessionId) ?? 0) + sum
      );
    }
  }
  return windowCosts;
}

function sessionHasCoverage(
  organizationId: string,
  session: SessionCounters & {
    artifactId: string;
    estimatedCost: Prisma.Decimal | null;
  },
  held: Partial<Record<TokenCounter, bigint | null>> | undefined
): boolean {
  const negative = TOKEN_COUNTERS.find(
    (key) => session[key] < 0n || (held?.[key] ?? 0n) < 0n
  );
  if (negative !== undefined) {
    reportInvalidCostEvidence(organizationId, {
      agentSessionId: session.artifactId,
      reason: InvalidCostEvidenceReason.NegativeTokenCounter,
      tokenCounter: negative,
    });
    return false;
  }
  const covered = TOKEN_COUNTERS.every(
    (key) => (held?.[key] ?? 0n) === session[key]
  );
  const noTokenEvidence =
    held === undefined &&
    (session.estimatedCost === null || toNumber(session.estimatedCost) > 0);
  return covered && !noTokenEvidence;
}

/**
 * Routes impossible cost evidence to the existing monitored log event. Each
 * detecting read logs on its own, so one bad event can log from both the
 * window and the daily read.
 */
function reportInvalidCostEvidence(
  organizationId: string,
  details:
    | { tokenEventId: string }
    | {
        agentSessionId: string;
        reason: InvalidCostEvidenceReason;
        tokenCounter?: TokenCounter;
      }
) {
  log.error("[document-cost] Invalid token-event cost", {
    organizationId,
    ...details,
  });
}

function emptyCostEvidence(
  artifactIds: string[],
  sessionsByArtifact: Map<string, Set<string>>
): CostEvidence {
  return {
    artifactIds,
    sessionsByArtifact,
    costs: new Map(),
    trends: new Map(),
    documentCosts: new Map(),
    documentTrends: new Map(),
  };
}

function mergeCostEvidence(target: CostEvidence, page: CostEvidence) {
  target.artifactIds.push(...page.artifactIds);
  for (const [artifactId, sessions] of page.sessionsByArtifact) {
    target.sessionsByArtifact.set(artifactId, sessions);
  }
  for (const [sessionId, cost] of page.costs) {
    target.costs.set(sessionId, cost);
  }
  for (const [sessionId, trend] of page.trends) {
    target.trends.set(sessionId, trend);
  }
}

function aggregateEvidenceTrendlines(now: Date, evidence: CostEvidence) {
  return aggregateCostTrendlines(
    now,
    evidence,
    evidence.trends,
    evidence.documentTrends
  );
}

function populationSessionIds(population: DocumentCostPopulation): string[] {
  return [
    ...new Set(
      population.artifactIds.flatMap((id) => [
        ...(population.sessionsByArtifact.get(id) ?? []),
      ])
    ),
  ];
}

function artifactCostRows(evidence: CostEvidence): DocumentCost[] {
  return evidence.artifactIds.map((artifactId) => {
    const totalEstimatedCost = evidence.documentCosts.get(artifactId);
    return {
      artifactId,
      ...(totalEstimatedCost === undefined ? {} : { totalEstimatedCost }),
      trendline: evidence.documentTrends.get(artifactId) ?? unknownTrendline(),
    };
  });
}

function sessionCostRows(evidence: CostEvidence) {
  return populationSessionIds(evidence).map((sessionId) => {
    const totalEstimatedCost = evidence.costs.get(sessionId);
    return {
      sessionId,
      trendline: evidence.trends.get(sessionId) ?? unknownTrendline(),
      ...(totalEstimatedCost === undefined ? {} : { totalEstimatedCost }),
    };
  });
}

function optionalCost<K extends OptionalCostKey>(
  key: K,
  value: number | null
): Partial<Pick<DocumentCostsResponse, K>> {
  if (value === null) {
    return {};
  }
  const field: Partial<Pick<DocumentCostsResponse, OptionalCostKey>> = {};
  field[key] = value;
  return field;
}

type OptionalCostKey =
  | "totalEstimatedCost"
  | "medianEstimatedCost"
  | "measuredSubsetTotalEstimatedCost"
  | "measuredSubsetMedianEstimatedCost";

type CostEvidence = DocumentCostPopulation & {
  costs: Map<string, number | undefined>;
  trends: Map<string, (number | null)[]>;
  documentCosts: Map<string, number | undefined>;
  documentTrends: Map<string, (number | null)[]>;
};

type TokenCounter = (typeof TOKEN_COUNTERS)[number];
type SessionCounters = Record<TokenCounter, bigint>;

type WindowedCostRow = {
  agentSessionId: string;
  costCompleteness: string | null;
  _sum: { estimatedCost: Prisma.Decimal | null };
  _min: { estimatedCost: Prisma.Decimal | null };
  _count: { _all: number; estimatedCost: number };
};
