import { SESSION_UNKNOWN_COST_BUCKET_ID } from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionDetailRecord,
  buildSessionListRecord,
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
  it("derives the Waiting facet from awaitingInputSince, not a persisted status (FEA-3035)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { statuses: [DISPLAYED_SESSION_STATUS.WAITING], quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // "waiting" is never persisted — an awaiting-input session is a non-terminal
    // status plus an awaitingInputSince timestamp and no sessionEndedAt, matching
    // both desktop paths and the toAgentSessionState projection (which only
    // reports PendingApproval while !sessionEndedAt). ISS-5592: the terminal set
    // is {inactive,error} — the retired pair left it because no row can store one.
    expect(where.AND).toEqual([
      {
        awaitingInputSince: { not: null },
        sessionEndedAt: null,
        artifact: {
          is: {
            status: { notIn: ["inactive", "error"] },
          },
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
      filters: { status: SESSION_STATUS.ACTIVE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // Active is status='active' AND not awaiting input, so awaiting-input
    // sessions desktop excludes are excluded on the web too.
    //
    // ISS-5366 adds the third condition: a row silent past the display
    // staleness cutoff DISPLAYS as Stale, so it must leave the Active bucket.
    // The cutoff instant is computed per call, so the timestamps are matched
    // structurally rather than pinned.
    expect(where.AND).toEqual([
      {
        awaitingInputSince: null,
        artifact: { is: { status: "active" } },
        NOT: {
          OR: [
            // ISS-4556: `not: null` beside the cutoff. `lastActivityAt` is
            // nullable, so a bare `last_activity_at < $cutoff` is SQL NULL — not
            // false — for a null row, and this whole disjunction is NEGATED
            // here. `NOT NULL` is NULL, which `WHERE` rejects, so a row with no
            // activity timestamp and a fresh `sessionStartedAt` was returned by
            // neither the Active nor the Stale facet while displaying Active.
            { lastActivityAt: { not: null, lt: expect.any(Date) } },
            {
              lastActivityAt: null,
              sessionStartedAt: { lt: expect.any(Date) },
            },
          ],
        },
      },
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
        // ISS-4985: `running` rather than `completed`. A RETIRED spelling is no
        // longer a "plain" status — it now routes to the Inactive predicate (see
        // the test below) — so using one here would assert the opposite of the
        // shipped behavior. `running` is the remaining shape this test is about:
        // a real legacy alias with no facet branch of its own.
        statuses: [DISPLAYED_SESSION_STATUS.WAITING, "running"],
        quality: "all",
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
          is: {
            status: { notIn: ["inactive", "error"] },
          },
        },
      },
      { artifact: { is: { status: "running" } } },
    ]);
  });

  it("keeps the Inactive facet a plain equality, not a widening onto the retired pair (ISS-5592)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: SESSION_STATUS.INACTIVE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    // ISS-4586 had this widen onto `completed`/`abandoned` so the facet reached
    // not-yet-migrated rows. ISS-5981's total ingest fold removed the producer of
    // such a row and the ISS-4654 backfill collapsed the rest, so the widening
    // matched a population that cannot exist — and made the cloud disagree with
    // desktop, which never widened. This asserts the narrowed shape so the union
    // cannot come back unnoticed.
    expect(where.AND).toEqual([
      { artifact: { is: { status: SESSION_STATUS.INACTIVE } } },
    ]);
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
      filters: { startDate, endDate, quality: "all" },
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
      OR: [
        { lastActivityAt: range },
        { lastActivityAt: null, sessionStartedAt: range },
      ],
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
        OR?: unknown;
      };
      // The date window lands on lastActivityAt (its own field) while the
      // completion boundary lands on sessionEndedAt — the two are independent
      // predicates, so a session started-before-but-completed-after the boundary
      // is not silently dropped by the started-at window.
      expect(where.OR).toEqual([
        { lastActivityAt: { gte: new Date(startDate) } },
        {
          lastActivityAt: null,
          sessionStartedAt: { gte: new Date(startDate) },
        },
      ]);
      expect(where.AND).toEqual([
        { sessionEndedAt: { gte: new Date(completedAfter) } },
      ]);
    });
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

  describe("FEA-3284/FEA-3345 hide idle sessions (fail-open default)", () => {
    const SUBSTANTIVE_OR = [
      { turns: { gt: 0 } },
      { inputTokens: { gt: 0 } },
      { outputTokens: { gt: 0 } },
      { cacheReadTokens: { gt: 0 } },
      { cacheWriteTokens: { gt: 0 } },
      { toolUseCount: { gt: 0 } },
    ];
    const IDLE_AND = [
      { OR: [{ turns: null }, { turns: { lte: 0 } }] },
      { inputTokens: { lte: 0 } },
      { outputTokens: { lte: 0 } },
      { cacheReadTokens: { lte: 0 } },
      { cacheWriteTokens: { lte: 0 } },
      { toolUseCount: { lte: 0 } },
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
    // for this range: `lastActivityAt` in [start, end], with the null-safe
    // fallback to `sessionStartedAt` for pre-backfill rows (a null-activity
    // session is kept, and kept IDENTICALLY, by both paths). This is the SSOT
    // the two cohorts have to agree on.
    const EXPECTED_DATE_WINDOW = [
      {
        lastActivityAt: {
          gte: new Date(START_DATE),
          lte: new Date(END_DATE),
        },
      },
      {
        lastActivityAt: null,
        sessionStartedAt: {
          gte: new Date(START_DATE),
          lte: new Date(END_DATE),
        },
      },
    ];

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
      // The cards must window on lastActivityAt with the null-safe fallback —
      // NOT a bare `sessionStartedAt` window. A `sessionStartedAt`-windowed
      // summary would exclude a session active-but-not-started in the range that
      // the table still shows, so the cards would summarize a different cohort.
      expect(summaryWhere.OR).toEqual(EXPECTED_DATE_WINDOW);
      expect(summaryWhere.sessionStartedAt).toBeUndefined();
    });

    it("hands the table and the summary cards an IDENTICAL cohort predicate for the same date range", async () => {
      // Capture sequentially (installDb replaces the shared mock), then compare.
      const listWhere = await captureListWhere();
      vi.clearAllMocks();
      const summaryWhere = await captureSummaryWhere();

      // Same org scope, same date window (incl. the null-activity fallback
      // branch), so the population the cards aggregate is exactly the population
      // the table lists — they reconcile for the range.
      expect(summaryWhere).toEqual(listWhere);
      expect(listWhere.OR).toEqual(EXPECTED_DATE_WINDOW);
    });
  });
});

