/**
 * ISS-12779 — the incremental rollup refresh against a full re-aggregation, on a
 * real Postgres.
 *
 * The cron used to re-aggregate every materialized session every six hours,
 * whether or not it had changed, because that was the only thing that picked up
 * an in-place cost edit. It now re-aggregates a session only when it received an
 * event or was synced since its rows were written. These cases run the
 * incremental passes, then rewrite every session with the full re-aggregation
 * the re-sweep performed (`refreshBranchAnalyticsSessionRollupsTx` over all of
 * them, at the same `as_of`), and require the same rows and the same reads.
 *
 * The clock is injected, as in `branch-analytics-rollup.integration.test.ts`,
 * except in the ingest case: that one runs the real sync path, which stamps the
 * wall clock, so its passes are placed relative to the stamp the ingest wrote.
 */

import { Harness } from "@repo/api/src/types/agent-component";
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  BATCH_AT,
  RECEIVED_BEFORE_CUTOFF,
  SEEDED_SYNCED_AT,
  seedBranch,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-fixtures";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  readMaterializedBranchEventAggregates,
  refreshBranchAnalyticsRollupBatch,
  refreshBranchAnalyticsSessionRollupsTx,
} from "@/app/branches/branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS,
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupDateWindow,
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupUnavailableReason,
} from "@/app/branches/branch-analytics-rollup-contract";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases compare the rows the incremental and the full refresh write, not the per-batch commit boundary; BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS is a production bound no ambient-wrapped case can hold"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Past the six-hour re-sweep the cron used to run, so it would have fired. */
const QUIET_PASS_AT = new Date(BATCH_AT.getTime() + 7 * 60 * 60 * 1000);
const SYNC_AT = new Date(QUIET_PASS_AT.getTime() + 60_000);
const SYNCED_PASS_AT = new Date(SYNC_AT.getTime() + 60_000);

const DAY_1 = "2026-07-29";
const DAY_2 = "2026-07-30";
const DAY_3 = "2026-07-31";

/** Day-aligned, as 742 of 743 measured `/branches` windows are (ISS-9831). */
const WHOLE_DAY_WINDOW: BranchAnalyticsRollupDateWindow = {
  startDate: new Date(`${DAY_1}T00:00:00.000Z`),
  endDate: new Date(`${DAY_1}T23:59:59.999Z`),
};
/**
 * Starts and ends inside a day around one whole day, so the read serves the
 * whole day from rollup rows and both edges from the source events.
 */
const PARTIAL_DAY_WINDOW: BranchAnalyticsRollupDateWindow = {
  startDate: new Date(`${DAY_1}T12:00:00.000Z`),
  endDate: new Date(`${DAY_3}T06:00:00.000Z`),
};

