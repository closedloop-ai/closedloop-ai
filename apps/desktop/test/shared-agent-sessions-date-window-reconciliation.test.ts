/**
 * @file shared-agent-sessions-date-window-reconciliation.test.ts
 * @description ISS-5443 — the desktop Sessions date window is ONE cohort.
 *
 * The KPI ("Sessions" summary card) sits directly above the list it summarizes,
 * so for a given `startDate`/`endDate` the two must describe the same
 * population. They did not: the list clause bounded on `last_activity_at`, the
 * usage/KPI aggregate bounded on `started_at`, and the hydrated
 * `matchesDateBounds` fold bounded on `startedAt` — so a session that STARTED
 * before the window but was ACTIVE inside it appeared in the list and was
 * missing from the KPI. Measured on a 3,154-session local corpus at the time of
 * the fix: a 1-day window listed 4 sessions and counted 2.
 *
 * These tests reconcile the two reads DIRECTLY — same seeded population, same
 * request, `usage.totalSessions === list.total` — rather than asserting each
 * against a constant, and they do it across every combination of the SQL and
 * hydrated implementations, because which one answers depends on the filters:
 *
 *   | filters              | list         | usage        |
 *   | -------------------- | ------------ | ------------ |
 *   | (none)               | SQL cursor   | SQL aggregate|
 *   | search               | SQL cursor   | hydrated fold|
 *   | statuses             | hydrated fold| SQL aggregate|
 *   | search + statuses    | hydrated fold| hydrated fold|
 *
 * A basis that reverts on ANY ONE of the three paths breaks at least one row of
 * that table. Everything runs against the real production `db.syncSource` over a
 * real migrated SQLite database, so the SQL under test is the SQL that ships.
 *
 * Every case pins an explicit `sortBy`, and keeps doing so after goal stage 1b.
 * The original reason was that `canUseListCursorPage` REQUIRED a cursor sort
 * column, so a request without one silently answered the "SQL cursor" rows from
 * the hydrated fold instead — which is exactly how an earlier draft of this file
 * passed with the list's own SQL clause reverted. Stage 1b removed that specific
 * trap (an unsorted read now pages by `SessionListCursorSortKey.Updated`), but
 * pinning the sort is still what makes each case name the path it is testing
 * rather than inherit whatever the default happens to be.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type AgentSessionUsageAggregateFilters,
  SessionListCursorSortKey,
} from "../src/main/agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  SESSIONS_ANALYTICS_DATE_WINDOW_FIELD,
  SESSIONS_SURFACE_DATE_WINDOW_FIELD,
} from "../src/main/agent-sync/session-date-window.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../src/main/session/shared-agent-sessions-api.js";
import type { SharedAgentSessionsListRequest } from "../src/shared/shared-agent-sessions-contract.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

// The window under test. `IN_WINDOW_*` bracket it; `BEFORE_WINDOW` is outside.
const WINDOW_START = "2026-06-10T00:00:00.000Z";
const WINDOW_END = "2026-06-17T00:00:00.000Z";
const BEFORE_WINDOW = "2026-06-01T09:00:00.000Z";
const IN_WINDOW_EARLY = "2026-06-11T09:00:00.000Z";
const IN_WINDOW_LATE = "2026-06-16T09:00:00.000Z";
const AFTER_WINDOW = "2026-07-01T09:00:00.000Z";

// Shared token so a `search` filter selects the whole seeded population and
// changes only WHICH implementation answers, never which rows qualify.
const SEARCH_TOKEN = "reconcile";

/** The session the defect hid: started before the window, active inside it. */
const STRADDLING_SESSION_ID = "s-straddles-window-start";

/** Every seeded id, for the explicit-id request shape. */
const ALL_SESSION_IDS = [
  STRADDLING_SESSION_ID,
  "s-inside-early",
  "s-inside-late",
  "s-entirely-before",
  "s-entirely-after",
];

