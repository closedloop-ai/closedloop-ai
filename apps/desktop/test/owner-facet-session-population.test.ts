/**
 * @file owner-facet-session-population.test.ts
 * ISS-4613: the desktop Owner facet (`userSessionCounts` / `byUser`) must count
 * the SAME all-quality population as `totalSessions` and every sibling facet
 * (Harness, Model, Repository), on BOTH desktop read paths — the O(grouped) SQL
 * aggregate and the hydrate fold. ISS-4415 had gated only this facet on
 * `session_analytics` (substantive-only), so `sum(byUser) < totalSessions =
 * sum(byHarness)` whenever an idle (0-turn / 0-token / 0-tool) session existed
 * and the Owner counts under-promised the rows selecting that owner yields.
 * Substantive-vs-idle narrowing is owned by the `quality` segment, which shapes
 * the LIST, not the usage totals.
 *
 * Scope of the reconciliation claim: it is the FACET POPULATION that now matches
 * — `userSessionCounts` (SQL) and the pre-rollup per-session fold (hydrate) count
 * every session `totalSessions` does. The RENDERED `byUser` is that population
 * minus the owners the cloud org directory cannot resolve: `buildByUserRollup` /
 * `buildByUserFromCounts` drop any entry with a null `user_id` or a `userId`
 * absent from the directory snapshot (which is empty until the first successful
 * fetch). That identity-resolution drop is pre-existing and orthogonal to the
 * substantive gate this issue removes; the last test pins it explicitly so the
 * boundary is asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type {
  AgentSessionUsageAggregate,
  AgentSessionUsageAggregateFilters,
} from "../src/main/agent-sync/agent-session-read-model.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  ensureOrgDirectory,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-07-29T12:00:00.000Z";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "owner-facet-pop-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

// ISS-5443: `last_activity_at` is what the Sessions date window bounds on, and
// the write path always maintains it (`recomputeSessionLastActivityAt`) — for an
// event-less session, to the started-at floor. Seeding it keeps these rows a
// shape production can produce; a raw INSERT that left the column at its epoch
// DEFAULT would fall outside every real date window.
const STARTED_AT = "2026-07-28T08:00:00.000Z";

async function insertSession(
  db: SqliteDb,
  id: string,
  userId: string
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, user_id, started_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    id,
    SESSION_STATUS.INACTIVE,
    "claude_code",
    userId,
    STARTED_AT,
    NOW
  );
}

async function insertSessionAnalytics(
  db: SqliteDb,
  sessionId: string,
  counts: {
    humanTurns?: number;
    agentTurns?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    toolInvocations?: number;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO session_analytics
       (session_id, started_at, human_turns, agent_turns, is_human,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        tool_invocations, event_count, error_events, est_cost, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, 0, 0, 0, $10)`,
    sessionId,
    "2026-07-28T08:00:00.000Z",
    counts.humanTurns ?? 0,
    counts.agentTurns ?? 0,
    counts.inputTokens ?? 0,
    counts.outputTokens ?? 0,
    counts.cacheReadTokens ?? 0,
    counts.cacheWriteTokens ?? 0,
    counts.toolInvocations ?? 0,
    NOW
  );
}

function sumCounts(entries: readonly { sessionCount: number }[]): number {
  return entries.reduce((sum, entry) => sum + entry.sessionCount, 0);
}

/**
 * `aggregateUsage` is OPTIONAL on the shared `AgentSessionSyncSource` contract
 * — a source with no SQL rollup omits it and callers fall back to the hydrate
 * fold. The sqlite source under test always implements it, and every SQL-path
 * fact in this file is a claim about that implementation, so assert the
 * capability at the boundary: a sqlite source that quietly stopped offering the
 * rollup would otherwise make these tests silently exercise nothing.
 *
 * Thrown rather than asserted: this runs in a shared helper, outside any
 * `test()` body, which is exactly the shape `noMisplacedAssertion` forbids. A
 * throw fails the calling test just as loudly and narrows the optional member
 * for the call below.
 */
async function aggregateUsageOf(
  db: SqliteDb,
  filters: AgentSessionUsageAggregateFilters
): Promise<AgentSessionUsageAggregate> {
  const source = createSqliteSessionSyncSource(db.prisma);
  if (!source.aggregateUsage) {
    throw new Error(
      "the sqlite sync source must implement the SQL aggregateUsage rollup"
    );
  }
  return await source.aggregateUsage(filters);
}

