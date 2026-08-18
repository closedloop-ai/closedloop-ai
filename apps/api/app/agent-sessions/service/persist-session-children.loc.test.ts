import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { LOC_SOURCE_BRANCH_FALLBACK } from "@repo/api/src/utils/session-loc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSessionDetailRecord,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

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

// Branch-total vs per-session LOC persistence lives here (split out of
// persist-session-children.test.ts to keep that file under the size ceiling).
describe("agentSessionsService branch/LOC persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("FEA-3922/FEA-3923: per-session LOC comes from transcript scalars, never git-derived gitDiffStats", async () => {
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
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba004",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            // Transcript-derived per-session scalars — the truer own-diff signal.
            linesAdded: 5,
            linesRemoved: 1,
            filesChanged: 2,
            // A whole-branch/PR fallback total shared across every authoring
            // session on the branch. It must NOT win over the transcript scalars
            // (FEA-3922), and gh's spurious files_changed=0 must NOT surface
            // (FEA-3923).
            gitDiffStats: {
              linesAdded: 900,
              linesRemoved: 400,
              filesChanged: 0,
              source: LOC_SOURCE_BRANCH_FALLBACK,
            },
          }),
        ],
      }
    );

    const createData = sessionUpsert.mock.calls[0]?.[0].create;
    const updateData = sessionUpsert.mock.calls[0]?.[0].update;
    // Both branches persist the transcript values, not the branch-total git LOC,
    // and clear loc_source (the columns are transcript-derived, never git-tagged).
    for (const data of [createData, updateData]) {
      expect(data).toMatchObject({
        linesAdded: 5,
        linesRemoved: 1,
        filesChanged: 2,
        locSource: null,
      });
    }
  });
});