describeIfDb("branch analytics rollup incremental refresh (ISS-12779)", () => {
  it("writes what a full re-aggregation writes after late-arriving and edited events, and never re-aggregates a session nothing changed", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const [writtenBranch, sharedBranch, quietBranch] = await Promise.all([
        seedBranch(organizationId, "iss12779-written"),
        seedBranch(organizationId, "iss12779-shared"),
        seedBranch(organizationId, "iss12779-quiet"),
      ]);
      const seedSession = (label: string, branchArtifactId: string) =>
        linkValidSessionToBranch({
          organizationId,
          userId: user.id,
          branchArtifactId,
          label,
          linkKind: SessionArtifactLinkKind.SessionPr,
          lastSyncedAt: SEEDED_SYNCED_AT,
        });
      const edited = await seedSession("iss12779-edited", writtenBranch);
      // Two branches, so the session carries one row per branch per bucket.
      await linkSessionToBranch(organizationId, edited, sharedBranch);
      const late = await seedSession("iss12779-late", sharedBranch);
      const untouched = await seedSession("iss12779-untouched", quietBranch);
      const malformed = await seedSession("iss12779-malformed", writtenBranch);
      const sessions = [edited, late, untouched, malformed];

      await seedEvents(edited, [
        { id: "e1", at: `${DAY_1}T10:00:00.000Z`, cost: 1.25 },
        { id: "e2", at: `${DAY_1}T15:00:00.000Z`, cost: null },
        { id: "e3", at: `${DAY_2}T09:00:00.000Z`, cost: 0.5 },
        { id: "e4", at: `${DAY_3}T23:59:59.999Z`, cost: 2 },
      ]);
      await seedEvents(late, [
        { id: "l1", at: `${DAY_2}T18:00:00.000Z`, cost: 0.75 },
        { id: "l2", at: `${DAY_3}T02:00:00.000Z`, cost: 0.25 },
      ]);
      await seedEvents(untouched, [
        { id: "u1", at: `${DAY_1}T08:00:00.000Z`, cost: 3 },
        { id: "u2", at: `${DAY_3}T20:00:00.000Z`, cost: 4 },
      ]);
      await seedEvents(malformed, [
        { id: "m1", at: `${DAY_2}T11:00:00.000Z`, cost: 1 },
      ]);

      const first = await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: BATCH_AT,
      });
      expect(first.sessionsRefreshed).toBe(sessions.length);

      // The six-hour re-sweep re-aggregated all four here.
      const quiet = await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: QUIET_PASS_AT,
      });
      expect(quiet.sessionsRefreshed).toBe(0);
      expect(await readSessionAsOf(organizationId)).toEqual(
        new Map(sessions.map((id) => [id, BATCH_AT.getTime()]))
      );

      // What one sync slice does: `updateCostEvidence` reprices in place (and
      // prices an unpriced event), a late event lands in an OLD day, and the
      // slice's detail write stamps `last_synced_at`.
      await repriceEvent(edited, "e1", 1.75);
      await repriceEvent(edited, "e2", 0.4);
      await seedEvents(late, [
        {
          id: "l3",
          at: `${DAY_1}T21:00:00.000Z`,
          cost: 0.6,
          receivedAt: SYNC_AT,
        },
      ]);
      // ISS-10565: one negative cost keeps the whole session out of the rollup.
      await repriceEvent(malformed, "m1", -1);
      await stampSynced([edited, late, malformed], SYNC_AT);

      const synced = await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: SYNCED_PASS_AT,
      });
      expect(synced.sessionsRefreshed).toBe(2);
      expect((await readSessionAsOf(organizationId)).get(untouched)).toBe(
        BATCH_AT.getTime()
      );

      const servable = [edited, late, untouched];
      const incremental = await readEverything(
        organizationId,
        servable,
        sessions
      );

      await withDb.tx((tx) =>
        refreshBranchAnalyticsSessionRollupsTx(tx, {
          organizationId,
          sessionArtifactIds: sessions,
          asOf: SYNCED_PASS_AT,
        })
      );
      const full = await readEverything(organizationId, servable, sessions);

      expect(incremental).toEqual(full);
      // The oracle is a full rewrite, so it cannot be wrong in the same way as
      // the incremental path by accident; these pin the totals regardless.
      expect(costOf(incremental.unwindowed, edited)).toBe("4.65");
      expect(eventsOf(incremental.unwindowed, late)).toBe("3");
      expect(costOf(incremental.unwindowed, untouched)).toBe("7");
      expect(incremental.withMalformed).toEqual({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      });
      expect(
        incremental.rows.filter((row) => row.session === malformed)
      ).toEqual([]);

      // A sync keeps its session queued only until a rewrite lands more than
      // the receive overlap after the stamp. The pass past the overlap still
      // rewrites the two synced sessions (their stored `as_of` is inside it);
      // the one after must rewrite nothing.
      const pastOverlapAt = new Date(
        SYNC_AT.getTime() + BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS + 60_000
      );
      await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: pastOverlapAt,
      });
      const settled = await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: new Date(pastOverlapAt.getTime() + 60_000),
      });
      expect(settled.sessionsRefreshed).toBe(0);
    });
  });

  it("re-materializes a cost correction the real sync ingest made, on the next pass", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        "iss12779-ingest"
      );
      const context = { organizationId, userId: user.id, computeTargetId };
      await agentSessionsService.upsertSessions(
        context,
        buildIngestPayload(INGEST_UPDATED_AT, INGEST_FIRST_COST)
      );
      const firstSync = await withDb((db) =>
        db.sessionDetail.findFirstOrThrow({
          where: { computeTargetId, externalSessionId: INGEST_SESSION_ID },
          select: { artifactId: true, lastSyncedAt: true },
        })
      );
      const sessionArtifactId = firstSync.artifactId;
      await linkSessionToBranch(
        organizationId,
        sessionArtifactId,
        await seedBranch(organizationId, "iss12779-ingest")
      );

      // Exactly one receive overlap after the first sync's own stamp: the
      // strict `>` puts that stamp outside the window, and the ambient
      // transaction's `now()` that stamped the events' `created_at` is earlier
      // still, so after this pass only a NEW stamp can queue the session.
      const firstPassAt = new Date(
        firstSync.lastSyncedAt.getTime() +
          BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS
      );
      await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: firstPassAt,
      });

      await agentSessionsService.upsertSessions(
        context,
        buildIngestPayload(INGEST_REPRICED_UPDATED_AT, INGEST_REPRICED_COST)
      );
      // Precondition: the re-sync rewrote the one event's price in place and
      // added no event, so no watermark the queue reads has moved and only the
      // sync stamp can queue the session.
      const storedEvents = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: sessionArtifactId },
          select: { estimatedCost: true },
        })
      );
      expect(storedEvents.map((event) => String(event.estimatedCost))).toEqual([
        String(INGEST_REPRICED_COST),
      ]);

      const secondPassAt = new Date(firstPassAt.getTime() + 60_000);
      const summary = await refreshBranchAnalyticsRollupBatch({
        organizationId,
        now: secondPassAt,
      });
      expect(summary.sessionsRefreshed).toBe(1);
      const read = await readWindow(
        organizationId,
        [sessionArtifactId],
        undefined,
        secondPassAt
      );
      expect(costOf(read, sessionArtifactId)).toBe(
        String(INGEST_REPRICED_COST)
      );
    });
  });
});

