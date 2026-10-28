/**
 * Seeding and read helpers shared by the Branch analytics rollup suites that
 * run against a real Postgres. Every helper joins the ambient
 * `autoRollbackTransaction`, so nothing here outlives the case that called it.
 */
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import {
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { readMaterializedBranchEventAggregates } from "@/app/branches/branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS,
  type BranchAnalyticsRollupAggregateRow,
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
} from "@/app/branches/branch-analytics-rollup-contract";

export const BATCH_AT = new Date("2026-08-01T12:00:00.000Z");
export const RECEIVED_BEFORE_CUTOFF = new Date("2026-08-01T11:59:00.000Z");
export const RECEIVED_AFTER_CUTOFF = new Date("2026-08-01T12:05:00.000Z");
export const SECOND_BATCH_AT = new Date("2026-08-01T12:06:00.000Z");
/**
 * ISS-12779: when a seeded session was last synced. Earlier than every pass
 * these suites run by more than the receive overlap, so a session reads as
 * synced only in a case that re-syncs it. Left to the schema default it is the
 * wall clock, which is after every injected pass, and every session would be
 * re-materialized on every pass.
 */
export const SEEDED_SYNCED_AT = new Date(
  BATCH_AT.getTime() - 2 * BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS
);
export type SeededEvent = {
  externalEventId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  eventCreatedAt: Date;
  createdAt: Date;
};

export type SeededBranchSession = {
  organizationId: string;
  userId: string;
  branchArtifactId: string;
  sessionArtifactId: string;
};

export function buildEvent(input: {
  suffix: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost: number;
  eventCreatedAt: Date;
  /** Receive time. Defaults inside the batch cutoff. */
  createdAt?: Date;
}): SeededEvent {
  return {
    externalEventId: `iss9910-${input.suffix}`,
    model: "claude-opus-5",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    estimatedCost: input.estimatedCost,
    eventCreatedAt: input.eventCreatedAt,
    createdAt: input.createdAt ?? RECEIVED_BEFORE_CUTOFF,
  };
}

export async function seedLinkedBranchSession(input: {
  label: string;
  events: readonly SeededEvent[];
}): Promise<SeededBranchSession> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const branchArtifactId = await seedBranch(organizationId, input.label);
  const sessionArtifactId = await linkValidSessionToBranch({
    organizationId,
    userId: user.id,
    branchArtifactId,
    label: input.label,
    linkKind: SessionArtifactLinkKind.SessionPr,
    lastSyncedAt: SEEDED_SYNCED_AT,
  });
  await seedTokenEvents(sessionArtifactId, input.events);
  return {
    organizationId,
    userId: user.id,
    branchArtifactId,
    sessionArtifactId,
  };
}

export function seedBranch(
  organizationId: string,
  label: string
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `iss9910-${label}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branchName: `iss9910-${label}`,
        firstPushedAt: RECEIVED_BEFORE_CUTOFF,
        pushSource: BranchPushSource.Session,
        lastActivityAt: RECEIVED_BEFORE_CUTOFF,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}

export async function seedTokenEvents(
  sessionArtifactId: string,
  events: readonly SeededEvent[]
): Promise<void> {
  await withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: events.map((event) => ({
        ...event,
        agentSessionId: sessionArtifactId,
      })),
    })
  );
}

export function readRollupRows(organizationId: string) {
  return withDb((db) =>
    db.branchAnalyticsSessionRollup.findMany({
      where: { organizationId },
      orderBy: [{ sessionArtifactId: "asc" }, { bucketStart: "asc" }],
    })
  );
}

export function readAggregates(
  organizationId: string,
  sessionIds: readonly string[],
  now: Date
): Promise<BranchAnalyticsRollupReadResult> {
  return withDb((db) =>
    readMaterializedBranchEventAggregates(
      db,
      organizationId,
      sessionIds,
      undefined,
      now
    )
  );
}

export async function readAvailableAggregates(
  organizationId: string,
  sessionIds: readonly string[],
  now: Date
): Promise<BranchAnalyticsRollupAggregateRow[]> {
  const result = await readAggregates(organizationId, sessionIds, now);
  if (result.status !== BranchAnalyticsRollupReadStatus.Available) {
    throw new Error(
      `expected an available rollup read, got unavailable: ${result.reason}`
    );
  }
  return result.rows;
}

/**
 * Numeric totals for one session. Every column arrives as a Postgres `numeric`
 * or `bigint` (SUM widens both), so each is normalized through one place rather
 * than at each assertion.
 */
export function totalsFor(
  rows: readonly BranchAnalyticsRollupAggregateRow[],
  sessionArtifactId: string
) {
  const row = rows.find((entry) => entry.agentSessionId === sessionArtifactId);
  if (!row) {
    throw new Error(`no rollup aggregate row for session ${sessionArtifactId}`);
  }
  return {
    inputTokens: numeric(row.sumInputTokens),
    outputTokens: numeric(row.sumOutputTokens),
    cacheReadTokens: numeric(row.sumCacheReadTokens),
    cacheWriteTokens: numeric(row.sumCacheWriteTokens),
    estimatedCost: numeric(row.sumEstimatedCost),
    eventCount: numeric(row.eventCount),
  };
}

function numeric(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(String(value));
}
