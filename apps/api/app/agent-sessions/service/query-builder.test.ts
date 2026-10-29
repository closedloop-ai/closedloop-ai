import { SESSION_UNKNOWN_COST_BUCKET_ID } from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionDetailRecord,
  buildSessionListRecord,
  DEFAULT_LIST_PAGE_ECHO,
  installDb,
  SESSION_STARTED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { buildWhere, SESSION_IDLE_WHERE } from "./query-builder";

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

  it("filters to sessions with changes against the scalar and branch diff columns", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      // quality:"all" isolates this facet from the FEA-3284 substantive default
      // (covered by its own tests); here we assert only the change-presence clause.
      filters: { changePresence: ["has_changes"], quality: "all" },
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
  it("filters the Model facet against the PRIMARY displayed model, not the token-usage relation (FEA-4303)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    // A session whose PRIMARY model is "claude-opus-4" but that also spent tokens
    // on a subagent model "claude-haiku". Selecting "claude-haiku" must NOT return
    // this row (its visible Model column shows "claude-opus-4"); the predicate must
    // key off SessionDetail.model, the exact value the table paints.
    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { models: ["claude-haiku"], quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      model?: unknown;
      tokenUsageByModel?: unknown;
    };
    // Primary-model equality is the ONLY model clause; the secondary/subagent
    // token-usage relation is no longer used so no row can display a model other
    // than the selected one.
    expect(where.model).toEqual({ in: ["claude-haiku"] });
    expect(where.tokenUsageByModel).toBeUndefined();
  });
  it("uses a null-safe complement for the no-changes option", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { changePresence: ["no_changes"], quality: "all" },
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
  // ISS-9939 / ISS-10629 (2026-09-17) retired the Waiting-derived-from-
  // awaitingInputSince FILTER predicate this test used to pin: the operator
  // ruling collapsed the Sessions status FILTER to a plain equality against the
  // three PERSISTED SESSION_STATUS values. DISPLAY is unchanged — an
  // awaiting-input session still BADGES Waiting — but a `waiting` request is no
  // longer resolved through `awaitingInputSince`; it falls through to an exact
  // `artifact.status` match on a column that stores none of it, the same honest
  // fallthrough every other unrecognized status value gets.
  it("filters status through a plain artifact.status equality (ISS-9939 / ISS-10629)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: SESSION_STATUS.ACTIVE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      artifact?: { is?: { organizationId?: unknown; status?: unknown } };
    };
    expect(where.artifact?.is?.status).toBe("active");
  });

  it("makes an all-retired status request unsatisfiable rather than an equality that can match", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { statuses: ["waiting"], quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      artifact?: { is?: { status?: unknown } };
    };
    // EXPECTATION CHANGED, not weakened (davetho review). This asserted
    // `status = "waiting"` under the name "exact-match-on-nothing" — but
    // `artifacts.status` is freeform and off-vocabulary rows exist, so that
    // equality matches precisely when a row literally STORES "waiting", which
    // is what the published API and MCP docs say cannot happen. An empty `in`
    // is unsatisfiable by construction and delivers what the old name claimed.
    //
    // Falling through to NO predicate would be worse than either: it widens a
    // retired-value request to the whole population.
    expect(where.artifact?.is?.status).toEqual({ in: [] });
  });

  it("drops retired values from a MIXED selection and keeps the persisted ones", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        statuses: [SESSION_STATUS.ACTIVE, "waiting", SESSION_STATUS.ERROR],
        quality: "all",
      },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      artifact?: { is?: { status?: unknown } };
    };
    // The retired member is removed rather than narrowing the whole request to
    // nothing OR riding along as a value that could match a stored literal.
    expect(where.artifact?.is?.status).toEqual({
      in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR],
    });
  });

  it("ORs a mixed status multi-select as a plain artifact.status IN clause (ISS-9939 / ISS-10629)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE],
        quality: "all",
      },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      artifact?: { is?: { status?: unknown } };
    };
    expect(where.artifact?.is?.status).toEqual({
      in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE],
    });
  });

  it("filters by pull-request association across both PR sources", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { prAssociation: ["has_pr"], quality: "all" },
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
                OR: [
                  {
                    metadata: {
                      path: ["linkKind"],
                      equals: SessionArtifactLinkKind.SessionPr,
                    },
                  },
                  {
                    metadata: {
                      path: ["linkKinds"],
                      array_contains: [SessionArtifactLinkKind.SessionPrSet],
                    },
                  },
                ],
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
        // ISS-12585: the wire `user` alias is filled from the assignee.
        artifact: {
          ...(buildSessionListRecord().artifact as Record<string, unknown>),
          assignee: {
            id: "user-2",
            email: "grace@example.com",
            firstName: "Grace",
            lastName: "Hopper",
            avatarUrl: null,
          },
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
        // quality:"all" so the asserted where is the bare org scope (no
        // substantive AND-clause); the FEA-3284 default is covered separately.
        filters: { quality: "all" },
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
      idleCount: 0,
      viewerScope: AgentSessionViewerScope.Organization,
      // ISS-9555: stated rather than loosened to `objectContaining`, because
      // this assertion's job is the WHOLE response shape.
      pageInfo: DEFAULT_LIST_PAGE_ECHO,
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
        quality: "all",
      },
    });

    // ISS-12251: the singular `userId` scope matches the Owner (the assignee);
    // team scope matches sessions a team member created (D-4).
    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
          assigneeId: { equals: "user-2" },
          createdBy: {
            is: {
              teamMemberships: {
                some: {
                  teamId: "team-1",
                },
              },
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
  it("filters the session-list date window on lastActivityAt (FEA-2180)", async () => {
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
      filters: { startDate, endDate, quality: "all" },
    });

    // The window must filter on lastActivityAt — the field the list is ordered
    // by — so a recently-active session that started before the window is kept,
    // and the dashboard / Sessions page lists stay in sync. ISS-6463 made the
    // column NOT NULL, so this is one comparison rather than a disjunction with
    // a sessionStartedAt fallback.
    const range = { gte: new Date(startDate), lte: new Date(endDate) };
    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      lastActivityAt: range,
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
  it("windows the usage summary on lastActivityAt too, so cards and list share one population (ISS-4429)", async () => {
    // ISS-4429 population parity: the summary cards must aggregate the SAME
    // population the table paints. The list windows the date range on
    // `lastActivityAt` (test above); the usage summary previously defaulted to
    // `sessionStartedAt`, so a session that STARTED before the window but was
    // active inside it appeared in the table yet fell out of the totals — the
    // "0 cards while rows are present" bug. Assert `getUsageSummary` now builds
    // the SAME `lastActivityAt` window predicate the list uses.
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 0 },
      _sum: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCost: null,
      },
      _min: { sessionStartedAt: null },
      _max: { sessionStartedAt: null },
    });
    const groupBy = vi.fn().mockResolvedValue([]);
    const tokenGroupBy = vi.fn().mockResolvedValue([]);
    const tokenFindMany = vi.fn().mockResolvedValue([]);
    const computeTargetFindMany = vi.fn().mockResolvedValue([]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ aggregate, groupBy }),
      agentSessionTokenUsage: {
        groupBy: tokenGroupBy,
        findMany: tokenFindMany,
      },
      computeTarget: { findMany: computeTargetFindMany },
    });

    const startDate = "2026-06-18T00:00:00.000Z";
    const endDate = "2026-06-25T00:00:00.000Z";

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { startDate, endDate, quality: "all" },
    });

    const range = { gte: new Date(startDate), lte: new Date(endDate) };
    const expectedWhere = {
      artifact: { is: { organizationId: "org-1" } },
      lastActivityAt: range,
    };
    // The core aggregate that produces totalSessions / tokens / cost must scope
    // to the lastActivityAt window — identical to the list's predicate above.
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
  });
  describe("FEA-3009 completedAfter completion-time boundary", () => {
    it("filters on sessionEndedAt (a completion timestamp), not the startDate/lastActivityAt window", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      const completedAfter = "2026-06-20T00:00:00.000Z";
      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { completedAfter, quality: "all" },
      });

      const where = findMany.mock.calls[0]?.[0].where as {
        AND?: Record<string, unknown>[];
        OR?: unknown;
      };
      // The completion boundary is applied to `sessionEndedAt` (a `gte` on the
      // nullable terminal-timestamp column, so a still-running row with a null
      // sessionEndedAt is excluded by SQL three-valued logic) — NOT to the
      // `lastActivityAt`/`sessionStartedAt` window `startDate` uses. This is the
      // fix for the cross-surface miscount: a long-running session that started
      // before `completedAfter` but ended after it is kept purely on its
      // completion time.
      expect(where.AND).toEqual([
        { sessionEndedAt: { gte: new Date(completedAfter) } },
      ]);
      // No startDate given, so there is no lastActivityAt/startedAt window.
      expect(where.OR).toBeUndefined();
    });
    it("composes the completion boundary with the startDate window (both applied, on different fields)", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      const startDate = "2026-06-01T00:00:00.000Z";
      const completedAfter = "2026-06-20T00:00:00.000Z";
      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { startDate, completedAfter, quality: "all" },
      });

      const where = findMany.mock.calls[0]?.[0].where as {
        AND?: Record<string, unknown>[];
        lastActivityAt?: unknown;
      };
      // The date window lands on lastActivityAt (its own field) while the
      // completion boundary lands on sessionEndedAt — the two are independent
      // predicates, so a session started-before-but-completed-after the boundary
      // is not silently dropped by the started-at window.
      expect(where.lastActivityAt).toEqual({ gte: new Date(startDate) });
      expect(where.AND).toEqual([
        { sessionEndedAt: { gte: new Date(completedAfter) } },
      ]);
    });
  });
  it("loads full same-organization session details without requiring ownership", async () => {
    const findMany = vi.fn().mockResolvedValue([
      buildSessionDetailRecord({
        artifactId: "session-2",
        // ISS-12585: the wire `user` alias is filled from the assignee.
        artifact: {
          ...(buildSessionListRecord().artifact as Record<string, unknown>),
          assignee: {
            id: "user-2",
            email: "grace@example.com",
            firstName: "Grace",
            lastName: "Hopper",
            avatarUrl: null,
          },
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
      }),
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
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

    // ISS-9112: the detail read resolves an id SET, so the artifact predicate is
    // an `in`. The org predicate it is ANDed with is the point of this
    // assertion and is unchanged.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: { in: ["session-2"] },
          artifact: { is: { organizationId: "org-1" } },
        },
      })
    );
  });

  describe("FEA-3284/FEA-3345 hide idle sessions (fail-open default)", () => {
    // ISS-5801 widened the substantive boundary: component invocations now
    // count as work, so both pinned shapes carry the new arm.
    const SUBSTANTIVE_OR = [
      { turns: { gt: 0 } },
      { inputTokens: { gt: 0 } },
      { outputTokens: { gt: 0 } },
      { cacheReadTokens: { gt: 0 } },
      { cacheWriteTokens: { gt: 0 } },
      { toolUseCount: { gt: 0 } },
      { componentInvocationCount: { gt: 0 } },
    ];
    const IDLE_AND = [
      { OR: [{ turns: null }, { turns: { lte: 0 } }] },
      { inputTokens: { lte: 0 } },
      { outputTokens: { lte: 0 } },
      { cacheReadTokens: { lte: 0 } },
      { cacheWriteTokens: { lte: 0 } },
      { toolUseCount: { lte: 0 } },
      { componentInvocationCount: { lte: 0 } },
    ];

    // FEA-3345 AC-1/AC-3: with no `quality` param the list is fail-open — it
    // does NOT AND the substantive predicate, so every ungated call site (the
    // dashboards/insights/feeds/telemetry that omit `quality`) shows idle rows.
    // This is the anti-regression pin: a future ungated surface can only ever
    // fail OPEN here, never silently inherit the hide filter.
    it("does NOT AND the substantive predicate by default (FEA-3345 fail-open, no quality param)", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      installDb({
        sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      });

      const where = findMany.mock.calls[0]?.[0].where as { AND?: unknown };
      expect(where.AND).toBeUndefined();
    });

    it("ANDs the substantive predicate only on an EXPLICIT quality=substantive", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      installDb({
        sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { quality: "substantive" },
      });

      const where = findMany.mock.calls[0]?.[0].where as {
        AND?: Record<string, unknown>[];
      };
      expect(where.AND).toEqual([{ OR: SUBSTANTIVE_OR }]);
    });

    it("omits the substantive predicate when quality=all reveals idle rows", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      installDb({
        sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { quality: "all" },
      });

      const where = findMany.mock.calls[0]?.[0].where as {
        AND?: unknown;
      };
      expect(where.AND).toBeUndefined();
    });

    // FEA-4145: the `idle` segment ANDs the null-safe idle complement into the
    // LIST where (the exact predicate `substantive` counts as hidden), so the
    // list returns ONLY the idle rows — never the substantive clause.
    it("ANDs the null-safe idle predicate on quality=idle", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      installDb({
        sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { quality: "idle" },
      });

      const where = findMany.mock.calls[0]?.[0].where as {
        AND?: Record<string, unknown>[];
      };
      expect(where.AND).toEqual([{ AND: IDLE_AND }]);
      // The substantive `gt:0` clause never appears on the idle segment.
      expect(JSON.stringify(where.AND)).not.toContain('"gt":0');
    });

    it("returns idleCount from a scoped idle count, and the list count is the substantive count", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      // First count() call → visible (substantive) total; second → idle count.
      const count = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(3);
      installDb({ sessionDetail: { findMany, count } });

      // FEA-3345: idle counting is driven by an EXPLICIT `substantive` (the
      // flag-gated Sessions list), not the fail-open default.
      const result = await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {
          quality: "substantive",
          startDate: "2026-06-18T00:00:00.000Z",
        },
      });

      expect(result.total).toBe(7);
      expect(result.idleCount).toBe(3);

      // The idle count carries every OTHER filter (the date window) plus the
      // null-safe idle complement — never the substantive clause.
      const idleWhere = count.mock.calls[1]?.[0].where as {
        AND?: Record<string, unknown>[];
      };
      expect(idleWhere.AND).toEqual([{ AND: IDLE_AND }]);
      const stringified = JSON.stringify(idleWhere.AND);
      expect(stringified).not.toContain('"gt":0');
    });

    it("skips the idle count and reports idleCount 0 when already showing all", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(5);
      installDb({ sessionDetail: { findMany, count } });

      const result = await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { quality: "all" },
      });

      expect(result.idleCount).toBe(0);
      // Only the list total count runs — no second idle count query.
      expect(count).toHaveBeenCalledTimes(1);
    });

    it("skips the idle count and reports idleCount 0 by default (FEA-3345 fail-open, no quality param)", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(5);
      installDb({ sessionDetail: { findMany, count } });

      const result = await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      });

      // Absent quality is fail-open (shows all) — nothing is hidden, so no
      // reveal label is computed and no second query runs.
      expect(result.idleCount).toBe(0);
      expect(count).toHaveBeenCalledTimes(1);
    });
  });

  describe("FEA-4298 Sessions surface cohort consistency (table vs summary cards)", () => {
    const START_DATE = "2026-06-18T00:00:00.000Z";
    const END_DATE = "2026-06-25T00:00:00.000Z";
    // The one date-window predicate both the table and the cards must window on
    // for this range: `lastActivityAt` in [start, end]. This is the SSOT the two
    // cohorts have to agree on. ISS-6463 made the column NOT NULL, so the
    // null-activity fallback branch that used to make this a disjunction (and
    // had to be applied IDENTICALLY by both paths) is gone.
    const EXPECTED_DATE_WINDOW = {
      gte: new Date(START_DATE),
      lte: new Date(END_DATE),
    };

    // Capture the WHERE the Sessions TABLE hands the DB for a given date range.
    async function captureListWhere(): Promise<Record<string, unknown>> {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });
      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { startDate: START_DATE, endDate: END_DATE, quality: "all" },
      });
      return findMany.mock.calls[0]?.[0].where as Record<string, unknown>;
    }

    // Capture the WHERE the SUMMARY CARDS hand the DB (the `getUsageSummary`
    // aggregate) for the same date range.
    async function captureSummaryWhere(): Promise<Record<string, unknown>> {
      const aggregate = vi.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 0,
        },
        _min: { sessionStartedAt: null },
        _max: { sessionStartedAt: null },
      });
      installDb({
        sessionDetail: buildAgentSessionDbMock({
          aggregate,
          groupBy: vi.fn().mockResolvedValue([]),
        }),
        agentSessionTokenUsage: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
        computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        loop: { findMany: vi.fn().mockResolvedValue([]) },
      });
      await agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        viewerId: "user-1",
        filters: { startDate: START_DATE, endDate: END_DATE, quality: "all" },
      });
      return aggregate.mock.calls[0]?.[0].where as Record<string, unknown>;
    }

    it("windows the summary-cards aggregate on the SAME lastActivityAt cohort the table lists (not sessionStartedAt)", async () => {
      const summaryWhere = await captureSummaryWhere();
      // The cards must window on lastActivityAt — NOT a bare `sessionStartedAt`
      // window. A `sessionStartedAt`-windowed summary would exclude a session
      // active-but-not-started in the range that the table still shows, so the
      // cards would summarize a different cohort.
      expect(summaryWhere.lastActivityAt).toEqual(EXPECTED_DATE_WINDOW);
      expect(summaryWhere.sessionStartedAt).toBeUndefined();
    });

    it("hands the table and the summary cards an IDENTICAL cohort predicate for the same date range", async () => {
      // Capture sequentially (installDb replaces the shared mock), then compare.
      const listWhere = await captureListWhere();
      vi.clearAllMocks();
      const summaryWhere = await captureSummaryWhere();

      // Same org scope, same date window, so the population the cards aggregate
      // is exactly the population the table lists — they reconcile for the
      // range.
      expect(summaryWhere).toEqual(listWhere);
      expect(listWhere.lastActivityAt).toEqual(EXPECTED_DATE_WINDOW);
    });
  });
});

