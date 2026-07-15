import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionState,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../../service";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSessionDetailRecord,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_UPDATED_AT,
} from "../../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps stored state visible after sync conflict through persisted detail projection", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const syncWritableColumns = [
      "harness",
      "cwd",
      "model",
      "branch",
      "pullRequests",
      "linesAdded",
      "linesRemoved",
      "sessionStartedAt",
      "sessionUpdatedAt",
      "sessionEndedAt",
      "awaitingInputSince",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "estimatedCost",
      "agentCount",
      "metadata",
      "agents",
      "lastSyncedAt",
    ];

    const applySyncWrite = (data: Record<string, unknown>) => {
      const artifactWrite = data.artifact as
        | {
            create?: { name?: string; status?: string; slug?: string };
            update?: { name?: string; status?: string };
          }
        | undefined;
      const artifactData: { name?: string; status?: string; slug?: string } =
        artifactWrite?.create ?? artifactWrite?.update ?? {};

      persistedRecord = {
        ...buildSessionDetailRecord(persistedRecord ?? {}),
        artifactId: "persisted-session-1",
        externalSessionId: "sess-1",
        origin: "DESKTOP_SYNC",
        userId: "user-1",
        computeTarget: {
          id: "target-1",
          machineName: "Ada's MacBook Pro",
          isOnline: true,
          lastSeenAt: SESSION_UPDATED_AT,
        },
        artifact: {
          // Org SSOT — the simulated persisted projection carries the owning org
          // so the by-id read's resolveOrgScopeVia() sees it (FEA-2734).
          organizationId: "org-1",
          name: artifactData.name ?? "Session One",
          status: artifactData.status ?? "active",
          slug:
            artifactData.slug ??
            (
              persistedRecord?.artifact as
                | { slug?: string; project?: unknown }
                | undefined
            )?.slug ??
            "SES-1",
          project:
            (
              persistedRecord?.artifact as
                | { slug?: string; project?: unknown }
                | undefined
            )?.project ?? null,
        },
      };

      for (const column of syncWritableColumns) {
        if (Object.hasOwn(data, column)) {
          persistedRecord[column] = data[column];
        }
      }
    };

    const sessionUpsert = vi.fn().mockImplementation((args) => {
      const data = persistedRecord ? args.update : args.create;
      applySyncWrite(data);
      return { artifactId: "persisted-session-1" };
    });
    const sessionUpdate = vi.fn().mockImplementation(({ data }) => {
      if (persistedRecord) {
        persistedRecord = { ...persistedRecord, ...data };
      }
      return persistedRecord;
    });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: {
        findUnique: vi.fn().mockImplementation(() =>
          persistedRecord
            ? {
                artifactId: "persisted-session-1",
                agents: persistedRecord.agents,
              }
            : null
        ),
        upsert: sessionUpsert,
        update: sessionUpdate,
        findFirst: vi.fn().mockImplementation(() => persistedRecord),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const payloadBase = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
    };

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        ...payloadBase,
        sessions: [
          buildSyncedSession({
            status: SESSION_STATUS.ACTIVE,
            branch: "fea-1771",
            linesAdded: 10,
            linesRemoved: 2,
          }),
        ],
      }
    );
    persistedRecord = {
      ...buildSessionDetailRecord(persistedRecord ?? {}),
      state: AgentSessionState.Blocked,
    };
    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        ...payloadBase,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba002",
        sessions: [
          buildSyncedSession({
            status: SESSION_STATUS.COMPLETED,
            branch: "fea-1771-resynced",
            linesAdded: 20,
            linesRemoved: 4,
          }),
        ],
      }
    );

    const detail = await agentSessionsService.findSessionDetail({
      id: "persisted-session-1",
      organizationId: "org-1",
    });

    expect(sessionUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.not.objectContaining({
          state: expect.anything(),
        }),
      })
    );
    expect(detail).toMatchObject({
      id: "persisted-session-1",
      status: SESSION_STATUS.COMPLETED,
      state: AgentSessionState.Blocked,
      branch: "fea-1771-resynced",
      linesAdded: 20,
      linesRemoved: 4,
    });
  });
  it("clears a persisted branch on an explicit null payload and preserves it when the branch key is absent", async () => {
    // FEA-2531 AC8: toTraceDetailPatch must let a read-only session (branch:null)
    // clear a stale cloud branch, while an omitted branch key preserves it. The
    // upsert `update` arm is the contract boundary — inspect it directly.
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
        // An existing detail row so the sync takes the update arm; the branch
        // column is written from toTraceDetailPatch on that arm.
        findUnique: vi.fn().mockResolvedValue({
          artifactId: "persisted-session-1",
          agents: [],
          dataRevision: null,
        }),
        upsert: sessionUpsert,
      }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const context = {
      organizationId: "org-1",
      userId: "user-1",
      computeTargetId: "target-1",
    };
    const payloadBase = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
    };

    await agentSessionsService.upsertSessions(context, {
      ...payloadBase,
      batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba010",
      sessions: [buildSyncedSession({ branch: null })],
    });
    const nullUpdateCall = sessionUpsert.mock.calls.at(-1)?.[0];
    expect(nullUpdateCall).toBeDefined();
    const nullUpdate = (
      nullUpdateCall as {
        update: Record<string, unknown>;
      }
    ).update;
    expect(Object.hasOwn(nullUpdate, "branch")).toBe(true);
    expect(nullUpdate.branch).toBeNull();

    sessionUpsert.mockClear();

    await agentSessionsService.upsertSessions(context, {
      ...payloadBase,
      batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba011",
      sessions: [buildSyncedSession()],
    });
    const absentUpdateCall = sessionUpsert.mock.calls.at(-1)?.[0];
    expect(absentUpdateCall).toBeDefined();
    const absentUpdate = (
      absentUpdateCall as {
        update: Record<string, unknown>;
      }
    ).update;
    expect(Object.hasOwn(absentUpdate, "branch")).toBe(false);
  });
});
