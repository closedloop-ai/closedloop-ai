import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
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

  it("artifactRefs-only replacement protects single- and multi-PR links", async () => {
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
        // ISS-7669: the guarded monotonic advance that follows every upsert.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    // ISS-5823: the spare-list runs at the Evidence audience, so the weak
    // prose tier is spared alongside the strong one.
    expect(where.NOT).toEqual({
      OR: [
        sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
        {
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionBranch,
          },
        },
        // ISS-12552: evidence-lane links are spared too.
        {
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionEvidence,
          },
        },
      ],
    });
  });
});
