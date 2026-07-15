/**
 * FEA-2730 (PLN-1297 Phase 5): integration tests for the token-analytics sync
 * lane — raw per-event token rows (AgentSessionTokenEvent, G1) and the 1:1
 * per-session usage rollup (AgentSessionUsageRollup, G10). Runs against a real
 * Postgres because it exercises the CTI write path (upsertSessions) plus the
 * BigInt/Decimal columns and the join-reached read accessors.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
  type SyncedAgentSessionAnalytics,
  type SyncedAgentSessionTokenEvent,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

const STARTED_AT = new Date("2026-06-10T10:00:00.000Z");
const UPDATED_AT = new Date("2026-06-10T11:00:00.000Z");

function createComputeTarget(
  organizationId: string,
  userId: string,
  machineName = "token-analytics-machine"
) {
  return withDb((db) =>
    db.computeTarget.create({
      data: { organizationId, userId, machineName, platform: "darwin" },
      select: { id: true },
    })
  );
}

function buildTokenEvent(
  overrides: Partial<SyncedAgentSessionTokenEvent> = {}
): SyncedAgentSessionTokenEvent {
  return {
    externalEventId: "hash-1",
    model: "claude-opus-4",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    estimatedCostUsd: 0.5,
    createdAt: "2026-06-10T10:15:00.000Z",
    ...overrides,
  };
}

function buildAnalytics(
  overrides: Partial<SyncedAgentSessionAnalytics> = {}
): SyncedAgentSessionAnalytics {
  return {
    startedAt: STARTED_AT.toISOString(),
    startedDay: "2026-06-10",
    status: "completed",
    harness: "claude",
    isHuman: false,
    humanTurns: 2,
    agentTurns: 5,
    eventCount: 7,
    toolInvocations: 3,
    errorEvents: 1,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 400,
    estimatedCostUsd: 1.25,
    runtimeMs: 12_345,
    updatedAt: UPDATED_AT.toISOString(),
    ...overrides,
  };
}

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-token-session-1",
    name: "Token analytics session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: STARTED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "2f1d6a3e-1b2c-4d5e-8f90-1a2b3c4d5e6f",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

async function findArtifactId(
  computeTargetId: string,
  externalSessionId: string
): Promise<string> {
  const row = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
  return row.artifactId;
}

describeIfDb("FEA-2730 token analytics sync", () => {
  it("re-syncing identical token events is a no-op (our skipDuplicates guard)", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      const session = buildSession({
        tokenEvents: [
          buildTokenEvent({ externalEventId: "e1" }),
          buildTokenEvent({
            externalEventId: "e2",
            createdAt: "2026-06-10T10:16:00.000Z",
          }),
        ],
      });

      await agentSessionsService.upsertSessions(
        context,
        buildPayload([session])
      );
      // Re-sync the exact same token events. persistSessionTokenEvents uses
      // createMany(skipDuplicates) on the (agentSessionId, externalEventId)
      // unique, so this must be a no-op — not a duplicate insert, and not a
      // unique-violation that aborts the whole upsert transaction. (Analytics
      // 1:1 upsert-in-place is covered separately below.)
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([session])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        session.externalSessionId
      );
      const tokenEventCount = await withDb((db) =>
        db.agentSessionTokenEvent.count({
          where: { agentSessionId: artifactId },
        })
      );
      expect(tokenEventCount).toBe(2);
    });
  });

  it("carries token counts >2^31, cost >$10k, and runtime_ms >2^31 without truncation", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      const session = buildSession({
        tokenEvents: [
          buildTokenEvent({
            externalEventId: "big",
            inputTokens: 2_500_000_000,
            cacheReadTokens: 3_000_000_000,
            cacheWriteTokens: 4_000_000_000,
            estimatedCostUsd: 12_345.678_901,
          }),
        ],
        sessionAnalytics: buildAnalytics({
          inputTokens: 2_500_000_000,
          cacheReadTokens: 3_000_000_000,
          estimatedCostUsd: 12_345.678_901,
          // FEA-2852: wall-clock runtime for a session left open ~30 days
          // exceeds int4's 2,147,483,647 ceiling. runtime_ms is BigInt, so the
          // upsert must not throw "integer out of range" here.
          runtimeMs: 2_592_000_000,
        }),
      });
      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([session])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        session.externalSessionId
      );

      // Assert through the read accessors — the code under test. They narrow
      // BigInt/Decimal to JS numbers, and an exact value here also proves the
      // ingest stored it without truncation (an int4 column would have thrown
      // on insert for a value >2^31, failing the upsert above).
      const [tokenEvent] = await agentSessionsService.getSessionTokenEvents({
        organizationId,
        sessionArtifactId: artifactId,
      });
      expect(tokenEvent?.inputTokens).toBe(2_500_000_000);
      expect(tokenEvent?.cacheReadTokens).toBe(3_000_000_000);
      expect(tokenEvent?.cacheWriteTokens).toBe(4_000_000_000);
      expect(tokenEvent?.estimatedCostUsd).toBe(12_345.678_901);

      const analytics = await agentSessionsService.getSessionAnalytics({
        organizationId,
        sessionArtifactId: artifactId,
      });
      expect(analytics?.inputTokens).toBe(2_500_000_000);
      expect(analytics?.cacheReadTokens).toBe(3_000_000_000);
      expect(analytics?.estimatedCostUsd).toBe(12_345.678_901);
      expect(analytics?.runtimeMs).toBe(2_592_000_000);
    });
  });

  it("isolates token events + analytics across orgs via the session join", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization();
      const userA = await createTestUser(orgA);
      const targetA = await createComputeTarget(orgA, userA.id);
      const orgB = await createTestOrganization();
      const userB = await createTestUser(orgB);
      const targetB = await createComputeTarget(orgB, userB.id);

      await agentSessionsService.upsertSessions(
        { organizationId: orgA, userId: userA.id, computeTargetId: targetA.id },
        buildPayload([
          buildSession({
            externalSessionId: "sess-a",
            tokenEvents: [buildTokenEvent({ externalEventId: "a1" })],
            sessionAnalytics: buildAnalytics(),
          }),
        ])
      );
      await agentSessionsService.upsertSessions(
        { organizationId: orgB, userId: userB.id, computeTargetId: targetB.id },
        buildPayload([
          buildSession({
            externalSessionId: "sess-b",
            tokenEvents: [buildTokenEvent({ externalEventId: "b1" })],
            sessionAnalytics: buildAnalytics(),
          }),
        ])
      );

      const artifactA = await findArtifactId(targetA.id, "sess-a");
      const artifactB = await findArtifactId(targetB.id, "sess-b");

      // Org A reads its own session.
      expect(
        await agentSessionsService.getSessionTokenEvents({
          organizationId: orgA,
          sessionArtifactId: artifactA,
        })
      ).toHaveLength(1);
      expect(
        await agentSessionsService.getSessionAnalytics({
          organizationId: orgA,
          sessionArtifactId: artifactA,
        })
      ).not.toBeNull();

      // Org A cannot reach Org B's session — zero cross-org rows via the join.
      expect(
        await agentSessionsService.getSessionTokenEvents({
          organizationId: orgA,
          sessionArtifactId: artifactB,
        })
      ).toEqual([]);
      expect(
        await agentSessionsService.getSessionAnalytics({
          organizationId: orgA,
          sessionArtifactId: artifactB,
        })
      ).toBeNull();
    });
  });

  it("upserts the analytics rollup in place when a later sync changes it", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            sessionAnalytics: buildAnalytics({
              eventCount: 7,
              estimatedCostUsd: 1.25,
            }),
          }),
        ])
      );
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            sessionAnalytics: buildAnalytics({
              eventCount: 12,
              estimatedCostUsd: 2.5,
            }),
          }),
        ])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      const count = await withDb((db) =>
        db.agentSessionUsageRollup.count({ where: { artifactId } })
      );
      const row = await withDb((db) =>
        db.agentSessionUsageRollup.findUniqueOrThrow({ where: { artifactId } })
      );
      expect(count).toBe(1);
      expect(row.eventCount).toBe(12);
      expect(Number(row.estimatedCost)).toBe(2.5);
    });
  });

  it("leaves previously synced rows untouched when a later sync omits the sections", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            tokenEvents: [buildTokenEvent({ externalEventId: "keep" })],
            sessionAnalytics: buildAnalytics(),
          }),
        ])
      );
      // A later sync that omits tokenEvents/sessionAnalytics must not clear them
      // (mirrors the tokenUsage "omission never clears" rule).
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([buildSession({ status: "completed" })])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      expect(
        await withDb((db) =>
          db.agentSessionTokenEvent.count({
            where: { agentSessionId: artifactId },
          })
        )
      ).toBe(1);
      expect(
        await withDb((db) =>
          db.agentSessionUsageRollup.count({ where: { artifactId } })
        )
      ).toBe(1);
    });
  });
});
