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
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
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

  it("FEA-3419: a fresh re-sync updates event cost in place and a stale retry cannot revert it", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync: the event priced at the pre-TTL five-minute rate.
      const staleEvent = buildTokenEvent({
        externalEventId: "e-repriced",
        estimatedCostUsd: 0.5,
      });
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            dataRevision: 37,
            tokenEvents: [staleEvent],
            updatedAt: "2026-06-10T10:30:00.000Z",
          }),
        ])
      );

      // Desktop reprices the event IN PLACE (updateTokenEventCost — e.g. the
      // rev-38 TTL correction); identity (counts/timestamp → externalEventId)
      // is unchanged, only the cost differs. The re-sync must UPDATE the
      // existing cloud row, not skip it (stale cost) and not duplicate it.
      const repricedEvent = buildTokenEvent({
        externalEventId: "e-repriced",
        estimatedCostUsd: 0.8018,
      });
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({ dataRevision: 38, tokenEvents: [repricedEvent] }),
        ])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      const rows = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: artifactId },
          select: { externalEventId: true, estimatedCost: true },
        })
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.estimatedCost)).toBeCloseTo(0.8018, 6);

      // Idempotent: re-syncing the SAME corrected cost is a zero-write no-op
      // (the IS DISTINCT FROM guard) — still one row, same cost.
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({ dataRevision: 38, tokenEvents: [repricedEvent] }),
        ])
      );
      const after = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: artifactId },
          select: { estimatedCost: true },
        })
      );
      expect(after).toHaveLength(1);
      expect(Number(after[0]?.estimatedCost)).toBeCloseTo(0.8018, 6);

      // A delayed retry from the older Desktop build has the same immutable
      // event identity but an older session freshness watermark and the stale
      // five-minute price. It may re-send the event, but must not mutate the
      // corrected cloud cost back to last-request-wins.
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            dataRevision: 37,
            tokenEvents: [staleEvent],
            updatedAt: "2026-06-10T10:30:00.000Z",
          }),
        ])
      );
      const afterStaleRetry = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: artifactId },
          select: { estimatedCost: true },
        })
      );
      expect(afterStaleRetry).toHaveLength(1);
      expect(Number(afterStaleRetry[0]?.estimatedCost)).toBeCloseTo(0.8018, 6);
    });
  });

  it("ISS-4882: round-trips nullable provenance, truthful zero, and additive cost lanes", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const sourceIdentity = {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "provider-record-v1",
        sourceRecordIds: ["request-1", "usage-1"],
      };

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSession({
            tokenEvents: [
              buildTokenEvent({
                externalEventId: "legacy-omitted",
                estimatedCostUsd: undefined,
              }),
              buildTokenEvent({
                externalEventId: "truthful-zero",
                costSummary: {
                  completeness: TokenCostCompleteness.Complete,
                  subtotalUsd: 0,
                  lanes: [
                    {
                      basis: TokenCostBasis.ApiEstimated,
                      subtotalUsd: 0,
                    },
                  ],
                },
              }),
              buildTokenEvent({
                externalEventId: "mixed-lanes",
                sourceIdentity,
                costSummary: {
                  completeness: TokenCostCompleteness.Partial,
                  reason: TokenCostCompletenessReason.PricingIncomplete,
                  subtotalUsd: 1.25,
                  lanes: [
                    {
                      basis: TokenCostBasis.SubscriptionEquivalent,
                      subtotalUsd: 0.75,
                    },
                    {
                      basis: TokenCostBasis.ApiEstimated,
                      subtotalUsd: 0.5,
                    },
                  ],
                },
              }),
              buildTokenEvent({
                externalEventId: "unavailable",
                sourceIdentity: {
                  availability: TokenSourceIdentityAvailability.Unavailable,
                  reason:
                    TokenSourceIdentityUnavailableReason.UnsupportedSource,
                },
                costSummary: {
                  completeness: TokenCostCompleteness.Unavailable,
                  reason: TokenCostCompletenessReason.UnsupportedSource,
                },
              }),
            ],
          }),
        ])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      const rows = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: artifactId },
          orderBy: { externalEventId: "asc" },
          select: {
            externalEventId: true,
            estimatedCost: true,
            sourceIdentity: true,
            costCompleteness: true,
            costCompletenessReason: true,
            subscriptionEquivalentCost: true,
            apiEstimatedCost: true,
          },
        })
      );
      const byId = new Map(rows.map((row) => [row.externalEventId, row]));
      expect(byId.get("legacy-omitted")).toMatchObject({
        estimatedCost: null,
        sourceIdentity: null,
        costCompleteness: null,
      });
      expect(Number(byId.get("truthful-zero")?.estimatedCost)).toBe(0);
      expect(Number(byId.get("truthful-zero")?.apiEstimatedCost)).toBe(0);
      expect(byId.get("mixed-lanes")?.sourceIdentity).toEqual(sourceIdentity);
      expect(byId.get("mixed-lanes")?.costCompleteness).toBe(
        TokenCostCompleteness.Partial
      );
      expect(Number(byId.get("mixed-lanes")?.estimatedCost)).toBe(1.25);
      expect(Number(byId.get("mixed-lanes")?.subscriptionEquivalentCost)).toBe(
        0.75
      );
      expect(Number(byId.get("mixed-lanes")?.apiEstimatedCost)).toBe(0.5);
      expect(byId.get("unavailable")).toMatchObject({
        estimatedCost: null,
        costCompleteness: TokenCostCompleteness.Unavailable,
        costCompletenessReason: TokenCostCompletenessReason.UnsupportedSource,
      });

      const readRows = await agentSessionsService.getSessionTokenEvents({
        organizationId,
        sessionArtifactId: artifactId,
      });
      expect(readRows[0]?.estimatedCostUsd).toBeNull();
      expect(readRows[1]?.estimatedCostUsd).toBe(0);
    });
  });

  it("ISS-4882: preserves transport replay identity and rejects immutable collisions", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };
      const enriched = buildTokenEvent({
        externalEventId: "stable-transport",
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Available,
          scheme: "provider-record-v1",
          sourceRecordIds: ["record-1"],
        },
        costSummary: {
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: 0.75,
          lanes: [
            {
              basis: TokenCostBasis.SubscriptionEquivalent,
              subtotalUsd: 0.75,
            },
          ],
        },
      });
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([buildSession({ tokenEvents: [enriched] })])
      );

      // A legacy producer omitting the structured summary must not erase or
      // contradict provenance/completeness already stored by a newer shape.
      const legacyReplay = buildTokenEvent({
        externalEventId: enriched.externalEventId,
        estimatedCostUsd: 0.9,
      });
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            updatedAt: "2026-06-10T12:00:00.000Z",
            tokenEvents: [legacyReplay, legacyReplay],
          }),
        ])
      );

      // Equal content with a different transport id is a distinct event.
      await agentSessionsService.upsertSessions(
        context,
        buildPayload([
          buildSession({
            updatedAt: "2026-06-10T12:01:00.000Z",
            tokenEvents: [
              legacyReplay,
              { ...legacyReplay, externalEventId: "stable-transport-2" },
            ],
          }),
        ])
      );
      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      const beforeCollision = await withDb((db) =>
        db.agentSessionTokenEvent.findMany({
          where: { agentSessionId: artifactId },
          orderBy: { externalEventId: "asc" },
        })
      );
      expect(beforeCollision).toHaveLength(2);
      expect(Number(beforeCollision[0]?.estimatedCost)).toBe(0.75);
      expect(beforeCollision[0]?.sourceIdentity).toEqual(
        enriched.sourceIdentity
      );
      expect(beforeCollision[0]?.costCompleteness).toBe(
        TokenCostCompleteness.Complete
      );
      expect(Number(beforeCollision[0]?.subscriptionEquivalentCost)).toBe(0.75);

      await expect(
        agentSessionsService.upsertSessions(
          context,
          buildPayload([
            buildSession({
              updatedAt: "2026-06-10T12:02:00.000Z",
              tokenEvents: [
                { ...legacyReplay, inputTokens: legacyReplay.inputTokens + 1 },
              ],
            }),
          ])
        )
      ).rejects.toThrow("token_event_transport_identity_collision");
      expect(
        await withDb((db) =>
          db.agentSessionTokenEvent.count({
            where: { agentSessionId: artifactId },
          })
        )
      ).toBe(2);
    });
  });

  it("FEA-3419: the tokenUsage lane round-trips the typed cache-write TTL split (null = absent)", async () => {
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
            tokenUsageByModel: [
              {
                model: "claude-opus-4",
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 0,
                cacheWriteTokens: 1000,
                cacheWrite5mTokens: 600,
                cacheWrite1hTokens: 400,
                estimatedCostUsd: 1.5,
              },
              {
                // Absent provenance (legacy / non-Claude): fields omitted →
                // persisted NULL, distinguishable from a reported zero.
                model: "gpt-5-codex",
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 90,
                estimatedCostUsd: 0.1,
              },
            ],
          }),
        ])
      );

      const artifactId = await findArtifactId(
        computeTarget.id,
        "ext-token-session-1"
      );
      const rows = await withDb((db) =>
        db.agentSessionTokenUsage.findMany({
          where: { agentSessionId: artifactId },
          orderBy: { model: "asc" },
          select: {
            model: true,
            cacheWriteTokens: true,
            cacheWrite5mTokens: true,
            cacheWrite1hTokens: true,
          },
        })
      );
      expect(rows).toHaveLength(2);
      const claude = rows.find((row) => row.model === "claude-opus-4");
      expect(Number(claude?.cacheWrite5mTokens)).toBe(600);
      expect(Number(claude?.cacheWrite1hTokens)).toBe(400);
      const codex = rows.find((row) => row.model === "gpt-5-codex");
      expect(codex?.cacheWrite5mTokens).toBeNull();
      expect(codex?.cacheWrite1hTokens).toBeNull();
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

