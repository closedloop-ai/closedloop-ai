/**
 * `getAnalytics` — the `/agent-sessions/analytics` breakdown reads.
 *
 * Split out of `analytics-aggregation.test.ts` while ISS-6823 changed how these
 * breakdowns are read. That file is about the pure fold helpers and the usage
 * SUMMARY; these are about the analytics ROUTE's population — which statements it
 * issues and which rows come back — so they are a separate responsibility, and
 * moving them leaves that suite meaningfully smaller.
 *
 * Row-level exactness against a real planner lives in
 * `apps/api/__tests__/integration/agent-session-analytics-breakdown-parity.test.ts`.
 * These suites mock `withDb` and so can never observe a wrong GROUP; what they
 * pin is the shape of the read and the projection of its result.
 */

import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildAnalyticsProjectAssignmentRecord,
  buildAnalyticsProjectSummaryRecord,
  buildAnalyticsSessionRecord,
  buildPersistedAgent,
  buildPersistedEvent,
  buildRepositoryGroupRow,
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

/**
 * The four mutually independent reads `getAnalytics` fans out (ISS-9113), named
 * by the delegate each one enters through. Sorted, because the assertion below
 * is about WHICH four started, never about the order they got there in.
 */
const ANALYTICS_READ_NAMES = [
  "attributionLinks",
  "projectAssignments",
  "repositoryGroups",
  "sessionPopulation",
] as const;

