import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import {
  buildAgentSessionDbMock,
  buildSessionDetailRecord,
  buildSessionListRecord,
  installDb,
  SESSION_STARTED_AT,
} from "../service.test-harness";

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

  it("filters to sessions with changes against the scalar and branch diff columns", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { changePresence: ["has_changes"] },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // Includes the branch_* columns so branch-only diff sessions count as
    // "has changes", matching the desktop matcher and the rendered row.
    expect(where.AND).toEqual([
      {
        OR: [
          {
            OR: [
              { filesChanged: { gt: 0 } },
              { linesAdded: { gt: 0 } },
              { linesRemoved: { gt: 0 } },
              { branchFilesChanged: { gt: 0 } },
              { branchLinesAdded: { gt: 0 } },
              { branchLinesRemoved: { gt: 0 } },
            ],
          },
        ],
      },
    ]);
  });
  it("uses a null-safe complement for the no-changes option", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { changePresence: ["no_changes"] },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: { OR: Record<string, unknown>[] }[];
    };
    // Each diff column must be null or <= 0 — never a structural NOT, which
    // would drop all-null rows via SQL three-valued logic.
    expect(where.AND?.[0].OR[0]).toEqual({
      AND: [
        { OR: [{ filesChanged: null }, { filesChanged: { lte: 0 } }] },
        { OR: [{ linesAdded: null }, { linesAdded: { lte: 0 } }] },
        { OR: [{ linesRemoved: null }, { linesRemoved: { lte: 0 } }] },
        {
          OR: [
            { branchFilesChanged: null },
            { branchFilesChanged: { lte: 0 } },
          ],
        },
        { OR: [{ branchLinesAdded: null }, { branchLinesAdded: { lte: 0 } }] },
        {
          OR: [
            { branchLinesRemoved: null },
            { branchLinesRemoved: { lte: 0 } },
          ],
        },
      ],
    });
  });
  it("derives the Waiting facet from awaitingInputSince, not a persisted status (FEA-3035)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { statuses: [SESSION_STATUS.WAITING] },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // "waiting" is never persisted — an awaiting-input session is a non-terminal
    // status plus an awaitingInputSince timestamp and no sessionEndedAt, matching
    // both desktop paths and the toAgentSessionState projection (which only
    // reports PendingApproval while !sessionEndedAt). Cloud stores raw "error",
    // so the terminal set is {error,abandoned,completed}.
    expect(where.AND).toEqual([
      {
        awaitingInputSince: { not: null },
        sessionEndedAt: null,
        artifact: {
          is: { status: { notIn: ["completed", "error", "abandoned"] } },
        },
      },
    ]);
  });
  it("excludes awaiting-input sessions from the Active facet (FEA-3035)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: SESSION_STATUS.ACTIVE },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // Active is status='active' AND not awaiting input, so awaiting-input
    // sessions desktop excludes are excluded on the web too.
    expect(where.AND).toEqual([
      { awaitingInputSince: null, artifact: { is: { status: "active" } } },
    ]);
  });
  it("ORs a mixed status multi-select, keeping plain statuses as equality (FEA-3035)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        statuses: [SESSION_STATUS.WAITING, SESSION_STATUS.COMPLETED],
      },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: { OR: Record<string, unknown>[] }[];
    };
    expect(where.AND?.[0].OR).toEqual([
      {
        awaitingInputSince: { not: null },
        sessionEndedAt: null,
        artifact: {
          is: { status: { notIn: ["completed", "error", "abandoned"] } },
        },
      },
      { artifact: { is: { status: "completed" } } },
    ]);
  });
  it("filters by pull-request association across both PR sources", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { prAssociation: ["has_pr"] },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: { OR: Record<string, unknown>[] }[];
    };
    // has_pr ORs a legacy-JSON clause and a session→PR artifact-link clause.
    const hasPrClause = where.AND?.[0].OR[0] as { OR: unknown[] };
    expect(hasPrClause.OR).toEqual([
      {
        AND: [
          { pullRequests: { not: Prisma.DbNull } },
          { pullRequests: { not: [] } },
        ],
      },
      {
        artifact: {
          is: {
            sourceLinks: {
              some: {
                linkType: LinkType.RelatesTo,
                metadata: {
                  path: ["linkKind"],
                  equals: SessionArtifactLinkKind.SessionPr,
                },
              },
            },
          },
        },
      },
    ]);
  });
  it("lists organization sessions without a self-only user predicate", async () => {
    const findMany = vi.fn().mockResolvedValue([
      buildSessionListRecord({
        artifactId: "session-2",
        user: {
          id: "user-2",
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          avatarUrl: null,
        },
      }),
    ]);
    const count = vi.fn().mockResolvedValue(1);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    await expect(
      agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "session-2",
          user: expect.objectContaining({
            id: "user-2",
          }),
        }),
      ],
      total: 1,
      viewerScope: AgentSessionViewerScope.Organization,
    });

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
  it("fails closed if team scope reaches the service without teamId", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { viewerScope: AgentSessionViewerScope.Team },
    });

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      artifactId: { in: [] },
    };
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
  it("honors user and team filters within organization-scoped session lists", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        userId: "user-2",
        teamId: "team-1",
      },
    });

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      userId: "user-2",
      user: {
        is: {
          teamMemberships: {
            some: {
              teamId: "team-1",
            },
          },
        },
      },
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
  it("filters the session-list date window on lastActivityAt with a start-time fallback (FEA-2180)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    const startDate = "2026-06-18T00:00:00.000Z";
    const endDate = "2026-06-25T00:00:00.000Z";

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { startDate, endDate },
    });

    // The window must filter on lastActivityAt — the field the list is ordered
    // by — so a recently-active session that started before the window is kept,
    // and the dashboard / Sessions page lists stay in sync. Null-activity rows
    // fall back to sessionStartedAt.
    const range = { gte: new Date(startDate), lte: new Date(endDate) };
    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      OR: [
        { lastActivityAt: range },
        { lastActivityAt: null, sessionStartedAt: range },
      ],
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
  it("loads full same-organization session details without requiring ownership", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        artifactId: "session-2",
        user: {
          id: "user-2",
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          avatarUrl: null,
        },
        events: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            externalEventId: "event-1",
            agentExternalId: "agent-1",
            eventType: "message",
            toolName: null,
            summary: "Assistant replied",
            data: { text: "Full text history" },
            eventCreatedAt: SESSION_STARTED_AT,
          },
        ],
      })
    );

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findFirst,
      }),
    });

    await expect(
      agentSessionsService.findSessionDetail({
        id: "session-2",
        organizationId: "org-1",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "session-2",
        user: expect.objectContaining({
          id: "user-2",
        }),
        events: [
          // FEA-2718: ownership-free loading still returns the event, now with
          // only retained metadata (no summary/data turn text).
          expect.objectContaining({
            externalEventId: "event-1",
            eventType: "message",
          }),
        ],
      })
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "session-2",
          artifact: { is: { organizationId: "org-1" } },
        },
      })
    );
  });
});