describe("ISS-4481 Unknown-cost DB clause (buildWhere)", () => {
  // ISS-7176: `SESSION_COST_UNKNOWN_WHERE` is THE path now, not a fallback. The
  // list and summary used to strip `costBuckets` and route Unknown through the
  // reconciled candidate scan, so this clause ran only when that scan did not —
  // which is why these cases were written against `buildWhere` directly. They
  // now cover the only implementation, and it must still match
  // `matchesUnknownCost`.
  function findUnknownCostClause(
    where: Prisma.SessionDetailWhereInput
  ): Prisma.SessionDetailWhereInput | undefined {
    // `where.AND` is `WhereInput | WhereInput[] | undefined`; normalize to an
    // array so a single-clause AND is iterated the same way.
    const and = where.AND ?? [];
    const andClauses = Array.isArray(and) ? and : [and];
    for (const clause of andClauses) {
      // ISS-7176: the clause is now `{ AND: [ <cost disjunct>, <billing disjunct> ] }`
      // rather than a flat `estimatedCost` key, because a NULLABLE cost has to be
      // admitted by an explicit `{ estimatedCost: null }` OR-arm. Match on that
      // inner cost disjunct instead of the old flat key.
      const inner = (clause as Prisma.SessionDetailWhereInput).AND;
      const innerClauses = [inner ?? []].flat();
      const costDisjunct = innerClauses.find((c) =>
        ((c as Prisma.SessionDetailWhereInput).OR ?? []).some(
          (arm) =>
            (arm as { estimatedCost?: unknown }).estimatedCost !== undefined
        )
      );
      if (costDisjunct) {
        return clause as Prisma.SessionDetailWhereInput;
      }
    }
    return undefined;
  }

  it("includes null-billingMode rows AND no-work subscription rows (the — cases), the exact complement of KNOWN", async () => {
    // A bare `billingMode: { notIn: [...] }` evaluates to NULL (not TRUE) for a
    // NULL column in SQL, so it would silently DROP the most common unknown-cost
    // row. The clause must OR in an explicit `billingMode: null` branch. ISS-4481:
    // it must ALSO include a subscription session that did no measurable work — it
    // renders `—`, not `$0.00` — so the clause and `SESSION_COST_KNOWN_WHERE`
    // partition every row (the `subscription AND idle` disjunct).
    const where = await buildWhere(
      { organizationId: "org-1" },
      { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
      "lastActivityAt"
    );

    const unknownClause = findUnknownCostClause(where);
    expect(unknownClause).toBeDefined();
    // ISS-7176 restructured this from a flat `estimatedCost` key plus a sibling
    // `OR` into an `AND` of two disjuncts. The behaviour change that forced it:
    // `estimatedCost` is nullable now, and in SQL `NULL <= 0` is NULL rather than
    // TRUE — so the old bare `lte` matched no null row, and an unknown-cost
    // session would have fallen out of BOTH this clause and the KNOWN one.
    expect(unknownClause).toEqual({
      AND: [
        { OR: [{ estimatedCost: null }, { estimatedCost: { lte: 0 } }] },
        {
          OR: [
            { billingMode: null },
            { billingMode: { notIn: [...SUBSCRIPTION_BILLING_MODES] } },
            {
              AND: [
                { billingMode: { in: [...SUBSCRIPTION_BILLING_MODES] } },
                SESSION_IDLE_WHERE,
              ],
            },
          ],
        },
      ],
    });
  });

  it("does not add a cost clause when no cost filter is selected", async () => {
    const where = await buildWhere(
      { organizationId: "org-1" },
      {},
      "lastActivityAt"
    );
    expect(findUnknownCostClause(where)).toBeUndefined();
  });
});