/**
 * FEA-4276 (shafty review, thread F): the Sessions LIST cost and the session
 * DETAIL cost must agree for the SAME record, proven end-to-end against real
 * Postgres — one session seeded ONCE through `upsertSessions`, then read through
 * `findSessions` and `findSessionDetail`. The unit parity test fabricates list
 * and detail from two independent mock records and stays green if sync
 * persistence, Decimal conversion, or the Prisma aggregate/select drifts; this
 * seeds the real write path and reads back through the real query path, so a
 * drift in any of those breaks it.
 */
describeIfDb("FEA-4276 list/detail cost parity (real Postgres)", () => {
  async function seedAndReadBothCosts(input: {
    rollupCostUsd: number;
    tokenEvents: SyncedAgentSessionTokenEvent[];
  }): Promise<{
    listCost?: string | null;
    detailCost?: string | null;
  }> {
    const organizationId = await createTestOrganization();
    const user = await createTestUser(organizationId);
    const computeTarget = await createComputeTarget(organizationId, user.id);

    // The rollup token total the completeness cross-check compares against: the
    // sum of the per-event token counts, so a complete stream reads as complete
    // and the (repriced) per-event cost sum wins over the divergent rollup.
    const rollupInputTokens = input.tokenEvents.reduce(
      (sum, e) => sum + e.inputTokens,
      0
    );
    const rollupOutputTokens = input.tokenEvents.reduce(
      (sum, e) => sum + e.outputTokens,
      0
    );

    await agentSessionsService.upsertSessions(
      { organizationId, userId: user.id, computeTargetId: computeTarget.id },
      buildPayload([
        buildSession({
          tokenEvents: input.tokenEvents,
          // The rollup diverges from the per-event sum (the 41× dossier case).
          sessionAnalytics: buildAnalytics({
            inputTokens: rollupInputTokens,
            outputTokens: rollupOutputTokens,
            estimatedCostUsd: input.rollupCostUsd,
          }),
        }),
      ])
    );

    const artifactId = await findArtifactId(
      computeTarget.id,
      "ext-token-session-1"
    );
    const list = await agentSessionsService.findSessions({
      organizationId,
      filters: {},
    });
    const listCost = list.items.find((item) => item.id === artifactId)?.cost;
    const detail = await agentSessionsService.findSessionDetail({
      id: artifactId,
      organizationId,
    });
    return { listCost, detailCost: detail?.cost };
  }

  it("shows the same reconciled cost on list and detail for a normal record", async () => {
    await autoRollbackTransaction(async () => {
      const { listCost, detailCost } = await seedAndReadBothCosts({
        // Rollup agrees with the per-event sum here.
        rollupCostUsd: 0.5,
        tokenEvents: [
          buildTokenEvent({ externalEventId: "n1", estimatedCostUsd: 0.15 }),
          buildTokenEvent({
            externalEventId: "n2",
            estimatedCostUsd: 0.35,
            createdAt: "2026-06-10T10:16:00.000Z",
          }),
        ],
      });
      expect(listCost).toBe("$0.50");
      expect(detailCost).toBe("$0.50");
      expect(listCost).toBe(detailCost);
    });
  });

  it("reconciles a 41x rollup/per-event divergence to the per-event authority on BOTH surfaces", async () => {
    await autoRollbackTransaction(async () => {
      const { listCost, detailCost } = await seedAndReadBothCosts({
        // Inflated stale rollup; the (repriced) per-event stream sums to $33.24.
        rollupCostUsd: 1378.39,
        tokenEvents: [
          buildTokenEvent({ externalEventId: "d1", estimatedCostUsd: 5 }),
          buildTokenEvent({
            externalEventId: "d2",
            estimatedCostUsd: 10,
            createdAt: "2026-06-10T10:16:00.000Z",
          }),
          buildTokenEvent({
            externalEventId: "d3",
            estimatedCostUsd: 7,
            createdAt: "2026-06-10T10:17:00.000Z",
          }),
          buildTokenEvent({
            externalEventId: "d4",
            estimatedCostUsd: 11.24,
            createdAt: "2026-06-10T10:18:00.000Z",
          }),
        ],
      });
      // Neither surface may show the stale rollup — both show the authority.
      expect(listCost).toBe("$33.24");
      expect(detailCost).toBe("$33.24");
      expect(listCost).toBe(detailCost);
    });
  });
});