const INGEST_SESSION_ID = "iss12779-ingest-session";
const INGEST_STARTED_AT = "2026-10-01T10:00:00.000Z";
const INGEST_UPDATED_AT = "2026-10-01T10:30:00.000Z";
const INGEST_REPRICED_UPDATED_AT = "2026-10-01T10:45:00.000Z";
const INGEST_FIRST_COST = 1.5;
const INGEST_REPRICED_COST = 2.25;

type SeedEvent = {
  id: string;
  at: string;
  cost: number | null;
  receivedAt?: Date;
};

type RollupSnapshotRow = {
  session: string;
  branch: string;
  participation: string;
  method: string | null;
  bucketStart: string;
  bucketEnd: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  estimatedCost: string | null;
  minInputTokens: string | null;
  minOutputTokens: string | null;
  minCacheReadTokens: string | null;
  minCacheWriteTokens: string | null;
  minEstimatedCost: string | null;
  estimatedCostEventCount: number;
  eventCount: number;
  sourceMinEventCreatedAt: string;
  sourceMaxEventCreatedAt: string;
};

type ReadSnapshotRow = Record<string, string | null>;

function linkSessionToBranch(
  organizationId: string,
  sessionArtifactId: string,
  branchArtifactId: string
) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
      },
      select: { id: true },
    })
  );
}

function seedEvents(sessionArtifactId: string, events: readonly SeedEvent[]) {
  return withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: events.map((event, index) => ({
        agentSessionId: sessionArtifactId,
        externalEventId: `iss12779-${event.id}`,
        model: "claude-opus-5",
        inputTokens: 100 + index,
        outputTokens: 40 + index,
        cacheReadTokens: 10 * index,
        cacheWriteTokens: index,
        estimatedCost: event.cost,
        eventCreatedAt: new Date(event.at),
        createdAt: event.receivedAt ?? RECEIVED_BEFORE_CUTOFF,
      })),
    })
  );
}

function repriceEvent(sessionArtifactId: string, id: string, cost: number) {
  return withDb((db) =>
    db.agentSessionTokenEvent.update({
      where: {
        agentSessionId_externalEventId: {
          agentSessionId: sessionArtifactId,
          externalEventId: `iss12779-${id}`,
        },
      },
      data: { estimatedCost: cost },
      select: { id: true },
    })
  );
}

function stampSynced(sessionArtifactIds: readonly string[], at: Date) {
  return withDb((db) =>
    db.sessionDetail.updateMany({
      where: { artifactId: { in: [...sessionArtifactIds] } },
      data: { lastSyncedAt: at },
    })
  );
}

async function readSessionAsOf(
  organizationId: string
): Promise<Map<string, number>> {
  const rows = await withDb((db) =>
    db.branchAnalyticsSessionRollup.findMany({
      where: { organizationId, source: BRANCH_ANALYTICS_ROLLUP_SOURCE },
      select: { sessionArtifactId: true, asOf: true },
    })
  );
  const asOf = new Map<string, number>();
  for (const row of rows) {
    asOf.set(
      row.sessionArtifactId,
      Math.max(asOf.get(row.sessionArtifactId) ?? 0, row.asOf.getTime())
    );
  }
  return asOf;
}