describe("ISS-4481 Unknown-cost DB clause (buildWhere)", () => {
  // The DB twin `SESSION_COST_UNKNOWN_WHERE` is a fallback (the list/summary paths
  // route Unknown through the reconciled path with `costBuckets` stripped), but it
  // must still match `matchesUnknownCost`. Drive `buildWhere` directly with an
  // un-stripped Unknown filter and assert the emitted clause is null-safe.
  function findUnknownCostClause(
    where: Prisma.SessionDetailWhereInput
  ): Prisma.SessionDetailWhereInput | undefined {
    // `where.AND` is `WhereInput | WhereInput[] | undefined`; normalize to an
    // array so a single-clause AND is iterated the same way.
    const and = where.AND ?? [];
    const andClauses = Array.isArray(and) ? and : [and];
    for (const clause of andClauses) {
      const estimatedCost = (clause as Prisma.SessionDetailWhereInput)
        .estimatedCost as { lte?: number } | undefined;
      if (estimatedCost?.lte === 0) {
        return clause as Prisma.SessionDetailWhereInput;
      }
    }
    return undefined;
  }

  it("includes null-billingMode rows AND no-work subscription rows (the — cases), the exact complement of KNOWN", () => {
    // A bare `billingMode: { notIn: [...] }` evaluates to NULL (not TRUE) for a
    // NULL column in SQL, so it would silently DROP the most common unknown-cost
    // row. The clause must OR in an explicit `billingMode: null` branch. ISS-4481:
    // it must ALSO include a subscription session that did no measurable work — it
    // renders `—`, not `$0.00` — so the clause and `SESSION_COST_KNOWN_WHERE`
    // partition every row (the `subscription AND idle` disjunct).
    const where = buildWhere(
      { organizationId: "org-1" },
      { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
      "lastActivityAt"
    );

    const unknownClause = findUnknownCostClause(where);
    expect(unknownClause).toBeDefined();
    expect(unknownClause).toEqual({
      estimatedCost: { lte: 0 },
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
    });
  });

  it("does not add a cost clause when no cost filter is selected", () => {
    const where = buildWhere({ organizationId: "org-1" }, {}, "lastActivityAt");
    expect(findUnknownCostClause(where)).toBeUndefined();
  });
});