describe("agentSessionsService.getAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates analytics queries and counts tool coverage by session id", async () => {
    // ISS-6823: the Repository breakdown is a bounded aggregate now, so it
    // arrives as group rows rather than being folded out of the paged scan.
    const repositoryGroups = [
      buildRepositoryGroupRow({
        repositoryFullName: "closedloop-ai/closedloop-electron",
        sessionCount: 1,
        inputTokens: 30,
        outputTokens: 15,
        estimatedCost: 0.75,
        errorCount: 2,
      }),
      buildRepositoryGroupRow({
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sessionCount: 200,
        inputTokens: 2000,
        outputTokens: 1000,
        estimatedCost: 50,
        errorCount: 0,
      }),
      // The NULL group Postgres emits for sessions with no captured repository.
      // It must not become an option: there is nothing to filter to.
      buildRepositoryGroupRow({
        repositoryFullName: null,
        sessionCount: 7,
        inputTokens: 70,
        outputTokens: 35,
        estimatedCost: 1.75,
        errorCount: 1,
      }),
    ];
    // ISS-9113: ONE population, carrying the JSON columns and the token columns
    // together — the token values are the ones the retired second scan used to
    // supply, so `byProject` below is asserted against the same arithmetic.
    const sessionPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAnalyticsSessionRecord(index + 1, {
        inputTokens: 10n,
        outputTokens: 5n,
        estimatedCost: 0.25,
      })
    );
    sessionPageOne[0] = buildAnalyticsSessionRecord(1, {
      inputTokens: 10n,
      outputTokens: 5n,
      estimatedCost: 0.25,
      agents: [
        buildPersistedAgent({
          type: "main",
          status: "completed",
          endedAt: "2026-05-20T17:01:00.000Z",
        }),
      ],
      events: [buildPersistedEvent()],
    });
    sessionPageOne[1] = buildAnalyticsSessionRecord(2, {
      inputTokens: 10n,
      outputTokens: 5n,
      estimatedCost: 0.25,
      agents: [
        buildPersistedAgent({
          externalAgentId: "agent-2",
          type: "worker",
          status: "failed",
          endedAt: "2026-05-20T17:02:00.000Z",
        }),
      ],
      events: [
        // "tool_failure" has no "error" substring: it counts as an error only
        // because aggregateByTool classifies via the shared ERROR_EVENT_PATTERN
        // (/error|fail/i), matching the desktop countErrorEvents. Under the old
        // `includes("error")` classifier this would have been errorCount: 0,
        // so this row guards the web/desktop drift fix.
        buildPersistedEvent({
          externalEventId: "event-2",
          eventType: "tool_failure",
        }),
      ],
    });
    const sessionPageTwo = [
      buildAnalyticsSessionRecord(201, {
        inputTokens: 30n,
        outputTokens: 15n,
        estimatedCost: 0.75,
        events: [
          buildPersistedEvent({
            externalEventId: "event-201",
            toolName: "Bash",
          }),
        ],
      }),
    ];
    // ISS-7655: the attribution lenses no longer page sessions. ISS-9113: nor
    // does the Project breakdown, so this flow has ONE keyset pager, not two.
    const findMany = vi
      .fn()
      // Default AFTER the queued pages: a call beyond the expected two must
      // fail the call-count assertion below, not crash on an undefined result.
      .mockResolvedValue([])
      .mockResolvedValueOnce(sessionPageOne)
      .mockResolvedValueOnce(sessionPageTwo);
    const groupBy = vi.fn().mockResolvedValue(repositoryGroups);
    const artifactFindMany = vi
      .fn()
      .mockResolvedValue([
        ...Array.from({ length: 200 }, (_unused, index) =>
          buildAnalyticsProjectAssignmentRecord(index + 1, "project-1")
        ),
        buildAnalyticsProjectAssignmentRecord(201, "project-2"),
      ]);
    const projectFindMany = vi.fn().mockResolvedValue([
      buildAnalyticsProjectSummaryRecord(),
      buildAnalyticsProjectSummaryRecord({
        id: "project-2",
        name: "Desktop",
        slug: "desktop",
      }),
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        groupBy,
      }),
      artifact: { findMany: artifactFindMany },
      project: { findMany: projectFindMany },
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
    });

    await expect(
      agentSessionsService.getAnalytics({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      viewerScope: AgentSessionViewerScope.Organization,
      byTool: [
        {
          toolName: "Read",
          invocationCount: 2,
          errorCount: 1,
          sessionCount: 2,
        },
        {
          toolName: "Bash",
          invocationCount: 1,
          errorCount: 0,
          sessionCount: 1,
        },
      ],
      byAgentType: [
        {
          agentType: "main",
          count: 1,
          successCount: 1,
          failedCount: 0,
          avgDurationMs: 60_000,
        },
        {
          agentType: "worker",
          count: 1,
          successCount: 0,
          failedCount: 1,
          avgDurationMs: 120_000,
        },
      ],
      byRepository: [
        {
          repositoryFullName: "closedloop-ai/closedloop-ai",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
          errorCount: 0,
        },
        {
          repositoryFullName: "closedloop-ai/closedloop-electron",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
          errorCount: 2,
        },
      ],
      byProject: [
        {
          projectId: "project-1",
          projectName: "Agent Platform",
          projectSlug: "agent-platform",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
        },
        {
          projectId: "project-2",
          projectName: "Desktop",
          projectSlug: "desktop",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
        },
      ],
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
    // ISS-9113, the acceptance itself: 201 sessions, 201 of them
    // project-parented, read in TWO statements — one per keyset page of ONE
    // scan. The pre-fix code paged the SAME population twice under two
    // projections and issued four. This literal is the page count the seeded
    // population implies (ceil(201 / 200) = 2), not a number read back from the
    // code under test.
    expect(findMany).toHaveBeenCalledTimes(2);
    // ...and the 201 project-parented rows are no longer a second session scan:
    // the group key is one bounded artifact read plus one project read PER CHUNK
    // of distinct project ids, whatever the SESSION population size. The two
    // distinct projects seeded here fit one chunk, so the project side is one
    // statement — that 1 is the chunk count this seed implies, not a constant
    // the read guarantees for an org with more distinct projects than
    // `bindParameterChunkSize` admits.
    expect(artifactFindMany).toHaveBeenCalledTimes(1);
    expect(projectFindMany).toHaveBeenCalledTimes(1);
    // The rows that reached the folds: exactly the population, counted once.
    // `toHaveBeenCalledTimes` alone cannot see a page widened to re-read the
    // parented share, so assert what the scan actually returned.
    const readPages = await Promise.all(
      findMany.mock.results.map((result) => result.value as Promise<unknown[]>)
    );
    expect(readPages.reduce((total, page) => total + page.length, 0)).toBe(201);
  });

  it("ISS-6823: builds the analytics repository breakdown with no session rows read", async () => {
    // The load-bearing case: EVERY paged read returns nothing, so a breakdown
    // folded out of hydrated sessions could only be `[]`. `byRepository` is
    // still exact, which is only possible if it comes from the aggregate.
    const groupBy = vi.fn().mockResolvedValue([
      buildRepositoryGroupRow({
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sessionCount: 3,
        inputTokens: 300,
        outputTokens: 150,
        estimatedCost: 4.5,
        errorCount: 2,
      }),
      // A session population with no captured repository. The reduction this
      // replaced skipped those rows; the aggregate emits them as a NULL group,
      // and it must not surface as an option nobody can filter to.
      buildRepositoryGroupRow({
        repositoryFullName: null,
        sessionCount: 9,
        inputTokens: 900,
        outputTokens: 450,
        estimatedCost: 12.5,
        errorCount: 4,
      }),
      // The OTHER falsy name: `normalizeRepoFullName` persists `""` for a branch
      // ref naming the repository `.git`. The reduction dropped it on `!repo`;
      // `GROUP BY` gives it a group of its own, and it must not become a
      // nameless row holding real counts.
      buildRepositoryGroupRow({
        repositoryFullName: "",
        sessionCount: 5,
        inputTokens: 500,
        outputTokens: 250,
        estimatedCost: 6.25,
        errorCount: 3,
      }),
      // Prisma types every `_sum` field nullable regardless of the column's own
      // nullability, and `SessionDetail.errorCount` is `Int NOT NULL DEFAULT 0`,
      // so Postgres will not actually hand back a null here. This guards the
      // TYPE boundary the projection has to satisfy: a null must read as 0
      // errors, never leak into the contract as null.
      buildRepositoryGroupRow({
        repositoryFullName: "closedloop-ai/closedloop-electron",
        sessionCount: 1,
        inputTokens: 30,
        outputTokens: 15,
        estimatedCost: 0.3,
        errorCount: null,
      }),
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([]),
        groupBy,
      }),
    });

    const analytics = await agentSessionsService.getAnalytics({
      organizationId: "org-1",
      filters: {},
    });

    expect(analytics.byRepository).toEqual([
      {
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sessionCount: 3,
        inputTokens: 300,
        outputTokens: 150,
        estimatedCost: 4.5,
        errorCount: 2,
      },
      {
        repositoryFullName: "closedloop-ai/closedloop-electron",
        sessionCount: 1,
        inputTokens: 30,
        outputTokens: 15,
        estimatedCost: 0.3,
        errorCount: 0,
      },
    ]);
    // No sessions were hydrated, so the project fold has nothing to report —
    // and the repository breakdown above did not need them.
    expect(analytics.byProject).toEqual([]);
    // ONE statement for the whole repository dimension, whatever the population
    // size: the bounded-statement half of the acceptance. Row-level exactness is
    // proven against a real planner in
    // `__tests__/integration/agent-session-analytics-breakdown-parity.test.ts`.
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it("ISS-6823: scopes the analytics project read to project-parented sessions", async () => {
    // The narrowing is behavior-preserving by construction — `aggregateByProject`
    // already dropped every unparented session — so no returned row can witness
    // it. What CAN be witnessed is the predicate the read is issued under, which
    // is the bounded-population claim itself: without this clause the read is the
    // whole filtered corpus again and nothing else in the suite would notice.
    //
    // ISS-9113 moved the predicate to the ARTIFACT side — 1:1 with SessionDetail,
    // so the same rows — because the group key is read there now instead of by a
    // second session scan. The org scope still rides `where`, nested under
    // `session` rather than ANDed alongside; a read that dropped it would answer
    // for every organization.
    const artifactFindMany = vi.fn().mockResolvedValue([]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([]),
      }),
      artifact: { findMany: artifactFindMany },
    });

    await agentSessionsService.getAnalytics({
      organizationId: "org-1",
      filters: {},
    });

    expect(artifactFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          projectId: { not: null },
          session: {
            is: expect.objectContaining({
              artifact: expect.objectContaining({
                is: expect.objectContaining({ organizationId: "org-1" }),
              }),
            }),
          },
        },
      })
    );
  });

  it("ISS-9113: starts all four breakdown reads before any of them resolves", async () => {
    // thread davetho: the statement- and row-count assertions above are blind
    // to the OTHER half of ISS-9113. Re-serialising these four into the
    // sequential chain this replaced leaves every total in this suite identical,
    // so nothing here would notice the concurrency win being given back.
    //
    // Each read is therefore held at a barrier that opens only once all four
    // have STARTED. Concurrent, all four arrive and the barrier releases itself.
    // Serialized, the first read blocks and the other three are never reached —
    // `startedBeforeRelease` holds one name, and the assertion below names which
    // three went missing rather than hanging the suite.
    const startedBeforeRelease: string[] = [];
    let openBarrier = () => {
      // Replaced synchronously by the executor on the next line.
    };
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const holdUntilAllStarted = <T>(name: string, rows: T) =>
      vi.fn(async () => {
        startedBeforeRelease.push(name);
        if (startedBeforeRelease.length === ANALYTICS_READ_NAMES.length) {
          openBarrier();
        }
        await barrier;
        return rows;
      });

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        // The analytics population scan. The attribution read's own
        // `sessionDetail.findMany` is unreachable here: its `artifactLink`
        // probe resolves empty, so this delegate answers for exactly one read.
        findMany: holdUntilAllStarted("sessionPopulation", []),
        groupBy: holdUntilAllStarted("repositoryGroups", []),
      }),
      artifact: { findMany: holdUntilAllStarted("projectAssignments", []) },
      artifactLink: { findMany: holdUntilAllStarted("attributionLinks", []) },
    });

    const pending = agentSessionsService.getAnalytics({
      organizationId: "org-1",
      filters: {},
    });
    await flushPendingReads();
    const started = [...startedBeforeRelease].sort();
    // Unconditional, so a regression fails on the assertion below with the
    // missing read names instead of leaving `pending` forever unsettled.
    openBarrier();
    await expect(pending).resolves.toMatchObject({ byProject: [] });

    expect(started).toEqual([...ANALYTICS_READ_NAMES]);
  });
});

/**
 * Drain the queued async work of an in-flight request without releasing the
 * barrier the reads are held at, so what is captured afterwards is every read
 * that STARTED rather than every read that finished. Macrotask turns, not a
 * duration: nothing here asserts on elapsed time, and the reads under test
 * resolve from mocks with no real I/O to wait on.
 */
async function flushPendingReads(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
