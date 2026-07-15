import { SessionPrLifecycleStatus } from "@repo/api/src/session-trace/derivation";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSessionDetailRecord,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "../service.test-harness";
import { mocks } from "../service.test-mocks";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          estimatedCost: 0.03,
        },
        {
          agentSessionId: "persisted-session-1",
          model: "gpt-4.1",
          inputTokens: 1,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
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
    // FEA-2913: the tool-use + error counts are recomputed in a single
    // conditional-aggregation query returning bigint COUNTs.
    const queryRawUnsafe = vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 1n, errorCount: 1n }]);
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
    // countErrorEvents.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [countsSql, ...countsParams] = queryRawUnsafe.mock.calls[0] ?? [];
    const countsSqlText = String(countsSql);
    expect(countsSqlText).toContain("COUNT(*) FILTER");
    expect(countsSqlText).toContain(`"event_type" = 'tool_use'`);
    expect(countsSqlText).toContain(
      `"tool_name" IS NOT NULL AND "tool_name" <> ''`
    );
    expect(countsSqlText).toContain(`"event_type" ILIKE $2`);
    expect(countsSqlText).toContain(`"event_type" ILIKE $3`);
    expect(countsParams).toEqual(["persisted-session-1", "%error%", "%fail%"]);
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { artifactId: "persisted-session-1" },
      // PLN-1034: the same update also writes the derived lastActivityAt.
      data: expect.objectContaining({ toolUseCount: 1, errorCount: 1 }),
    });
  });
  it("FEA-2690: collapses duplicate externalEventIds (last-wins) so the ON CONFLICT upsert cannot crash", async () => {
    // Two events sharing an externalEventId would otherwise make the single
    // multi-row `INSERT ... ON CONFLICT DO UPDATE` abort with SQLSTATE 21000,
    // rolling back the whole session upsert and dead-lettering the sync.
    const executeRawUnsafe = vi.fn().mockResolvedValue(1);
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
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "chunk-batch-dup",
        syncMode: AgentSessionSyncMode.Backfill,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            events: [
              {
                externalEventId: "dup-1",
                agentExternalId: "agent-1",
                eventType: "tool_use",
                toolName: "Read",
                summary: null,
                createdAt: SESSION_STARTED_AT.toISOString(),
              },
              {
                externalEventId: "dup-1",
                agentExternalId: "agent-1",
                eventType: "runtime_error",
                toolName: null,
                summary: null,
                createdAt: SESSION_UPDATED_AT.toISOString(),
              },
            ],
          }),
        ],
      }
    );

    // Exactly one INSERT, and it carries a single deduped row (1 SQL string +
    // 6 bind params, FEA-2718: no more summary/data columns) whose values are
    // the last occurrence — mirroring the `DO UPDATE SET ... = EXCLUDED` a
    // re-sync would apply.
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    const call = executeRawUnsafe.mock.calls[0] ?? [];
    expect(call).toHaveLength(7);
    const insertSql = String(call[0] ?? "");
    expect(insertSql.match(/gen_random_uuid\(\)/g)).toHaveLength(1);
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO "agent_session_events"`),
      "persisted-session-1",
      "dup-1",
      "agent-1",
      "runtime_error",
      null,
      SESSION_UPDATED_AT
    );
  });
  it("persists synced branchDiffStats into dedicated columns and rehydrates it on detail", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const branchColumns = [
      "branchLinesAdded",
      "branchLinesRemoved",
      "branchFilesChanged",
      "branchLocSource",
    ];

    const sessionUpsert = vi.fn().mockImplementation((args) => {
      const data = (persistedRecord ? args.update : args.create) as Record<
        string,
        unknown
      >;
      persistedRecord = {
        ...buildSessionDetailRecord(persistedRecord ?? {}),
        artifactId: "persisted-session-1",
      };
      for (const column of branchColumns) {
        if (Object.hasOwn(data, column)) {
          persistedRecord[column] = data[column];
        }
      }
      return { artifactId: "persisted-session-1" };
    });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: sessionUpsert,
        update: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockImplementation(() => persistedRecord),
      },
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
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba003",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            branchDiffStats: {
              linesAdded: 42,
              linesRemoved: 7,
              filesChanged: 3,
              source: "git",
            },
          }),
        ],
      }
    );

    // Branch LOC lands in its own columns, never colliding with the gitDiffStats
    // scalars (which stay null here because the payload carried no git stats).
    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          branchLinesAdded: 42,
          branchLinesRemoved: 7,
          branchFilesChanged: 3,
          branchLocSource: "git",
        }),
      })
    );

    const detail = await agentSessionsService.findSessionDetail({
      id: "persisted-session-1",
      organizationId: "org-1",
    });

    expect(detail?.branchDiffStats).toEqual({
      linesAdded: 42,
      linesRemoved: 7,
      filesChanged: 3,
      source: "git",
    });
    expect(detail?.gitDiffStats).toBeNull();
  });
  it("merges agents with existing session data by external ID", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      agents: [
        {
          externalAgentId: "agent-1",
          name: "main",
          type: "main",
          status: "active",
        },
      ],
    });
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        findUnique,
        upsert: sessionUpsert,
      }),
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
        batchId: "chunk-batch-2",
        syncMode: AgentSessionSyncMode.Backfill,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            agents: [
              {
                externalAgentId: "agent-2",
                name: "subagent",
                type: "subagent",
                status: "completed",
              },
            ],
          }),
        ],
      }
    );

    const updateArg = sessionUpsert.mock.calls[0][0].update;
    expect(updateArg.agents).toHaveLength(2);
    expect(
      updateArg.agents.map(
        (a: { externalAgentId: string }) => a.externalAgentId
      )
    ).toEqual(["agent-1", "agent-2"]);
  });
});
