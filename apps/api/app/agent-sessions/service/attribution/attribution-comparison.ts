/**
 * ISS-12552: the attribution rollout gate's evidence,
 * globally and per organization: each session link classified with the flag
 * off and on, with the evidence behind every disagreement; what the flag
 * would drop, by why; sessions without evidence, by whether they can still
 * get it; API-key writes outside MCP, attributed or not; correlation coverage
 * by harness and version; and the kernel allocation with conserved totals.
 *
 * Runs with no request user, so it never evaluates the flag: the caller
 * states it (ISS-8196, no PostHog person).
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  OperationKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { Prisma, withDb } from "@repo/database";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { z } from "zod";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { readInIdChunks } from "@/lib/session-pr-links-chunking";
import {
  countReceiptBinds,
  emptyReceiptBindCounts,
  type ReceiptBindCounts,
} from "./attribution-comparison-binds";
import {
  absentEvidenceGroup,
  type ComparisonEvidence,
  type ComparisonLink,
  type ComparisonSection,
  compareLink,
  emptySection,
  recordLink,
} from "./attribution-comparison-classify";
import { allocateSessionUsage } from "./session-allocation-service";

const LINK_PAGE_SIZE = 1000;
const RECEIPTED_KINDS: readonly string[] = [
  OperationKind.Create,
  OperationKind.CreateVersion,
  OperationKind.UpdateFields,
  OperationKind.Comment,
];

type ApiKeyWriteCounts = {
  total: number;
  attributed: number;
  unattributed: number;
};

/** The route key for a receipt written before receipts recorded a route. */
export const UNRECORDED_RECEIPT_ROUTE = "unrecorded";

export type ReportSection = ComparisonSection & {
  /**
   * ISS-12552: every API-key write outside MCP, writes with no artifact
   * target included, and the same counts by the route that took them.
   */
  apiKeyWrites: ApiKeyWriteCounts & {
    byRoute: Record<string, ApiKeyWriteCounts>;
  };
  correlationCoverage: Record<
    string,
    { sessions: number; writeClaims: number; bound: number; unbound: number }
  >;
  /** Bound receipts by how they were joined to their claim. */
  receiptBinds: ReceiptBindCounts;
  /**
   * Cloud token events the allocation's source-identity dedupe sets aside: a
   * Claude entry another session of the same owner holds (pre-revision-110
   * fork copies, and any an older Desktop sent). The other cost reads still
   * count them until ISS-12744 removes them there.
   */
  duplicateTokenEvents: { ownedElsewhere: number; tied: number };
  allocation: {
    sessions: number;
    failures: Record<string, number>;
    totalTokens: number;
    provenTokens: number;
    estimatedTokens: number;
    unattributedTokens: number;
    totalMicros: number;
    allocatedMicros: number;
    /** Tokens allocated with no cost (PRD-800). */
    unpricedTokens: number;
    /** Tokens with a stored cost on a model the engine cannot price, priced at a per-model uniform rate. */
    uniformRateTokens: number;
    /** Stored cost, in micro-dollars, on those events. */
    uniformRateMicros: number;
    /** Session stored cost minus allocated per-event cost, where both are known. */
    sessionCostGapMicros: number;
    /** Sessions where every event lacks a stored cost, so cost is null. */
    sessionsWithoutCost: number;
  };
};

export type AttributionComparisonReport = {
  generatedAt: string;
  receiptsEpoch: string | null;
  global: ReportSection;
  organizations: Record<string, ReportSection>;
};

export async function buildAttributionComparisonReport(options: {
  organizationIds?: readonly string[];
  /** Sessions allocated per organization; omit to allocate every one. */
  allocationLimit?: number;
  /** When receipts began; defaults to the earliest receipt stored. */
  receiptsEpoch?: Date;
}): Promise<AttributionComparisonReport> {
  const receiptsEpoch =
    options.receiptsEpoch === undefined
      ? (
          await withDb((db) =>
            db.artifactOperationReceipt.findFirst({
              orderBy: { createdAt: "asc" },
              select: { createdAt: true },
            })
          )
        )?.createdAt
      : options.receiptsEpoch;
  const organizationIds =
    options.organizationIds ?? (await organizationsWithSessions());
  const global = emptyReportSection();
  const organizations: Record<string, ReportSection> = {};
  for (const organizationId of [...organizationIds].sort()) {
    const section = emptyReportSection();
    organizations[organizationId] = section;
    const sections = [section, global];
    await compareLinks(organizationId, receiptsEpoch ?? null, sections);
    await countApiKeyWrites(organizationId, sections);
    await countCorrelation(organizationId, sections);
    await countReceiptBinds(organizationId, sections);
    await countDuplicateTokenEvents(organizationId, sections);
    await allocateSessions(organizationId, sections, options.allocationLimit);
  }
  return {
    generatedAt: new Date().toISOString(),
    receiptsEpoch: receiptsEpoch?.toISOString() ?? null,
    global,
    organizations,
  };
}

