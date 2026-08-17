import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { persistSessionChildren } from "./persist-session-children";

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

describe("agentSessionsService child event persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ISS-4439: forwards the SELECT's MAX(event_created_at) into the UPDATE $5 and reads last_activity_at back from the RETURNING row", async () => {
    // Direct persistSessionChildren call so the returned lastActivityAt (which
    // upsertSessions discards) is observable. The two $queryRawUnsafe calls
    // return DISTINCT rows keyed on their SQL, and the three constants are all
    // distinct — so the SELECT's event-max, the session start, and the UPDATE's
    // RETURNING value can never be confused for one another. This is exactly the
    // discrimination the earlier "same SELECT-shaped row for both calls" mock
    // lacked: with identical rows, the test could pass even if the code never
    // forwarded the event-max into $5 or read last_activity_at from RETURNING.
    const selectedMaxEventAt = new Date("2026-05-20T18:30:00.000Z");
    // Deliberately later than both the event-max and the session start, so it
    // can ONLY have come from the RETURNING row — never re-derived in JS.
    const returnedLastActivityAt = new Date("2026-05-20T19:00:00.000Z");
    const queryRawUnsafe = vi.fn().mockImplementation((sql: string) => {
      if (String(sql).includes(`UPDATE "session_detail"`)) {
        return Promise.resolve([{ lastActivityAt: returnedLastActivityAt }]);
      }
      return Promise.resolve([
        {
          toolUseCount: 2n,
          errorCount: 1n,
          maxEventCreatedAt: selectedMaxEventAt,
        },
      ]);
    });
    // events:[] + shouldReplace:false + empty tokenUsage keeps the child writes
    // (INSERT / deleteMany / token lanes) off, so the only raw round-trips are
    // the counts SELECT and the UPDATE ... RETURNING under test.
    //
    // shafty023: count EVERY DB round-trip, not just $queryRawUnsafe, so a
    // reintroduced per-session ownership query (e.g. an artifact.findFirst
    // boundary check) — which would regress the 4-to-2 collapse — is caught.
    // Every delegate this helper could reach is spied; ownership is proven once
    // at the caller's compute-target check, so NONE of them (in particular
    // artifact.findFirst) may fire on this path.
    const artifactFindFirst = vi.fn();
    const executeRawUnsafe = vi.fn();
    const otherDbDelegates = {
      artifact: { findFirst: artifactFindFirst },
      agentSessionEvent: { deleteMany: vi.fn() },
      agentSessionTokenUsage: { deleteMany: vi.fn(), createMany: vi.fn() },
      agentSessionTokenEvent: { createMany: vi.fn() },
      agentSessionActivitySegment: {
        findFirst: vi.fn(),
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      agentSessionUsageRollup: { upsert: vi.fn() },
    };
    const tx = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
      ...otherDbDelegates,
    } as unknown as Parameters<typeof persistSessionChildren>[0];
    const result = await persistSessionChildren(
      tx,
      "persisted-session-1",
      "org-1",
      buildSyncedSession({ events: [] }),
      [],
      { shouldReplace: false, shouldUpdateTokenEventCosts: false }
    );

    // Exactly two DB round-trips total — the counts SELECT and the UPDATE — with
    // NO extra ownership query. Sum across every spied delegate, not just the
    // raw lane, so the count is faithful (shafty023).
    const seg = otherDbDelegates.agentSessionActivitySegment;
    const tokenUsage = otherDbDelegates.agentSessionTokenUsage;
    const allDbSpies = [
      queryRawUnsafe,
      executeRawUnsafe,
      artifactFindFirst,
      otherDbDelegates.agentSessionEvent.deleteMany,
      tokenUsage.deleteMany,
      tokenUsage.createMany,
      otherDbDelegates.agentSessionTokenEvent.createMany,
      seg.findFirst,
      seg.deleteMany,
      seg.createMany,
      otherDbDelegates.agentSessionUsageRollup.upsert,
    ];
    const totalDbRoundTrips = allDbSpies.reduce(
      (sum, spy) => sum + spy.mock.calls.length,
      0
    );
    expect(totalDbRoundTrips).toBe(2);
    // No per-session ownership round-trip: ownership is the caller's single
    // compute-target check, never an artifact lookup in this hot path.
    expect(artifactFindFirst).not.toHaveBeenCalled();
    // Exactly two round-trips: the collapse's whole point.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [countsSql] = queryRawUnsafe.mock.calls[0] ?? [];
    expect(String(countsSql)).toContain(`MAX("event_created_at")`);
    const [updateSql, ...updateParams] = queryRawUnsafe.mock.calls[1] ?? [];
    expect(String(updateSql)).toContain(`UPDATE "session_detail"`);
    expect(String(updateSql)).toContain(`RETURNING "last_activity_at"`);
    // $2/$3 = the counts read out of the SELECT row; $5 = its event-max, forwarded
    // into the GREATEST. If the code stopped forwarding, $5 would not equal the
    // SELECT's max and this fails.
    expect(updateParams[1]).toBe(2);
    expect(updateParams[2]).toBe(1);
    expect(updateParams[4]).toEqual(selectedMaxEventAt);
    // The return object is sourced from the two DISTINCT rows: maxEventCreatedAt
    // from the SELECT, lastActivityAt from the UPDATE RETURNING. Reverting to a
    // single shared row, or re-deriving lastActivityAt in JS instead of reading
    // RETURNING, would break at least one of these equalities.
    expect(result.maxEventCreatedAt).toEqual(selectedMaxEventAt);
    expect(result.lastActivityAt).toEqual(returnedLastActivityAt);
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
      // FEA-3477: the upsert's `existing` select now also reads the parent
      // artifact status (for the terminal-status-wins guard) plus the session
      // time columns, so the mock mirrors that shape.
      artifact: { status: "active" },
      sessionStartedAt: null,
      sessionUpdatedAt: null,
      sessionEndedAt: null,
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