/** Every rollup row and every read shape `/branches` serves, as of the last pass. */
async function readEverything(
  organizationId: string,
  servable: readonly string[],
  all: readonly string[]
) {
  return {
    rows: await readRollupSnapshot(organizationId),
    unwindowed: await readWindow(
      organizationId,
      servable,
      undefined,
      SYNCED_PASS_AT
    ),
    wholeDay: await readWindow(
      organizationId,
      servable,
      WHOLE_DAY_WINDOW,
      SYNCED_PASS_AT
    ),
    partialDay: await readWindow(
      organizationId,
      servable,
      PARTIAL_DAY_WINDOW,
      SYNCED_PASS_AT
    ),
    withMalformed: withoutState(
      await withDb((db) =>
        readMaterializedBranchEventAggregates(
          db,
          organizationId,
          all,
          undefined,
          SYNCED_PASS_AT
        )
      )
    ),
  };
}

async function readRollupSnapshot(
  organizationId: string
): Promise<RollupSnapshotRow[]> {
  const rows = await withDb((db) =>
    db.branchAnalyticsSessionRollup.findMany({
      where: { organizationId, source: BRANCH_ANALYTICS_ROLLUP_SOURCE },
    })
  );
  return rows
    .map((row) => ({
      session: row.sessionArtifactId,
      branch: row.branchArtifactId,
      participation: row.branchParticipation,
      method: row.branchParticipationMethod,
      bucketStart: row.bucketStart.toISOString(),
      bucketEnd: row.bucketEnd.toISOString(),
      inputTokens: String(row.inputTokens),
      outputTokens: String(row.outputTokens),
      cacheReadTokens: String(row.cacheReadTokens),
      cacheWriteTokens: String(row.cacheWriteTokens),
      estimatedCost: nullableString(row.estimatedCost),
      minInputTokens: nullableString(row.minInputTokens),
      minOutputTokens: nullableString(row.minOutputTokens),
      minCacheReadTokens: nullableString(row.minCacheReadTokens),
      minCacheWriteTokens: nullableString(row.minCacheWriteTokens),
      minEstimatedCost: nullableString(row.minEstimatedCost),
      estimatedCostEventCount: row.estimatedCostEventCount,
      eventCount: row.eventCount,
      sourceMinEventCreatedAt: row.sourceMinEventCreatedAt.toISOString(),
      sourceMaxEventCreatedAt: row.sourceMaxEventCreatedAt.toISOString(),
    }))
    .sort((left, right) => rowIdentity(left).localeCompare(rowIdentity(right)));
}

async function readWindow(
  organizationId: string,
  sessionIds: readonly string[],
  window: BranchAnalyticsRollupDateWindow | undefined,
  now: Date
): Promise<ReadSnapshotRow[]> {
  const result = await withDb((db) =>
    readMaterializedBranchEventAggregates(
      db,
      organizationId,
      sessionIds,
      window,
      now
    )
  );
  if (result.status !== BranchAnalyticsRollupReadStatus.Available) {
    throw new Error(`expected an available rollup read, got ${result.reason}`);
  }
  return result.rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, nullableString(value)])
      )
    )
    .sort((left, right) =>
      String(left.agentSessionId).localeCompare(String(right.agentSessionId))
    );
}

/** The state row carries `as_of`, which a full rewrite legitimately moves. */
function withoutState(result: BranchAnalyticsRollupReadResult) {
  return result.status === BranchAnalyticsRollupReadStatus.Available
    ? result
    : { status: result.status, reason: result.reason };
}

function costOf(rows: readonly ReadSnapshotRow[], sessionId: string) {
  return normalizedNumber(
    rows.find((row) => row.agentSessionId === sessionId)?.sumEstimatedCost
  );
}

function eventsOf(rows: readonly ReadSnapshotRow[], sessionId: string) {
  return normalizedNumber(
    rows.find((row) => row.agentSessionId === sessionId)?.eventCount
  );
}

function normalizedNumber(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : String(Number(value));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowIdentity(row: RollupSnapshotRow): string {
  return [row.session, row.branch, row.participation, row.bucketStart].join(
    "|"
  );
}

function buildIngestPayload(
  updatedAt: string,
  firstEventCost: number
): DesktopAgentSessionsPayload {
  const session: SyncedAgentSession = {
    externalSessionId: INGEST_SESSION_ID,
    name: "ISS-12779 ingest reprice",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss12779",
    model: "claude-opus-5",
    startedAt: INGEST_STARTED_AT,
    updatedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    tokenEvents: [
      {
        externalEventId: "iss12779-ingest-event",
        model: "claude-opus-5",
        inputTokens: 120,
        outputTokens: 60,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: firstEventCost,
        createdAt: INGEST_STARTED_AT,
      },
    ],
  };
  const payload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "5d0c2f7e-12a9-4b8e-9c31-7a4e2b9d1f60",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  } satisfies DesktopAgentSessionsPayload;
  const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `invalid integration payload: ${JSON.stringify(parsed.error.issues)}`
    );
  }
  return payload;
}