function emptyReportSection(): ReportSection {
  return {
    ...emptySection(),
    apiKeyWrites: { total: 0, attributed: 0, unattributed: 0, byRoute: {} },
    correlationCoverage: {},
    receiptBinds: emptyReceiptBindCounts(),
    duplicateTokenEvents: { ownedElsewhere: 0, tied: 0 },
    allocation: {
      sessions: 0,
      failures: {},
      totalTokens: 0,
      provenTokens: 0,
      estimatedTokens: 0,
      unattributedTokens: 0,
      totalMicros: 0,
      allocatedMicros: 0,
      unpricedTokens: 0,
      uniformRateTokens: 0,
      uniformRateMicros: 0,
      sessionCostGapMicros: 0,
      sessionsWithoutCost: 0,
    },
  };
}

async function organizationsWithSessions(): Promise<string[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { type: ArtifactType.Session },
      distinct: ["organizationId"],
      select: { organizationId: true },
    })
  );
  return rows.map((row) => row.organizationId);
}

async function compareLinks(
  organizationId: string,
  receiptsEpoch: Date | null,
  sections: readonly ReportSection[]
): Promise<void> {
  const absentSessions = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page: (ComparisonLink & { id: string })[] = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          linkType: LinkType.RelatesTo,
          source: { is: { organizationId, type: ArtifactType.Session } },
        },
        orderBy: { id: "asc" },
        take: LINK_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          sourceId: true,
          targetId: true,
          linkType: true,
          branchParticipation: true,
          metadata: true,
        },
      })
    );
    const evidence = await evidenceForPage(organizationId, page);
    for (const link of page) {
      const rows = evidence.get(`${link.sourceId}\u0000${link.targetId}`) ?? [];
      const comparison = compareLink(link, rows);
      recordLink(sections, link, rows, comparison);
      if (comparison.drop === "absentEvidence") {
        absentSessions.add(link.sourceId);
      }
    }
    cursor = page.at(-1)?.id;
    if (page.length < LINK_PAGE_SIZE) {
      break;
    }
  }
  await groupAbsentSessions(
    organizationId,
    [...absentSessions],
    receiptsEpoch,
    sections
  );
}

