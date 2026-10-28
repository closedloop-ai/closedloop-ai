import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSessionDetailRecord,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../../service";

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
      return persistedSessionDetail("persisted-session-1");
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
                // ISS-4946: the upsert reads the persisted time columns as its
                // freshness watermark, so the simulated row must carry them.
                sessionStartedAt: persistedRecord.sessionStartedAt,
                sessionUpdatedAt: persistedRecord.sessionUpdatedAt,
                sessionEndedAt: persistedRecord.sessionEndedAt,
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
            status: SESSION_STATUS.INACTIVE,
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
      // ISS-5648: the resync's retired `completed` spelling is accepted but
      // folded to the canonical `inactive` on the way to the column. The point
      // of this case is the persisted `state` surviving the resync, which the
      // fold does not touch.
      status: SESSION_STATUS.INACTIVE,
      linesAdded: 20,
      linesRemoved: 4,
    });
  });
  it("ignores the legacy branch payload on the session detail update arm", async () => {
    // ISS-4742: the cloud accepts the desktop `branch` key for version skew, but
    // no longer writes a `session_detail.branch` scalar.
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue(persistedSessionDetail("persisted-session-1"));

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        // An existing detail row so the sync takes the update arm.
        findUnique: vi.fn().mockResolvedValue({
          artifactId: "persisted-session-1",
          agents: [],
          dataRevision: null,
          // ISS-4946: the upsert reads the persisted time columns as its
          // freshness watermark, so a persisted-row stub must carry them.
          sessionStartedAt: SESSION_STARTED_AT,
          sessionUpdatedAt: SESSION_UPDATED_AT,
          sessionEndedAt: null,
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
      sessions: [buildSyncedSession({ branch: "legacy/session-branch" })],
    });
    const presentUpdateCall = sessionUpsert.mock.calls.at(-1)?.[0];
    expect(presentUpdateCall).toBeDefined();
    const presentUpdate = (
      presentUpdateCall as {
        update: Record<string, unknown>;
      }
    ).update;
    expect(Object.hasOwn(presentUpdate, "branch")).toBe(false);

    sessionUpsert.mockClear();

    await agentSessionsService.upsertSessions(context, {
      ...payloadBase,
      batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba011",
      sessions: [buildSyncedSession({ branch: null })],
    });
    const nullUpdateCall = sessionUpsert.mock.calls.at(-1)?.[0];
    expect(nullUpdateCall).toBeDefined();
    const nullUpdate = (
      nullUpdateCall as {
        update: Record<string, unknown>;
      }
    ).update;
    expect(Object.hasOwn(nullUpdate, "branch")).toBe(false);
  });
});