type SeedSession = {
  id: string;
  startedAt: string;
  lastActivityAt: string;
  status?: string;
};

/**
 * Seed one session in the shape the write path actually produces: an `events`
 * row at the activity instant AND the denormalized `last_activity_at` column set
 * to it. `recomputeSessionLastActivityAt` maintains the column as
 * `MAX(started_at floor, MAX(events.created_at))` inside the same ingest
 * transaction, so a row whose activity is later than its start MUST have an
 * event there — a fixture that sets only the column describes a store that
 * cannot exist, and would let the full-hydration path (which re-derives from
 * events) and the SQL path disagree for a reason production never has.
 */
async function insertSession(db: SqliteDb, seed: SeedSession): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, name, status, started_at, updated_at, last_activity_at, harness, billing_mode)
     VALUES ($1, $2, $3, $4, $5, $6, 'claude', 'api')`,
    seed.id,
    `${SEARCH_TOKEN}-${seed.id}`,
    seed.status ?? "inactive",
    seed.startedAt,
    seed.lastActivityAt,
    seed.lastActivityAt
  );
  await db.run(
    `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
     VALUES ($1, $2, 'user', NULL, $3)`,
    `${seed.id}-evt`,
    seed.id,
    seed.lastActivityAt
  );
}

/**
 * The population. Two rows are inside the window on BOTH bases, one straddles
 * the window start (the defect), and two are outside on both bases — so a basis
 * regression changes the total rather than merely reordering it.
 */
async function seedPopulation(db: SqliteDb): Promise<void> {
  await insertSession(db, {
    id: STRADDLING_SESSION_ID,
    startedAt: BEFORE_WINDOW,
    lastActivityAt: IN_WINDOW_LATE,
  });
  await insertSession(db, {
    id: "s-inside-early",
    startedAt: IN_WINDOW_EARLY,
    lastActivityAt: IN_WINDOW_EARLY,
  });
  await insertSession(db, {
    id: "s-inside-late",
    startedAt: IN_WINDOW_EARLY,
    lastActivityAt: IN_WINDOW_LATE,
  });
  await insertSession(db, {
    id: "s-entirely-before",
    startedAt: BEFORE_WINDOW,
    lastActivityAt: BEFORE_WINDOW,
  });
  await insertSession(db, {
    id: "s-entirely-after",
    startedAt: AFTER_WINDOW,
    lastActivityAt: AFTER_WINDOW,
  });
}

async function openDb(label: string): Promise<{
  db: SqliteDb;
  dir: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `iss5443-${label}-`));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-17T12:00:00.000Z",
  });
  return { db, dir };
}

/**
 * Read the list and the usage summary for ONE request and return both totals
 * plus the ids the list rendered. Deliberately a single request object: the
 * reconciliation claim is about one query answered twice, not two queries that
 * happen to agree.
 */
async function readBoth(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest
): Promise<{ listTotal: number; kpiTotal: number; listIds: string[] }> {
  const [list, usage] = await Promise.all([
    getSharedAgentSessions(source, request),
    getSharedAgentSessionUsage(source, request),
  ]);
  return {
    listTotal: list.total,
    kpiTotal: usage.totalSessions,
    listIds: list.items.map((item) => item.id),
  };
}

test("desktop Sessions KPI reconciles with its own list on every path combination (ISS-5443)", async () => {
  const { db, dir } = await openDb("reconcile");
  try {
    await seedPopulation(db);
    const source = db.syncSource as AgentSessionSyncSource;
    // `sortBy` is what admits the request to the SQL cursor page; without it
    // even an unfiltered read falls through to the hydrated fold.
    const window = {
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      sortBy: SessionListCursorSortKey.LastActivity,
    };

    // Each entry names which implementation answers each half; see the table in
    // the file header. `search` pushes usage onto the hydrated fold, `statuses`
    // pushes the list onto it.
    const cases: { name: string; request: SharedAgentSessionsListRequest }[] = [
      { name: "SQL list / SQL usage", request: { ...window } },
      {
        name: "SQL list / hydrated usage",
        request: { ...window, search: SEARCH_TOKEN },
      },
      {
        name: "hydrated list / SQL usage",
        request: { ...window, statuses: ["inactive"] },
      },
      {
        name: "hydrated list / hydrated usage",
        request: { ...window, search: SEARCH_TOKEN, statuses: ["inactive"] },
      },
      {
        // An explicit id set is the ONE request shape that routes usage through
        // `loadUsageSessions` — the lightweight load that fetches no event rows.
        // Without it, every "hydrated usage" case above still goes through the
        // full hydration path, and the event-less load's own last-activity read
        // is never exercised.
        name: "hydrated list / lightweight usage (explicit ids)",
        request: { ...window, ids: ALL_SESSION_IDS },
      },
    ];

    for (const { name, request } of cases) {
      const { listTotal, kpiTotal, listIds } = await readBoth(source, request);

      // The reconciliation itself: one population, one instant, one number.
      assert.equal(
        kpiTotal,
        listTotal,
        `${name}: KPI (${kpiTotal}) must equal the list total (${listTotal})`
      );
      // ...and it must be the RIGHT number. Equality alone would also hold if
      // both paths regressed onto `started_at` together.
      assert.equal(listTotal, 3, `${name}: expected the 3 in-window sessions`);
      // The specific defect: started before the window, active inside it.
      assert.ok(
        listIds.includes(STRADDLING_SESSION_ID),
        `${name}: the session that started before the window but was active inside it must be listed`
      );
    }
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a window with no activity still reads a genuine zero on both halves (ISS-5443)", async () => {
  const { db, dir } = await openDb("zero");
  try {
    await seedPopulation(db);
    const source = db.syncSource as AgentSessionSyncSource;
    // A window between the seeded clusters: no session started in it and none
    // was active in it, so widening the basis must not manufacture a row.
    const { listTotal, kpiTotal } = await readBoth(source, {
      startDate: "2026-06-18T00:00:00.000Z",
      endDate: "2026-06-20T00:00:00.000Z",
      sortBy: SessionListCursorSortKey.LastActivity,
    });
    assert.equal(listTotal, 0);
    assert.equal(kpiTotal, 0);
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the analytics read keeps its own started-in-the-period cohort (ISS-5443)", async () => {
  const { db, dir } = await openDb("analytics");
  try {
    await seedPopulation(db);
    const inner = db.syncSource as AgentSessionSyncSource;
    const seen: AgentSessionUsageAggregateFilters[] = [];
    // Record what each read hands the SQL layer. Analytics is a DIFFERENT cohort
    // by design ("a session belongs to the period it started in", the split
    // cloud draws between SESSIONS_SURFACE_DATE_FIELD and
    // SESSIONS_ANALYTICS_DATE_FIELD), so unifying the Sessions surface must not
    // drag analytics onto the activity basis with it.
    const recording: AgentSessionSyncSource = {
      ...inner,
      aggregateAnalytics: (filters, cache) => {
        seen.push(filters);
        return inner.aggregateAnalytics?.(filters, cache) as never;
      },
      aggregateUsage: (filters) => {
        seen.push(filters);
        return inner.aggregateUsage?.(filters) as never;
      },
    };
    const window = { startDate: WINDOW_START, endDate: WINDOW_END };

    await getSharedAgentSessionAnalytics(recording, window);
    assert.deepEqual(
      seen.map((f) => f.dateWindowField),
      [SESSIONS_ANALYTICS_DATE_WINDOW_FIELD]
    );

    seen.length = 0;
    await getSharedAgentSessionUsage(recording, window);
    assert.deepEqual(
      seen.map((f) => f.dateWindowField),
      [SESSIONS_SURFACE_DATE_WINDOW_FIELD]
    );
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