test("userSessionCounts counts idle sessions so byUser reconciles with totalSessions", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-substantive", "user-a");
    await insertSessionAnalytics(db, "sess-substantive", {
      humanTurns: 3,
      agentTurns: 5,
      inputTokens: 1000,
      outputTokens: 500,
    });

    await insertSession(db, "sess-idle", "user-a");
    await insertSessionAnalytics(db, "sess-idle", {});

    const aggregate = await aggregateUsageOf(db, {});

    const userA = aggregate.userSessionCounts.find(
      (u) => u.userId === "user-a"
    );
    assert.ok(userA, "expected user-a in userSessionCounts");
    assert.equal(
      userA.sessionCount,
      2,
      "the idle session counts toward its owner, as it does toward the harness"
    );
    assert.equal(aggregate.totalSessions, 2);
    assert.equal(
      sumCounts(aggregate.userSessionCounts),
      aggregate.totalSessions,
      "sum(byUser) must equal the headline Sessions count"
    );
    assert.equal(
      sumCounts(aggregate.userSessionCounts),
      sumCounts(aggregate.harnessSessionCounts),
      "sum(byUser) must equal sum(byHarness) — one population, every facet"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("userSessionCounts includes a user whose sessions are all idle", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-a", "user-active");
    await insertSessionAnalytics(db, "sess-a", { humanTurns: 1 });

    await insertSession(db, "sess-b", "user-idle-only");
    await insertSessionAnalytics(db, "sess-b", {});

    const aggregate = await aggregateUsageOf(db, {});

    const activeUser = aggregate.userSessionCounts.find(
      (u) => u.userId === "user-active"
    );
    assert.ok(activeUser, "expected user-active in userSessionCounts");
    assert.equal(activeUser.sessionCount, 1);

    const idleUser = aggregate.userSessionCounts.find(
      (u) => u.userId === "user-idle-only"
    );
    assert.ok(
      idleUser,
      "an idle-only owner still owns rows the Sessions table shows, so it must be offerable as an Owner option"
    );
    assert.equal(idleUser.sessionCount, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("userSessionCounts counts a session with no session_analytics row", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-with-analytics", "user-d");
    await insertSessionAnalytics(db, "sess-with-analytics", {
      humanTurns: 1,
    });

    await insertSession(db, "sess-no-analytics", "user-d");

    const aggregate = await aggregateUsageOf(db, {});

    const userD = aggregate.userSessionCounts.find(
      (u) => u.userId === "user-d"
    );
    assert.ok(userD, "expected user-d");
    assert.equal(
      userD.sessionCount,
      2,
      "the removed INNER JOIN on session_analytics must not drop an un-rolled-up session"
    );
    assert.equal(sumCounts(aggregate.userSessionCounts), 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("byUser reconciles with totalSessions under a non-empty WHERE clause (filters)", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-filtered-sub", "user-e");
    await insertSessionAnalytics(db, "sess-filtered-sub", {
      humanTurns: 2,
      inputTokens: 100,
    });

    await insertSession(db, "sess-filtered-idle", "user-e");
    await insertSessionAnalytics(db, "sess-filtered-idle", {});

    const aggregate = await aggregateUsageOf(db, {
      startDate: new Date("2026-07-01T00:00:00.000Z"),
    });

    const userE = aggregate.userSessionCounts.find(
      (u) => u.userId === "user-e"
    );
    assert.ok(userE, "expected user-e with date filter applied");
    assert.equal(userE.sessionCount, 2);
    assert.equal(
      sumCounts(aggregate.userSessionCounts),
      aggregate.totalSessions,
      "the filtered corpus is still one population across every facet"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("userSessionCounts carries a null-owner session so the facet population still totals", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-owned", "user-g");
    await db.run(
      `INSERT INTO sessions (id, status, harness, user_id, started_at, updated_at, last_activity_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $4)`,
      "sess-unowned",
      SESSION_STATUS.INACTIVE,
      "claude_code",
      STARTED_AT,
      NOW
    );

    const aggregate = await aggregateUsageOf(db, {});

    assert.equal(aggregate.totalSessions, 2);
    assert.equal(
      sumCounts(aggregate.userSessionCounts),
      aggregate.totalSessions,
      "a pre-sign-in session with user_id NULL still belongs to the facet population"
    );
    const unowned = aggregate.userSessionCounts.find((u) => u.userId === null);
    assert.ok(
      unowned,
      "the null-owner group is carried, not dropped, by the SQL"
    );
    assert.equal(unowned.sessionCount, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The hydrate twin (`buildUsageSummary`), reached via the search fallback path
// ---------------------------------------------------------------------------

async function insertTokenUsage(
  db: SqliteDb,
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4)`,
    sessionId,
    model,
    inputTokens,
    outputTokens
  );
}

async function insertSessionWithCwd(
  db: SqliteDb,
  id: string,
  userId: string,
  cwd: string
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, user_id, cwd, started_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6)`,
    id,
    SESSION_STATUS.INACTIVE,
    "claude_code",
    userId,
    cwd,
    STARTED_AT,
    NOW
  );
}

test("search fallback path folds an idle-only owner into byUser", async () => {
  const { db, dir } = await openTempDb();
  try {
    resetOrgDirectoryCacheForTest();
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: "user-active",
              email: "active@test.com",
              firstName: "Active",
              lastName: null,
              avatarUrl: null,
            },
            {
              id: "user-idle-only",
              email: "idle@test.com",
              firstName: "Idle",
              lastName: null,
              avatarUrl: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: mockFetch,
      },
      1_780_000_000_000
    );

    const searchableCwd = "/home/user/gate-test-project";

    await insertSessionWithCwd(db, "sess-sub", "user-active", searchableCwd);
    await insertTokenUsage(db, "sess-sub", "claude-4", 500, 200);

    await insertSessionWithCwd(
      db,
      "sess-idle",
      "user-idle-only",
      searchableCwd
    );

    const source = createSqliteSessionSyncSource(db.prisma);
    const usage = await getSharedAgentSessionUsage(source, {
      search: "gate-test-project",
    });

    assert.equal(usage.totalSessions, 2, "both sessions matched the search");

    const activeUser = usage.byUser.find((u) => u.userId === "user-active");
    assert.ok(activeUser, "expected user-active in byUser");
    assert.equal(activeUser.sessionCount, 1);

    const idleUser = usage.byUser.find((u) => u.userId === "user-idle-only");
    assert.ok(
      idleUser,
      "the hydrate fold must count the idle session's owner too, matching the SQL twin"
    );
    assert.equal(idleUser.sessionCount, 1);

    // Every owner here resolves in the seeded directory, so the rendered rollup
    // is the whole facet population and reconciles with the headline count.
    assert.equal(
      sumCounts(usage.byUser),
      usage.totalSessions,
      "with every owner resolvable, the hydrate path's sum(byUser) equals its own headline Sessions count"
    );
  } finally {
    resetOrgDirectoryCacheForTest();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rendered byUser drops owners the org directory cannot resolve", async () => {
  const { db, dir } = await openTempDb();
  try {
    // No org directory at all — the snapshot is empty until the first successful
    // fetch, which is the cold/offline state every desktop launch starts in.
    resetOrgDirectoryCacheForTest();

    const searchableCwd = "/home/user/unresolved-owner-project";
    await insertSessionWithCwd(
      db,
      "sess-unres",
      "user-not-in-dir",
      searchableCwd
    );
    await insertTokenUsage(db, "sess-unres", "claude-4", 500, 200);

    const source = createSqliteSessionSyncSource(db.prisma);
    const usage = await getSharedAgentSessionUsage(source, {
      search: "unresolved-owner-project",
    });

    // The session is in the facet population — it is only the IDENTITY rollup
    // that drops it, and that drop is orthogonal to the substantive gate
    // ISS-4613 removed. Pinned so the header's scoped claim is asserted, not
    // assumed, and so a future rollup change surfaces here.
    assert.equal(usage.totalSessions, 1);
    assert.deepEqual(
      usage.byUser,
      [],
      "an owner missing from the directory snapshot is dropped by the rollup, not by the population gate"
    );
  } finally {
    resetOrgDirectoryCacheForTest();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
