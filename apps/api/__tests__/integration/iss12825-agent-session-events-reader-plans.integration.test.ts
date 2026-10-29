import { randomUUID } from "node:crypto";
import {
  decodeSessionEventCursor,
  type SessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import {
  requireIndexPredicate,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import { purgeFixtureOrganizations } from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explainCapturedStatement } from "@/__tests__/support/captured-statement-plan.test-helpers";
import {
  matching,
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { withFixtureRawClient } from "@/__tests__/utils/fixture-db";
import { persistSessionChildren } from "@/app/agent-sessions/service/persist-session-children";
import { findAgentSessionDetail } from "@/app/agent-sessions/service/session-detail-read";
import { readAgentSessionEventsPage } from "@/app/agent-sessions/service/session-events-page-read";
import {
  countEvents,
  fetchEventTypeBuckets,
  fetchEventVolume,
  fetchToolUsageBuckets,
} from "@/app/insights/service/event-queries";
import type { InsightsScopeContext } from "@/app/insights/service/scope";

/**
 * ISS-12825 — with the `(agent_session_id, event_created_at)` index dropped,
 * every reader that filters `agent_session_events` on `agent_session_id` still
 * seeks on the session, at the largest organization's production volume.
 *
 * The statements are captured from the real reads with their bound values and
 * re-planned with `EXPLAIN (ANALYZE, BUFFERS)`. The covering-index readers fail
 * on a sequential scan or any other index. The session detail read loads every
 * column and sorts, so it plans a bitmap scan on the
 * `(agent_session_id, external_event_id)` unique key, with or without the
 * dropped index; it fails on any access path that does not seek on the session.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EVENTS_TABLE = "agent_session_events";
const COVERING_INDEX = "agent_session_events_session_time_cover_idx";
const DROPPED_INDEX =
  "agent_session_events_agent_session_id_event_created_at_idx";
const SESSION_SEEK = "agent_session_id =";
const EVENTS_TABLE_PATTERN = /agent_session_events/;
const READ_STATEMENT_PATTERN = /^\s*(SELECT|WITH)\b/i;
const FIXTURE_CLERK_PREFIX = "org_iss12825_plan_";

// The largest organization's 90-day volume in production, read 2026-10-23
// 02:30Z through the read-only proof role: 20,348 sessions active in the
// window holding 3,664,779 events, the busiest session 59,141 of them.
const SESSIONS = 20_348;
const EVENTS = 3_664_779;
const LARGEST_SESSION_EVENTS = 59_141;

const WINDOW_START = new Date("2026-04-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const WINDOW_SECONDS = (WINDOW_END.getTime() - WINDOW_START.getTime()) / 1000;

// The tier bounds every hook at 30 s and allows no longer one
// (`integration-suite-timeout-budget.test.ts`), so the 3.66M-row event insert
// runs in chunks. One append-ordered insert of all of them took 33.4 s locally
// (Apple M1 Max, load average 29). Datadog CI suite durations for four
// seeding suites ran up to 1.62x this machine (document-list-deep-offset:
// 3.70 s CI max over 14 days, 2.28 s here). With the measured-lane rule's 0.6
// headroom (`MIN_LANE_TIMEOUT_MINUTES`,
// scripts/deploy/script-lane-wedge-legibility.test.ts), a chunk may take
// 30 s x 0.6 / 1.62 = 11.1 s here, so 33.4 s needs four. Three runs of the
// four chunks measured 7.0-7.8 s each.
const EVENT_SEED_CHUNKS = 4;

type Fixture = {
  ctx: InsightsScopeContext;
  largestSessionId: string;
  runTag: string;
};

type Page = { organizationId: string; id: string };

describeIfDb("agent_session_events reader plans (ISS-12825)", () => {
  let fixture: Fixture;
  const statements = new Map<Reader, ObservedStatement[]>();

  beforeAll(async () => {
    await purge();
    fixture = await seedSessions();
  });

  for (let chunk = 0; chunk < EVENT_SEED_CHUNKS; chunk += 1) {
    beforeAll(() => seedEventChunk(fixture, chunk));
  }

  // VACUUM sets the visibility map, as autovacuum has in production, so
  // index-only scans are costed as such. PARALLEL 0: a parallel index vacuum at
  // this size needs more dynamic shared memory than a default Docker Postgres
  // has. Three local runs took 0.51-0.74 s (Postgres statement log, same
  // machine, load average 16-25), under the 11.1 s cap above (1.20 s at 1.62x).
  beforeAll(() =>
    withFixtureRawClient("the ISS-12825 fixture VACUUM", (client) =>
      client.$executeRawUnsafe(
        `VACUUM (ANALYZE, PARALLEL 0) ${EVENTS_TABLE}, session_detail, artifacts`
      )
    )
  );

  beforeAll(async () => {
    const page = {
      organizationId: fixture.ctx.organizationId,
      id: fixture.largestSessionId,
    };
    const cursor = await secondPageCursor(page);
    for (const [reader, read] of readers(fixture, page, cursor)) {
      statements.set(reader, await captureReads(read));
    }
  });

  // The purge's DELETEs and its VACUUM FULL took 6.6-7.7 s in the same three
  // runs, the 3.66M-row event DELETE 2.7-3.5 s of it, under the 11.1 s cap
  // above (12.5 s at 1.62x).
  afterAll(async () => {
    await purge();
  });

  it("plans against a schema without the dropped index", async () => {
    const present = await withDb((db) =>
      db.$queryRawUnsafe<{ indexname: string }[]>(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        EVENTS_TABLE,
        DROPPED_INDEX
      )
    );
    expect(present).toEqual([]);
  });

  it.each(COVERING_INDEX_READERS)(
    "%s plans on the covering index",
    async (reader) => {
      const captured = statements.get(reader) ?? [];
      expect(captured.length).toBeGreaterThan(0);
      for (const [index, statement] of captured.entries()) {
        expect(statement.rows, `statement ${index}`).toBeGreaterThan(0);
        const plan = await explainCapturedStatement(statement, reader);
        expect(
          requireScanNode(plan, EVENTS_TABLE),
          `statement ${index}`
        ).toContain(`using ${COVERING_INDEX}`);
      }
    }
  );

  it("findAgentSessionDetail seeks on the session", async () => {
    const captured = statements.get(SESSION_DETAIL_READER) ?? [];
    expect(captured.length).toBeGreaterThan(0);
    for (const [index, statement] of captured.entries()) {
      expect(statement.rows, `statement ${index}`).toBeGreaterThan(0);
      const plan = await explainCapturedStatement(
        statement,
        SESSION_DETAIL_READER
      );
      expect(
        requireIndexPredicate(plan, EVENTS_TABLE),
        `statement ${index}`
      ).toContain(SESSION_SEEK);
    }
  });
});

const COVERING_INDEX_READERS = [
  "countEvents",
  "fetchEventVolume",
  "fetchEventTypeBuckets",
  "fetchToolUsageBuckets",
  "readAgentSessionEventsPage",
  "readAgentSessionEventsPage (cursor)",
  "persistSessionChildren",
] as const;
const SESSION_DETAIL_READER = "findAgentSessionDetail";

type Reader =
  | (typeof COVERING_INDEX_READERS)[number]
  | typeof SESSION_DETAIL_READER;

/** Rolls back the persist transaction once its reads have been captured. */
class CapturedPersistRollback extends Error {}

function readers(
  fixture: Fixture,
  page: Page,
  cursor: SessionEventCursor
): [Reader, () => Promise<unknown>][] {
  const { ctx, largestSessionId } = fixture;
  return [
    ["countEvents", () => countEvents(ctx, WINDOW_START, WINDOW_END)],
    [
      "fetchEventVolume",
      () => fetchEventVolume(ctx, WINDOW_START, WINDOW_END, "UTC"),
    ],
    [
      "fetchEventTypeBuckets",
      () => fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END),
    ],
    [
      "fetchToolUsageBuckets",
      () => fetchToolUsageBuckets(ctx, WINDOW_START, WINDOW_END),
    ],
    ["readAgentSessionEventsPage", () => readAgentSessionEventsPage(page)],
    [
      "readAgentSessionEventsPage (cursor)",
      () => readAgentSessionEventsPage({ ...page, cursor }),
    ],
    [SESSION_DETAIL_READER, () => findAgentSessionDetail(page)],
    [
      "persistSessionChildren",
      () =>
        withDb
          .tx(async (tx) => {
            await persistSessionChildren(
              tx,
              largestSessionId,
              ctx.organizationId,
              {
                externalSessionId: largestSessionId,
                status: SESSION_STATUS.INACTIVE,
                startedAt: WINDOW_START.toISOString(),
                updatedAt: WINDOW_END.toISOString(),
                agents: [],
                events: [],
                tokenUsageByModel: [],
              },
              [],
              {
                guardedStatus: SESSION_STATUS.INACTIVE,
                shouldReplace: false,
                shouldUpdateTokenEventCosts: false,
              }
            );
            throw new CapturedPersistRollback();
          })
          .catch((error: unknown) => {
            if (!(error instanceof CapturedPersistRollback)) {
              throw error;
            }
          }),
    ],
  ];
}

/** The read statements a reader issued against the events table. */
async function captureReads(
  read: () => Promise<unknown>
): Promise<ObservedStatement[]> {
  const { statements } = await observeStatements(read);
  return matching(statements, EVENTS_TABLE_PATTERN).filter((statement) =>
    READ_STATEMENT_PATTERN.test(statement.sql)
  );
}

async function secondPageCursor(page: Page): Promise<SessionEventCursor> {
  const first = await readAgentSessionEventsPage(page);
  const cursor = decodeSessionEventCursor(first?.nextCursor);
  if (!cursor) {
    throw new Error("The largest session served no continuation cursor.");
  }
  return cursor;
}

async function seedSessions(): Promise<Fixture> {
  const organizationId = await createTestOrganization({
    clerkId: `${FIXTURE_CLERK_PREFIX}${randomUUID()}`,
  });
  const user = await createTestUser(organizationId);
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `iss12825-plan-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  // Ids are a run tag plus the session and event ordinals, and event times
  // rise with them, so every index on the table is filled in key order.
  const runTag = randomUUID().replaceAll("-", "").slice(0, 12);

  await withFixtureRawClient("the ISS-12825 session seed", async (client) => {
    await client.$executeRawUnsafe(
      `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
       SELECT ($1 || lpad(to_hex(s), 8, '0') || '000000000000')::uuid,
              $2::uuid, $3::"ArtifactType", 'iss12825-plan-session-' || s, $4, now()
         FROM generate_series(1, $5::int) s`,
      runTag,
      organizationId,
      ArtifactType.SESSION,
      SESSION_STATUS.INACTIVE,
      SESSIONS
    );
    await client.$executeRawUnsafe(
      `INSERT INTO session_detail (artifact_id, compute_target_id, external_session_id,
         session_started_at, session_updated_at, updated_at, last_activity_at)
       SELECT ($1 || lpad(to_hex(s), 8, '0') || '000000000000')::uuid,
              $2::uuid, 'iss12825-plan-' || $1 || '-' || s, $3, $3, now(), $4
         FROM generate_series(1, $5::int) s`,
      runTag,
      computeTarget.id,
      WINDOW_START,
      WINDOW_END,
      SESSIONS
    );
  });

  return {
    ctx: { organizationId, userId: user.id, scope: InsightsScope.Org },
    largestSessionId: asUuid(`${runTag}00000001000000000000`),
    runTag,
  };
}

/**
 * The events of every session whose first event falls in this chunk's share of
 * the population. Session 1 carries the largest session's events; the rest are
 * spread evenly over the other sessions, the first `remainder` taking one extra.
 * `before` is the count of events in the sessions ahead of `s`, so event times
 * spread over the window in insertion order.
 */
function seedEventChunk(fixture: Fixture, chunk: number): Promise<number> {
  const perSession = Math.floor(
    (EVENTS - LARGEST_SESSION_EVENTS) / (SESSIONS - 1)
  );
  const remainder = (EVENTS - LARGEST_SESSION_EVENTS) % (SESSIONS - 1);
  return withFixtureRawClient("the ISS-12825 event seed", (client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_session_events
         (id, agent_session_id, external_event_id, event_type, tool_name, event_created_at)
       SELECT ($1 || lpad(to_hex(s), 8, '0') || lpad(to_hex(n), 12, '0'))::uuid,
              ($1 || lpad(to_hex(s), 8, '0') || '000000000000')::uuid,
              lpad(n::text, 6, '0'),
              (ARRAY['tool_use', 'assistant_message', 'user_message'])[1 + n % 3],
              (ARRAY['Read', 'Edit', NULL])[1 + n % 3],
              $2::timestamp + ((k.before + n) * $3::bigint / $4::bigint) * interval '1 second'
         FROM generate_series(1, $5::int) s
        CROSS JOIN LATERAL (
          SELECT
            CASE WHEN s = 1 THEN $6::bigint
                 WHEN s - 1 <= $7::int THEN $8::bigint + 1
                 ELSE $8::bigint
            END AS c,
            CASE WHEN s = 1 THEN 0::bigint
                 ELSE $6::bigint + (s - 2) * $8::bigint + LEAST(s - 2, $7::int)
            END AS before
        ) k
        CROSS JOIN LATERAL generate_series(1, k.c) n
        WHERE k.before >= $9::bigint AND k.before < $10::bigint`,
      fixture.runTag,
      WINDOW_START,
      WINDOW_SECONDS,
      EVENTS,
      SESSIONS,
      LARGEST_SESSION_EVENTS,
      remainder,
      perSession,
      Math.floor((EVENTS * chunk) / EVENT_SEED_CHUNKS),
      Math.floor((EVENTS * (chunk + 1)) / EVENT_SEED_CHUNKS)
    )
  );
}

function purge(): Promise<void> {
  const selector = "SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%'";
  const scope = `(${selector})`;
  const sessions = `(SELECT id FROM artifacts WHERE organization_id IN ${scope})`;
  return withFixtureRawClient("the ISS-12825 fixture purge", (client) =>
    purgeFixtureOrganizations(client, {
      selector,
      leafDeletes: [
        `DELETE FROM agent_session_events WHERE agent_session_id IN ${sessions}`,
        `DELETE FROM session_detail WHERE artifact_id IN ${sessions}`,
        `DELETE FROM artifacts WHERE organization_id IN ${scope}`,
        `DELETE FROM compute_targets WHERE organization_id IN ${scope}`,
        `DELETE FROM users WHERE organization_id IN ${scope}`,
      ],
      values: [FIXTURE_CLERK_PREFIX],
      label: `${FIXTURE_CLERK_PREFIX} fixture sweep failed`,
    })
  );
}

/** 32 hex digits in the hyphenated form Prisma's uuid parameters accept. */
function asUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