async function evidenceForPage(
  organizationId: string,
  links: readonly ComparisonLink[]
): Promise<Map<string, ComparisonEvidence[]>> {
  if (links.length === 0) {
    return new Map();
  }
  const rows = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: {
        organizationId,
        agentSessionId: {
          in: [...new Set(links.map((link) => link.sourceId))],
        },
        targetArtifactId: {
          in: [...new Set(links.map((link) => link.targetId))],
        },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        agentSessionId: true,
        targetArtifactId: true,
        relationshipKind: true,
        outcome: true,
        source: true,
      },
    })
  );
  const byPair = new Map<string, ComparisonEvidence[]>();
  for (const { agentSessionId, targetArtifactId, ...row } of rows) {
    const key = `${agentSessionId}\u0000${targetArtifactId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), row]);
  }
  return byPair;
}

async function groupAbsentSessions(
  organizationId: string,
  sessionIds: readonly string[],
  receiptsEpoch: Date | null,
  sections: readonly ReportSection[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  // One budget for the three sibling fan-outs, so they cannot stack.
  const limiter = createDbFanoutLimiter();
  const [details, snapshots, transcripts] = await Promise.all([
    readInIdChunks(
      sessionIds,
      (chunk) =>
        withDb((db) =>
          db.sessionDetail.findMany({
            where: { artifactId: { in: chunk }, artifact: { organizationId } },
            select: { artifactId: true, lastSyncedAt: true },
          })
        ),
      limiter
    ),
    readInIdChunks(
      sessionIds,
      (chunk) =>
        withDb((db) =>
          db.agentSessionOperationEvidenceSnapshot.findMany({
            where: { organizationId, agentSessionId: { in: chunk } },
            select: { agentSessionId: true },
          })
        ),
      limiter
    ),
    readInIdChunks(
      sessionIds,
      (chunk) =>
        withDb((db) =>
          db.sessionTranscript.findMany({
            where: { organizationId, sessionDetailId: { in: chunk } },
            distinct: ["sessionDetailId"],
            select: { sessionDetailId: true },
          })
        ),
      limiter
    ),
  ]);
  const withSnapshot = new Set(snapshots.map((row) => row.agentSessionId));
  const withTranscript = new Set(
    transcripts.flatMap((row) => row.sessionDetailId ?? [])
  );
  for (const detail of details) {
    const group = absentEvidenceGroup({
      hasEvidenceSnapshot: withSnapshot.has(detail.artifactId),
      // When the cloud last took a sync for the session. session_updated_at
      // also moves on OTEL, enrichment and sync bookkeeping, so it cannot
      // tell a not-yet-upgraded Desktop from history before receipts.
      syncedAt: detail.lastSyncedAt,
      hasCloudTranscript: withTranscript.has(detail.artifactId),
      receiptsEpoch,
    });
    for (const section of sections) {
      section.absentEvidenceSessions[group] += 1;
    }
  }
}

/** Writes made with an API key outside MCP: from shells and scripts. */
async function countApiKeyWrites(
  organizationId: string,
  sections: readonly ReportSection[]
): Promise<void> {
  const [totals, attributions] = await Promise.all([
    withDb((db) =>
      db.artifactOperationReceipt.groupBy({
        by: ["route"],
        where: { organizationId, source: OperationSource.Api },
        _count: { _all: true },
      })
    ),
    withDb((db) =>
      db.$queryRaw<{ route: string | null; count: number }[]>(Prisma.sql`
        SELECT receipt.route, count(*)::int AS count
        FROM agent_session_operation_evidence evidence
        JOIN artifact_operation_receipts receipt ON receipt.id = evidence.receipt_id
        WHERE evidence.organization_id = ${organizationId}::uuid
          AND receipt.organization_id = ${organizationId}::uuid
          AND receipt.source = ${OperationSource.Api}
        GROUP BY receipt.route
      `)
    ),
  ]);
  const attributedByRoute = new Map(
    attributions.map((row) => [
      row.route ?? UNRECORDED_RECEIPT_ROUTE,
      row.count,
    ])
  );
  for (const row of totals) {
    const route = row.route ?? UNRECORDED_RECEIPT_ROUTE;
    addApiKeyWrites(
      sections,
      route,
      row._count._all,
      attributedByRoute.get(route) ?? 0
    );
  }
}

const coverageSchema = z
  .object({ harness: z.string(), harnessVersion: z.string().optional() })
  .loose();

async function countCorrelation(
  organizationId: string,
  sections: readonly ReportSection[]
): Promise<void> {
  const [snapshots, claims] = await Promise.all([
    withDb((db) =>
      db.agentSessionOperationEvidenceSnapshot.findMany({
        where: { organizationId },
        select: { agentSessionId: true, coverage: true },
      })
    ),
    withDb((db) =>
      db.agentSessionOperationEvidence.groupBy({
        by: ["agentSessionId"],
        where: {
          organizationId,
          source: OperationSource.Mcp,
          operationKind: { in: [...RECEIPTED_KINDS] },
        },
        _count: { _all: true, receiptId: true },
      })
    ),
  ]);
  const claimsBySession = new Map(
    claims.map((row) => [row.agentSessionId, row._count])
  );
  for (const snapshot of snapshots) {
    const coverage = coverageSchema.safeParse(snapshot.coverage).data;
    const key = `${coverage?.harness ?? "unknown"}@${coverage?.harnessVersion ?? "unknown"}`;
    const counted = claimsBySession.get(snapshot.agentSessionId);
    for (const section of sections) {
      const entry = section.correlationCoverage[key] ?? {
        sessions: 0,
        writeClaims: 0,
        bound: 0,
        unbound: 0,
      };
      section.correlationCoverage[key] = entry;
      entry.sessions += 1;
      entry.writeClaims += counted?._all ?? 0;
      entry.bound += counted?.receiptId ?? 0;
      entry.unbound += (counted?._all ?? 0) - (counted?.receiptId ?? 0);
    }
  }
}

async function allocateSessions(
  organizationId: string,
  sections: readonly ReportSection[],
  limit: number | undefined
): Promise<void> {
  const sessions = await withDb((db) =>
    db.agentSessionOperationEvidenceSnapshot.findMany({
      where: { organizationId },
      orderBy: { agentSessionId: "asc" },
      ...(limit === undefined ? {} : { take: Math.max(0, limit) }),
      select: { agentSessionId: true },
    })
  );
  for (const { agentSessionId } of sessions) {
    const result = await allocateSessionUsage({
      organizationId,
      agentSessionId,
    });
    for (const section of sections) {
      const allocation = section.allocation;
      allocation.sessions += 1;
      if (!result.ok) {
        allocation.failures[result.error.kind] =
          (allocation.failures[result.error.kind] ?? 0) + 1;
        continue;
      }
      const { allocation: tokens, priced, coverage } = result.value;
      allocation.unpricedTokens += coverage.unpricedTokens;
      allocation.uniformRateTokens += coverage.uniformRate.tokens;
      allocation.uniformRateMicros += coverage.uniformRate.micros;
      allocation.sessionCostGapMicros += coverage.sessionCostGapMicros ?? 0;
      allocation.totalTokens += tokens.totalTokens;
      allocation.unattributedTokens += tokens.unattributedTokens;
      for (const recipient of tokens.recipients) {
        allocation.provenTokens += recipient.provenTokens;
        allocation.estimatedTokens += recipient.estimatedTokens;
      }
      if (!priced) {
        allocation.sessionsWithoutCost += 1;
        continue;
      }
      allocation.totalMicros += coverage.allocatedCostMicros ?? 0;
      allocation.allocatedMicros += priced.recipients.reduce(
        (sum, share) => sum + share.provenMicros + share.estimatedMicros,
        priced.unattributedMicros
      );
    }
  }
}

/**
 * The events `readUsageOwnedElsewhere` matches, counted for a whole
 * organization at once, for the same owner. A copy of the session (same
 * harness and external session id) on a lower compute target holds the same
 * external event id: owned elsewhere, never tied (PRD-800). Any other session holds the same Claude
 * entry uuid: owned elsewhere when it started earlier, tied when it started at
 * the same instant and none earlier.
 */
async function countDuplicateTokenEvents(
  organizationId: string,
  sections: readonly ReportSection[]
): Promise<void> {
  const [row] = await withDb(
    (db) => db.$queryRaw<{ ownedElsewhere: bigint; tied: bigint }[]>`
      SELECT
        count(*) FILTER (WHERE earlier) AS "ownedElsewhere",
        count(*) FILTER (WHERE NOT earlier) AS tied
      FROM (
        SELECT event.id,
          bool_or(
            relation.is_copy
              OR other_session.session_started_at < own.session_started_at
          ) AS earlier
        FROM agent_session_token_events AS event
        JOIN artifacts AS own_artifact
          ON own_artifact.id = event.agent_session_id
        JOIN session_detail AS own
          ON own.artifact_id = own_artifact.id
        JOIN agent_session_token_events AS other
          ON other.agent_session_id <> event.agent_session_id
          AND (
            other.source_identity = event.source_identity
            OR other.external_event_id = event.external_event_id
          )
        JOIN artifacts AS other_artifact
          ON other_artifact.id = other.agent_session_id
        JOIN session_detail AS other_session
          ON other_session.artifact_id = other_artifact.id
        CROSS JOIN LATERAL (
          SELECT other_session.harness = own.harness
            AND other_session.external_session_id = own.external_session_id
            AS is_copy
        ) AS relation
        WHERE own_artifact.organization_id = ${organizationId}::uuid
          AND other_artifact.organization_id = ${organizationId}::uuid
          AND other_artifact.created_by_id = own_artifact.created_by_id
          AND CASE
            WHEN relation.is_copy
              THEN other_session.compute_target_id < own.compute_target_id
                AND other.external_event_id = event.external_event_id
            ELSE other_session.session_started_at <= own.session_started_at
              AND other.source_identity = event.source_identity
              AND event.source_identity ->> 'availability' = ${TokenSourceIdentityAvailability.Available}
              AND event.source_identity ->> 'scheme' = ${claudeTranscriptEntryUuidScheme}
          END
        GROUP BY event.id
      ) AS duplicates
    `
  );
  for (const section of sections) {
    section.duplicateTokenEvents.ownedElsewhere += Number(
      row?.ownedElsewhere ?? 0
    );
    section.duplicateTokenEvents.tied += Number(row?.tied ?? 0);
  }
}

function addApiKeyWrites(
  sections: readonly ReportSection[],
  route: string,
  total: number,
  attributed: number
): void {
  for (const section of sections) {
    const counts = section.apiKeyWrites;
    counts.total += total;
    counts.attributed += attributed;
    counts.unattributed += total - attributed;
    counts.byRoute[route] ??= { total: 0, attributed: 0, unattributed: 0 };
    const byRoute = counts.byRoute[route];
    byRoute.total += total;
    byRoute.attributed += attributed;
    byRoute.unattributed += total - attributed;
  }
}
