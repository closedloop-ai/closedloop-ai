import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { agentSessionsService } from "../service";

// Legacy single-arg hashtext() advisory lock (32-bit key), still emitted
// alongside the new 64-bit hashtextextended() lock during the deploy window.
const LEGACY_HASHTEXT_LOCK_RE = /pg_advisory_xact_lock\(hashtext\([^,)]*\)\)/;

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds ingestion transactions to one session slice", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });
    const computeTargetUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        updateMany: computeTargetUpdateMany,
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba101",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 3,
        sessions: [
          buildSyncedSession({ externalSessionId: "sess-1" }),
          buildSyncedSession({ externalSessionId: "sess-2" }),
          buildSyncedSession({ externalSessionId: "sess-3" }),
        ],
      }
    );

    expect(mocks.withDb.tx).toHaveBeenCalledTimes(3);
    expect(sessionUpsert).toHaveBeenCalledTimes(3);
    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(2);
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "target-1",
        OR: [
          { lastAgentSessionSyncAttemptAt: null },
          { lastAgentSessionSyncAttemptAt: { lt: expect.any(Date) } },
        ],
      },
      data: {
        lastAgentSessionSyncAttemptAt: expect.any(Date),
      },
    });
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "target-1",
        OR: [
          { lastAgentSessionSyncAt: null },
          { lastAgentSessionSyncAt: { lt: expect.any(Date) } },
        ],
      },
      data: {
        lastAgentSessionSyncAt: expect.any(Date),
      },
    });
    expect(computeTargetUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      sessionUpsert.mock.invocationCallOrder.at(-1) ?? 0
    );
  });

  it("keeps key transaction statements bounded across payload and component count", async () => {
    const countsFor = async (sessionCount: number) => {
      vi.clearAllMocks();
      const sessionUpsert = vi
        .fn()
        .mockResolvedValue({ artifactId: "persisted-session-1" });
      const componentDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
      const componentUpsert = vi.fn();
      const executeRaw = vi.fn().mockResolvedValue(0);

      installDb({
        $executeRaw: executeRaw,
        computeTarget: {
          findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
          update: vi.fn().mockResolvedValue({ id: "target-1" }),
        },
        slugCounter: buildSlugCounterMock(),
        sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
        agentSessionEvent: buildDefaultAgentSessionEventMocks(),
        agentSessionTokenUsage: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        agentComponentSessionUsage: {
          deleteMany: componentDeleteMany,
          upsert: componentUpsert,
        },
      });

      await agentSessionsService.upsertSessions(
        {
          organizationId: "org-1",
          userId: "user-1",
          computeTargetId: "target-1",
        },
        {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba103",
          syncMode: AgentSessionSyncMode.Incremental,
          sessionCount,
          sessions: Array.from({ length: sessionCount }, (_, index) =>
            buildSyncedSession({
              externalSessionId: `sess-${index + 1}`,
              components: Array.from({ length: 25 }, (__, componentIndex) => ({
                componentKind: "tool",
                componentKey: `tool-${componentIndex + 1}`,
                invocations: componentIndex + 1,
                errorCount: 0,
              })),
            })
          ),
        }
      );

      return {
        componentDeleteMany: componentDeleteMany.mock.calls.length,
        componentRawUpsert: executeRaw.mock.calls.filter(([strings]) =>
          (strings as TemplateStringsArray)
            .join("")
            .includes("agent_component_session_usage")
        ).length,
        componentUpsert: componentUpsert.mock.calls.length,
        sessionUpsert: sessionUpsert.mock.calls.length,
        tx: mocks.withDb.tx.mock.calls.length,
      };
    };

    const small = await countsFor(2);
    const large = await countsFor(5);

    expect(small).toMatchObject({
      componentDeleteMany: 2,
      componentRawUpsert: 2,
      componentUpsert: 0,
      sessionUpsert: 2,
      tx: 2,
    });
    expect(large).toMatchObject({
      componentDeleteMany: 5,
      componentRawUpsert: 5,
      componentUpsert: 0,
      sessionUpsert: 5,
      tx: 5,
    });
  });

  it("advances the target watermark for committed slices when a later slice fails", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });
    const computeTargetUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        updateMany: computeTargetUpdateMany,
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    let txCalls = 0;
    const runTx = mocks.withDb.tx.getMockImplementation();
    mocks.withDb.tx.mockImplementation(async (callback) => {
      txCalls += 1;
      const result = await runTx?.(callback);
      if (txCalls === 2) {
        throw new Error("slice_failed");
      }
      return result;
    });

    await expect(
      agentSessionsService.upsertSessions(
        {
          organizationId: "org-1",
          userId: "user-1",
          computeTargetId: "target-1",
        },
        {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba102",
          syncMode: AgentSessionSyncMode.Incremental,
          sessionCount: 3,
          sessions: [
            buildSyncedSession({ externalSessionId: "sess-1" }),
            buildSyncedSession({ externalSessionId: "sess-2" }),
            buildSyncedSession({ externalSessionId: "sess-3" }),
          ],
        }
      )
    ).rejects.toThrow("slice_failed");

    expect(mocks.withDb.tx).toHaveBeenCalledTimes(2);
    expect(sessionUpsert).toHaveBeenCalledTimes(2);
    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(2);
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "target-1",
        OR: [
          { lastAgentSessionSyncAttemptAt: null },
          { lastAgentSessionSyncAttemptAt: { lt: expect.any(Date) } },
        ],
      },
      data: { lastAgentSessionSyncAttemptAt: expect.any(Date) },
    });
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "target-1",
        OR: [
          { lastAgentSessionSyncAt: null },
          { lastAgentSessionSyncAt: { lt: expect.any(Date) } },
        ],
      },
      data: { lastAgentSessionSyncAt: expect.any(Date) },
    });
  });

  it("persists sync trace fields without overwriting manual state", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            branch: "fea-1771",
            prs: [
              {
                num: 123,
                title: "Trace backend",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            linesAdded: 10,
            linesRemoved: 2,
            tracePhaseSources: [],
            throttleSources: [],
            correctionSources: [],
            phases: [],
            phaseIterations: {},
            phaseLoopbacks: [],
            throttles: [],
            markers: [],
          }),
        ],
      }
    );

    const createData = sessionUpsert.mock.calls[0]?.[0].create;
    const updateData = sessionUpsert.mock.calls[0]?.[0].update;
    expect(createData).toMatchObject({
      branch: "fea-1771",
      linesAdded: 10,
      linesRemoved: 2,
      tracePhaseSources: [],
      throttleSources: [],
      correctionSources: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
      throttles: [],
      markers: [],
    });
    expect(updateData).toMatchObject({
      branch: "fea-1771",
      linesAdded: 10,
      linesRemoved: 2,
      tracePhaseSources: [],
      throttleSources: [],
      correctionSources: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
      throttles: [],
      markers: [],
    });
    expect(createData).not.toHaveProperty("state");
    expect(updateData).not.toHaveProperty("state");
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: "agent_sessions.sync.completed" })
    );
  });
  it("takes BOTH the legacy 32-bit and new 64-bit per-session advisory lock in separate sequential statements (PRD-536 D12)", async () => {
    // The TOCTOU guard widens the lock key to 64 bits via
    // hashtextextended(key, 0::bigint) so unrelated sessions no longer collide
    // in the 32-bit hashtext space and serialize under load. During a rolling
    // deploy we ALSO take the legacy single-arg hashtext(key) lock so the new
    // release still mutually excludes in-flight previous-release handlers still
    // keyed on the 32-bit value (transitional; see the DEPLOY-TRANSITION comment
    // in service.ts). The two locks are acquired in separate statements so
    // PostgreSQL cannot reorder them and cause deadlocks.
    const executeRaw = vi.fn().mockResolvedValue(0);

    installDb({
      $executeRaw: executeRaw,
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba002",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession({ externalSessionId: "sess-lock-1" })],
      }
    );

    const lockCalls = executeRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray)
        .join("")
        .includes("pg_advisory_xact_lock")
    );
    expect(lockCalls).toHaveLength(2);
    const legacySql = (lockCalls[0][0] as TemplateStringsArray).join("");
    const newSql = (lockCalls[1][0] as TemplateStringsArray).join("");
    // First statement: legacy 32-bit hashtext lock only.
    expect(legacySql).toMatch(LEGACY_HASHTEXT_LOCK_RE);
    expect(legacySql).not.toContain("hashtextextended");
    expect(lockCalls[0].slice(1)).toContain("sess-lock-1");
    // Second statement: new 64-bit hashtextextended lock.
    expect(newSql).toContain("hashtextextended");
    expect(newSql).toContain("0::bigint");
    expect(lockCalls[1].slice(1)).toContain("sess-lock-1");
  });

  it("coalesces duplicate per-model token usage before persisting session usage rows", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany,
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            tokenUsageByModel: [
              {
                model: "claude-sonnet-4",
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 1,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.01,
              },
              {
                model: "claude-sonnet-4",
                inputTokens: 5,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 2,
                estimatedCostUsd: 0.02,
              },
              {
                model: "gpt-4.1",
                inputTokens: 1,
                outputTokens: 4,
                cacheReadTokens: 3,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.03,
              },
            ],
          }),
        ],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          inputTokens: 16,
          outputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          estimatedCost: 0.06,
        }),
        update: expect.objectContaining({
          inputTokens: 16,
          outputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          estimatedCost: 0.06,
        }),
      })
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          agentSessionId: "persisted-session-1",
          model: "claude-sonnet-4",
          inputTokens: 15,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          estimatedCost: 0.03,
        },
        {
          agentSessionId: "persisted-session-1",
          model: "gpt-4.1",
          inputTokens: 1,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          estimatedCost: 0.03,
        },
      ],
    });
  });
  it("preserves existing token usage rows when a sync carries no replacement usage", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const createMany = vi.fn().mockResolvedValue({ count: 0 });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany,
        createMany,
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            tokenUsageByModel: [],
          }),
        ],
      }
    );

    // An empty (or fully dropped) usage array means the payload supplied no
    // replacement data, so previously persisted rows must survive: neither the
    // destructive deleteMany nor the createMany should fire.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
  it("persists deviceTimeZone from sync payload into create and update branches", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession({ deviceTimeZone: "America/Chicago" })],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          deviceTimeZone: "America/Chicago",
        }),
        update: expect.objectContaining({
          deviceTimeZone: "America/Chicago",
        }),
      })
    );
  });
  it("does not write deviceTimeZone when field is omitted from payload", async () => {
    // Older Desktop builds omit deviceTimeZone. The column must be left
    // untouched on update (never nulled over a previously synced zone) and
    // simply absent on create (DB default null).
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession()],
      }
    );

    const upsertArgs = sessionUpsert.mock.calls[0][0];
    expect(upsertArgs.create).not.toHaveProperty("deviceTimeZone");
    expect(upsertArgs.update).not.toHaveProperty("deviceTimeZone");
  });
  it("delays session cost rounding until after cross-model aggregation", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            tokenUsageByModel: [
              {
                model: "claude-sonnet-4",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.000_000_6,
              },
              {
                model: "gpt-4.1",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.000_000_6,
              },
            ],
          }),
        ],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          estimatedCost: 0.000_001,
        }),
        update: expect.objectContaining({
          estimatedCost: 0.000_001,
        }),
      })
    );
  });
  it("upserts events into child table and recomputes counts from full event set", async () => {
    const executeRawUnsafe = vi.fn().mockResolvedValue(2);
    // ISS-4439: the two raw calls now have DISTINCT shapes, so the mock returns
    // DISTINCT rows per call rather than one SELECT-shaped row for both. If both
    // calls returned the same row, the assertions below could pass even if the
    // code never forwarded the SELECT's event-max into the UPDATE's $5 or read
    // last_activity_at from the RETURNING row.
    //   - counts SELECT (call 0): bigint tool-use/error COUNTs + the folded-in
    //     MAX("event_created_at") activity timestamp.
    //   - UPDATE ... RETURNING (call 1): the persisted last_activity_at.
    const countsMaxEventAt = new Date("2026-05-20T18:30:00.000Z");
    const returnedLastActivityAt = new Date("2026-05-20T19:00:00.000Z");
    const queryRawUnsafe = vi.fn().mockImplementation((sql: string) => {
      if (String(sql).includes(`UPDATE "session_detail"`)) {
        return Promise.resolve([{ lastActivityAt: returnedLastActivityAt }]);
      }
      return Promise.resolve([
        {
          toolUseCount: 1n,
          errorCount: 1n,
          maxEventCreatedAt: countsMaxEventAt,
        },
      ]);
    });
    const sessionUpdate = vi.fn().mockResolvedValue({});

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ update: sessionUpdate }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: queryRawUnsafe,
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "chunk-batch-1",
        syncMode: AgentSessionSyncMode.Backfill,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            events: [
              {
                externalEventId: "event-1",
                agentExternalId: "agent-1",
                eventType: "tool_use",
                toolName: "Read",
                summary: null,
                data: {
                  filePath: "src/safe.ts",
                  output: "secret output",
                  tool_input: {
                    command: "pnpm",
                    args: ["test", "service"],
                    prompt: "secret prompt",
                  },
                  tool_response: {
                    status: "success",
                    stdout: "secret stdout",
                    durationMs: 42,
                  },
                },
                createdAt: SESSION_STARTED_AT.toISOString(),
              },
              {
                externalEventId: "event-2",
                agentExternalId: "agent-1",
                eventType: "runtime_error",
                toolName: null,
                summary: "something broke",
                createdAt: SESSION_UPDATED_AT.toISOString(),
              },
            ],
          }),
        ],
      }
    );

    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    // FEA-2718: conversation turn text left the cloud DB. Each event row now
    // carries only the retained columnar metadata — no `summary`/`data`, even
    // when the (desktop-local-shaped) input still includes them.
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO "agent_session_events"`),
      "persisted-session-1",
      "event-1",
      "agent-1",
      "tool_use",
      "Read",
      SESSION_STARTED_AT,
      "persisted-session-1",
      "event-2",
      "agent-1",
      "runtime_error",
      null,
      SESSION_UPDATED_AT
    );
    // Regression: `id` PK must be supplied inline — Prisma's client-side
    // @default(uuid(7)) does not apply to raw SQL, and the column has no
    // DB default, so omitting it produces 23502 on every new event.
    const insertSql = String(executeRawUnsafe.mock.calls[0]?.[0] ?? "");
    expect(insertSql).toContain('"id"');
    expect(insertSql).toContain("gen_random_uuid()");
    // The dropped columns must never appear in the write.
    expect(insertSql).not.toContain('"summary"');
    expect(insertSql).not.toContain('"data"');

    // FEA-2913: both counts come from ONE conditional-aggregation scan
    // (COUNT(*) FILTER) rather than two sequential COUNT round-trips. The
    // tool-use FILTER mirrors `event_type = 'tool_use'` OR a non-empty
    // `tool_name`; the error FILTER mirrors ERROR_EVENT_PATTERN (/error|fail/i)
    // as `event_type ILIKE '%error%'`/`'%fail%'`, built from ERROR_EVENT_TERMS
    // so it stays in sync with the aggregateByTool classifier and the desktop
    // countErrorEvents. ISS-4439: the same scan now also folds in
    // MAX("event_created_at") (the latest-activity timestamp), and the counts +
    // timestamp land via a single raw UPDATE ... GREATEST ... RETURNING — so
    // persistSessionChildren issues exactly two round-trips (this counts SELECT
    // and that UPDATE), not four.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [countsSql, ...countsParams] = queryRawUnsafe.mock.calls[0] ?? [];
    const countsSqlText = String(countsSql);
    expect(countsSqlText).toContain("COUNT(*) FILTER");
    expect(countsSqlText).toContain(`"event_type" = 'tool_use'`);
    expect(countsSqlText).toContain(
      `"tool_name" IS NOT NULL AND "tool_name" <> ''`
    );
    expect(countsSqlText).toContain(`"event_type" ILIKE $2`);
    expect(countsSqlText).toContain(`"event_type" ILIKE $3`);
    expect(countsSqlText).toContain(`MAX("event_created_at")`);
    // ISS-4439 org-scoping: the counts scan is constrained to the session's
    // parent artifact org via an EXISTS on "artifacts" ($4, appended after the
    // error-term params), so a cross-org artifactId reads zero rows.
    expect(countsSqlText).toContain(`"artifacts"."organization_id" = $4::uuid`);
    expect(countsParams).toEqual([
      "persisted-session-1",
      "%error%",
      "%fail%",
      "org-1",
    ]);
    // ISS-4439: the counts + monotonic last_activity_at are persisted through a
    // single raw UPDATE (GREATEST over the column's own value + session start +
    // latest event) with RETURNING, replacing the prior findUnique + Prisma
    // update pair — so sessionDetail.update is no longer used by this lane.
    expect(sessionUpdate).not.toHaveBeenCalled();
    const [updateSql, ...updateParams] = queryRawUnsafe.mock.calls[1] ?? [];
    const updateSqlText = String(updateSql);
    expect(updateSqlText).toContain(`UPDATE "session_detail"`);
    expect(updateSqlText).toContain(
      `GREATEST("last_activity_at", $4::timestamp, $5::timestamp)`
    );
    expect(updateParams[0]).toBe("persisted-session-1");
    expect(updateParams[1]).toBe(1);
    expect(updateParams[2]).toBe(1);
    // $4 = session start (floor), $5 = MAX(event_created_at). Both feed GREATEST.
    expect(updateParams[3]).toEqual(SESSION_STARTED_AT);
    // ISS-4439: $5 MUST be the non-null event-max the counts SELECT (call 0)
    // returned — proving the collapse actually forwards MAX("event_created_at")
    // into the UPDATE instead of running the old separate `_max` scan. With the
    // reverted "identical SELECT rows for both calls" mock, call 0 carried no
    // maxEventCreatedAt and $5 was null, so this assertion would fail.
    expect(updateParams[4]).toEqual(countsMaxEventAt);
  });
});
