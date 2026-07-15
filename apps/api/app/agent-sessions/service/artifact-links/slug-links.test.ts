import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../../service";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
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

  it("persistArtifactLinks deleteMany guard excludes session_pr links", async () => {
    const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const artifactLinkCreate = vi.fn().mockResolvedValue({});
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "artifact-doc-1", slug: "FEA-100" }]),
      },
      artifactLink: {
        deleteMany: artifactLinkDeleteMany,
        findFirst: vi.fn().mockResolvedValue(null),
        create: artifactLinkCreate,
        upsert: vi.fn().mockResolvedValue({}),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue(null),
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
        batchId: "guard-test-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            artifactRefs: [
              {
                kind: ArtifactRefTargetKind.ClosedloopArtifact,
                slug: "FEA-100",
                isPrimary: true,
                method: "mcp_tool_call",
              },
            ],
            prRefs: [],
          }),
        ],
      }
    );

    const slugLinkDeleteCall = artifactLinkDeleteMany.mock.calls.find(
      (call: unknown[]) => {
        const where = (call[0] as { where: Record<string, unknown> }).where;
        return where.NOT !== undefined;
      }
    );
    expect(slugLinkDeleteCall).toBeDefined();
    const where = (slugLinkDeleteCall![0] as { where: Record<string, unknown> })
      .where;
    // FEA-2729: the slug-path replacement now spares BOTH the session_pr and
    // session_branch lanes so it never clobbers a branch/PR link.
    expect(where.NOT).toEqual({
      OR: [
        { metadata: { path: ["linkKind"], equals: "session_pr" } },
        { metadata: { path: ["linkKind"], equals: "session_branch" } },
      ],
    });
  });
});
