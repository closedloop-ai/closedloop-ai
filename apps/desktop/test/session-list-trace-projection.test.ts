import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import {
  REPOSITORY_FULL_NAME_MAX_LENGTH,
  SessionPrRelationType,
  SYNCED_PR_URL_MAX_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test, vi } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import type {
  SqliteEventRow,
  SqliteTokenEventRow,
} from "../src/main/database/db-row-types.js";
import type { DesktopPrismaReader } from "../src/main/database/prisma-client.js";
import { buildSessionListTraceProjection } from "../src/main/database/session-list-trace-builder.js";
import { repairSessionListTraceProjectionPage } from "../src/main/database/session-list-trace-maintenance.js";
import {
  timelineEventPages,
  tokenEventPageStatements,
  tokenEventPages,
} from "../src/main/database/session-list-trace-pages.js";
import {
  ensureSessionListTraceProjections,
  readSessionListTraceProjections,
  SESSION_LIST_TRACE_PROJECTION_REVISION,
  type SessionListTraceProjection,
} from "../src/main/database/session-list-trace-projection.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  selectListTokenUsageRows,
  selectTokenUsageRows,
} from "../src/main/database/sync-source-usage-rows.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  insertSqliteEvent,
  insertSqlitePrArtifact,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

type TestDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const TEST_PROJECTION: SessionListTraceProjection = {
  agentCount: 2,
  errorCount: 1,
  fields: {},
  lastActivityAt: "2026-09-21T11:20:00.000Z",
  toolUseCount: 3,
};
const ROLLBACK_VIEWERSHIP_ERROR = /roll back viewership/;
const TOKEN_EVENT_ORDER_INDEX =
  "idx_token_events_session_created_model_transport";
const TOKEN_EVENT_NON_SEEK_PLAN = /SCAN token_events|USE TEMP B-TREE/;

test("projection revision and source invalidation are transactionally fresh", async () => {
  await withDatabase("lifecycle", async (db) => {
    const sessionId = "projection-lifecycle";
    await insertSqliteSession(db, sessionId);
    const buildProjection = vi.fn(buildTestProjection);

    await repair(db, sessionId, buildProjection);
    assert.equal(await projectionRowCount(db, sessionId), 1);
    await db.run(
      "UPDATE session_list_trace_projection SET revision = $1 WHERE session_id = $2",
      SESSION_LIST_TRACE_PROJECTION_REVISION - 1,
      sessionId
    );
    assert.equal((await readProjection(db, sessionId)).size, 0);
    await repair(db, sessionId, buildProjection);
    assert.equal(buildProjection.mock.calls.length, 2);
    await db.run(
      "UPDATE session_list_trace_projection SET payload = json('{}') WHERE session_id = $1",
      sessionId
    );
    assert.equal((await readProjection(db, sessionId)).size, 0);
    await repair(db, sessionId, buildProjection);
    assert.equal(buildProjection.mock.calls.length, 3);

    await insertSqliteEvent(db, sessionId, "2026-09-21T11:15:00.000Z");
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);

    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at)
       VALUES ($1, 'projection-token', 'gpt-5', $2)`,
      sessionId,
      "2026-09-21T11:16:00.000Z"
    );
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);

    await assert.rejects(
      db.prisma.write((writer) =>
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO session_viewership (session_id, first_viewed_at)
             VALUES ($1, $2)`,
            sessionId,
            "2026-09-21T11:17:00.000Z"
          );
          throw new Error("roll back viewership");
        })
      ),
      ROLLBACK_VIEWERSHIP_ERROR
    );
    assert.equal(await projectionRowCount(db, sessionId), 1);
    await db.run(
      `INSERT INTO session_viewership (session_id, first_viewed_at)
       VALUES ($1, $2)`,
      sessionId,
      "2026-09-21T11:17:00.000Z"
    );
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);

    await insertSqlitePrArtifact(db, sessionId, {
      repoFullName: "closedloop-ai/closedloop-ai",
      prNumber: 12_461,
    });
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);
    await db.run(
      "UPDATE artifacts SET title = 'Updated PR' WHERE pr_number = $1",
      12_461
    );
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);

    await db.run(
      `INSERT INTO pull_requests
         (id, session_id, pr_url, pr_number, repo_full_name)
       VALUES ('projection-pr', $1, $2, $3, $4)`,
      sessionId,
      "https://github.com/closedloop-ai/closedloop-ai/pull/12461",
      12_461,
      "closedloop-ai/closedloop-ai"
    );
    assert.equal(await projectionRowCount(db, sessionId), 0);
    await repair(db, sessionId, buildProjection);

    await db.run(
      "UPDATE sessions SET name = 'projection updated' WHERE id = $1",
      sessionId
    );
    assert.equal(await projectionRowCount(db, sessionId), 1);
    await db.run(
      `UPDATE sessions
          SET metadata = json('{"userMessages":2}')
        WHERE id = $1`,
      sessionId
    );
    assert.equal(await projectionRowCount(db, sessionId), 0);
  });
});

test("last-seen-only artifact re-observation preserves shared projections", async () => {
  await withDatabase("shared-artifact-reobservation", async (db) => {
    const firstSessionId = "projection-shared-artifact-first";
    const secondSessionId = "projection-shared-artifact-second";
    await insertSqliteSession(db, firstSessionId);
    await insertSqliteSession(db, secondSessionId);
    await insertSqlitePrArtifact(db, firstSessionId, {
      repoFullName: "closedloop-ai/closedloop-ai",
      prNumber: 12_461,
    });
    await insertSqlitePrArtifact(db, secondSessionId, {
      repoFullName: "closedloop-ai/closedloop-ai",
      prNumber: 12_461,
    });
    await repairAll(db, [firstSessionId, secondSessionId]);

    await db.run(
      `UPDATE artifacts
          SET last_seen_at = '2026-09-21T12:00:00.000Z'
        WHERE repo_full_name = 'closedloop-ai/closedloop-ai'
          AND pr_number = 12461`
    );

    assert.equal(await projectionRowCount(db, firstSessionId), 1);
    assert.equal(await projectionRowCount(db, secondSessionId), 1);

    await db.run(
      `UPDATE artifacts
          SET title = 'Updated shared PR'
        WHERE repo_full_name = 'closedloop-ai/closedloop-ai'
          AND pr_number = 12461`
    );

    assert.equal(await projectionRowCount(db, firstSessionId), 0);
    assert.equal(await projectionRowCount(db, secondSessionId), 0);
  });
});

test("pull request changes invalidate every session sharing old and new identities", async () => {
  await withDatabase("shared-pr", async (db) => {
    const oldSessionId = "projection-pr-old";
    const movedSessionId = "projection-pr-moved";
    const newSessionId = "projection-pr-new";
    for (const sessionId of [oldSessionId, movedSessionId, newSessionId]) {
      await insertSqliteSession(db, sessionId);
    }
    await insertPullRequest(db, "pr-old", oldSessionId, "repo/old", 41);
    await insertPullRequest(db, "pr-new", newSessionId, "repo/new", 42);
    await repairAll(db, [oldSessionId, movedSessionId, newSessionId]);

    await insertPullRequest(db, "pr-moved", movedSessionId, "repo/old", 41);
    assert.equal(await projectionRowCount(db, oldSessionId), 0);
    assert.equal(await projectionRowCount(db, movedSessionId), 0);
    assert.equal(await projectionRowCount(db, newSessionId), 1);
    await repairAll(db, [oldSessionId, movedSessionId]);

    await db.run(
      `UPDATE pull_requests
          SET repo_full_name = 'repo/new', pr_number = 42,
              opened_at = '2026-09-21T11:00:00.000Z'
        WHERE id = 'pr-moved'`
    );
    assert.equal(await projectionRowCount(db, oldSessionId), 0);
    assert.equal(await projectionRowCount(db, movedSessionId), 0);
    assert.equal(await projectionRowCount(db, newSessionId), 0);
    await repairAll(db, [oldSessionId, movedSessionId, newSessionId]);

    await db.run("DELETE FROM pull_requests WHERE id = 'pr-moved'");
    assert.equal(await projectionRowCount(db, oldSessionId), 1);
    assert.equal(await projectionRowCount(db, movedSessionId), 0);
    assert.equal(await projectionRowCount(db, newSessionId), 0);
  });
});

test("pull request changes invalidate artifact-link-only sessions", async () => {
  await withDatabase("link-only-pr", async (db) => {
    const ownerSessionId = "projection-pr-owner";
    const oldLinkSessionId = "projection-pr-link-old";
    const newLinkSessionId = "projection-pr-link-new";
    for (const sessionId of [
      ownerSessionId,
      oldLinkSessionId,
      newLinkSessionId,
    ]) {
      await insertSqliteSession(db, sessionId);
    }
    await insertSqlitePrArtifact(db, oldLinkSessionId, {
      repoFullName: "repo/link-old",
      prNumber: 51,
    });
    await insertSqlitePrArtifact(db, newLinkSessionId, {
      repoFullName: "repo/link-new",
      prNumber: 52,
    });
    await repairAll(db, [ownerSessionId, oldLinkSessionId, newLinkSessionId]);

    await insertPullRequest(
      db,
      "pr-link-only",
      ownerSessionId,
      "repo/link-old",
      51
    );
    assert.equal(await projectionRowCount(db, ownerSessionId), 0);
    assert.equal(await projectionRowCount(db, oldLinkSessionId), 0);
    assert.equal(await projectionRowCount(db, newLinkSessionId), 1);
    await repairAll(db, [ownerSessionId, oldLinkSessionId]);

    await db.run(
      `UPDATE pull_requests
          SET repo_full_name = 'repo/link-new', pr_number = 52,
              opened_at = '2026-09-21T11:00:00.000Z'
        WHERE id = 'pr-link-only'`
    );
    assert.equal(await projectionRowCount(db, ownerSessionId), 0);
    assert.equal(await projectionRowCount(db, oldLinkSessionId), 0);
    assert.equal(await projectionRowCount(db, newLinkSessionId), 0);
    await repairAll(db, [ownerSessionId, oldLinkSessionId, newLinkSessionId]);

    await db.run("DELETE FROM pull_requests WHERE id = 'pr-link-only'");
    assert.equal(await projectionRowCount(db, ownerSessionId), 0);
    assert.equal(await projectionRowCount(db, oldLinkSessionId), 1);
    assert.equal(await projectionRowCount(db, newLinkSessionId), 0);
  });
});

test("projected PR refs preserve canonical repository and URL bounds", async () => {
  await withDatabase("pr-bounds", async (db) => {
    const sessionId = "projection-pr-bounds";
    await insertSqliteSession(db, sessionId);
    await insertSqlitePrArtifact(db, sessionId, {
      repoFullName: "repo/valid",
      prNumber: 101,
    });
    await insertSqlitePrArtifact(db, sessionId, {
      repoFullName: "repo/too-long",
      prNumber: 102,
    });
    await insertSqlitePrArtifact(db, sessionId, {
      repoFullName: "repo/url-bound",
      prNumber: 103,
    });
    await db.run(
      "UPDATE artifacts SET repo_full_name = $1 WHERE pr_number = 102",
      "r".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH + 1)
    );
    await db.run(
      "UPDATE artifacts SET url = $1 WHERE pr_number = 103",
      "u".repeat(SYNCED_PR_URL_MAX_LENGTH + 1)
    );

    const [legacy] = await db.syncSource.loadSyncedSessions(
      [sessionId],
      createSessionAttributionResolverCache()
    );
    const projected = await db.prisma.read((reader) =>
      reader.$transaction((snapshot) =>
        buildSessionListTraceProjection(snapshot, sessionId)
      )
    );

    assert.deepEqual(projected?.fields.prRefs, legacy?.prRefs);
    await db.run(
      "UPDATE sessions SET status = $1 WHERE id = $2",
      SESSION_STATUS.INACTIVE,
      sessionId
    );
    await ensureSessionListTraceProjections(
      db.prisma,
      [sessionId],
      buildSessionListTraceProjection
    );
    const persisted = await db.prisma.read((reader) =>
      readSessionListTraceProjections(reader, [sessionId])
    );
    assert.deepEqual(persisted.get(sessionId)?.fields.prRefs, legacy?.prRefs);
    assert.deepEqual(
      projected?.fields.prRefs?.map((ref) => ({
        repositoryFullName: ref.repositoryFullName,
        prNumber: ref.prNumber,
        prUrl: ref.prUrl,
        relationType: ref.relationType,
      })),
      [
        {
          repositoryFullName: "repo/valid",
          prNumber: 101,
          prUrl: undefined,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: "repo/url-bound",
          prNumber: 103,
          prUrl: undefined,
          relationType: SessionPrRelationType.Created,
        },
      ]
    );
  });
});

test("projection repair advances in bounded resumable keyset pages", async () => {
  await withDatabase("backfill", async (db) => {
    for (const sessionId of ["projection-a", "projection-b", "projection-c"]) {
      await insertSqliteSession(db, sessionId);
    }
    const buildProjection = vi.fn(buildTestProjection);
    const first = await repairSessionListTraceProjectionPage(db.prisma, null, {
      buildProjection,
      pageSize: 2,
    });
    assert.deepEqual(first, {
      scanned: 2,
      repaired: 2,
      failed: 0,
      nextCursor: "projection-b",
      done: false,
    });
    assert.deepEqual(
      buildProjection.mock.calls.map((call) => call[1]),
      ["projection-a", "projection-b"]
    );

    const second = await repairSessionListTraceProjectionPage(
      db.prisma,
      first.nextCursor,
      { buildProjection, pageSize: 2 }
    );
    assert.deepEqual(second, {
      scanned: 1,
      repaired: 1,
      failed: 0,
      nextCursor: "projection-c",
      done: true,
    });
    assert.equal(await projectionRowCount(db), 3);

    const converged = await repairSessionListTraceProjectionPage(
      db.prisma,
      null,
      { buildProjection, pageSize: 2 }
    );
    assert.equal(converged.repaired, 0);
    assert.equal(buildProjection.mock.calls.length, 3);

    await db.run(
      "DELETE FROM session_list_trace_projection WHERE session_id = 'projection-a'"
    );
    const failed = await repairSessionListTraceProjectionPage(db.prisma, null, {
      buildProjection: () => Promise.reject(new Error("repair failed")),
      pageSize: 1,
    });
    assert.equal(failed.failed, 1);
    assert.equal(failed.nextCursor, "projection-a");
    const resumed = await repairSessionListTraceProjectionPage(
      db.prisma,
      null,
      { buildProjection, pageSize: 1 }
    );
    assert.equal(resumed.repaired, 1);
    assert.equal(await projectionRowCount(db), 3);
  });
});

test("projection backfill skips active sessions", async () => {
  await withDatabase("active-backfill", async (db) => {
    await insertSqliteSession(db, "projection-active-backfill", {
      status: "active",
    });
    const buildProjection = vi.fn(buildTestProjection);

    const page = await repairSessionListTraceProjectionPage(db.prisma, null, {
      buildProjection,
      pageSize: 1,
    });

    assert.deepEqual(page, {
      scanned: 0,
      repaired: 0,
      failed: 0,
      nextCursor: null,
      done: true,
    });
    assert.equal(buildProjection.mock.calls.length, 0);
    assert.equal(await projectionRowCount(db), 0);
  });
});

test("list token aggregate preserves baseline, nullable, zero, and mixed cost rows", async () => {
  await withDatabase("usage", async (db) => {
    const sessionId = "projection-usage";
    await insertSqliteSession(db, sessionId);
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
          baseline_input, baseline_output, baseline_cache_read,
          baseline_cache_write, created_at, cost_usd_estimated)
       VALUES
         ($1, 'baseline-null', 10, 20, 30, 40, NULL, NULL,
          1, 2, 3, 4, $2, NULL),
         ($1, 'zero-cost', 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, $2, 0),
         ($1, 'stored-cost', 7, 8, 9, 10, 11, 12,
          13, 14, 15, 16, $2, 1.25)`,
      sessionId,
      "2026-09-21T11:20:00.000Z"
    );
    const [rawRows, aggregateRows] = await db.prisma.read(async (reader) =>
      Promise.all([
        selectTokenUsageRows(reader, [sessionId]),
        selectListTokenUsageRows(reader, [sessionId]),
      ])
    );
    assert.equal(aggregateRows.length, rawRows.length);
    assert.deepEqual(
      aggregateRows.map((row) => ({
        model: row.model,
        input: Number(row.input_tokens),
        output: Number(row.output_tokens),
        cacheRead: Number(row.cache_read_tokens),
        cacheWrite: Number(row.cache_write_tokens),
        cacheWrite5m:
          row.cache_write_5m_tokens == null
            ? null
            : Number(row.cache_write_5m_tokens),
        cacheWrite1h:
          row.cache_write_1h_tokens == null
            ? null
            : Number(row.cache_write_1h_tokens),
        cost: row.cost_usd_estimated,
        baselines: [
          row.baseline_input,
          row.baseline_output,
          row.baseline_cache_read,
          row.baseline_cache_write,
        ].map(Number),
      })),
      [
        {
          model: "baseline-null",
          input: 11,
          output: 22,
          cacheRead: 33,
          cacheWrite: 44,
          cacheWrite5m: null,
          cacheWrite1h: null,
          cost: null,
          baselines: [0, 0, 0, 0],
        },
        {
          model: "stored-cost",
          input: 20,
          output: 22,
          cacheRead: 24,
          cacheWrite: 26,
          cacheWrite5m: 11,
          cacheWrite1h: 12,
          cost: 1.25,
          baselines: [0, 0, 0, 0],
        },
        {
          model: "zero-cost",
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cost: 0,
          baselines: [0, 0, 0, 0],
        },
      ]
    );
  });
});

test("token event pages seek exact continuation prefixes in stable null-first order", async () => {
  await withDatabase("token-page-order", async (db) => {
    const sessionId = "projection-token-page-order";
    const createdAt = "2026-09-21T11:20:00.000Z";
    await insertSqliteSession(db, sessionId);
    await db.run(
      `WITH RECURSIVE seq(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM seq WHERE n < 514
       )
       INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens)
       SELECT $1, NULL, 'gpt-page', $2, n FROM seq`,
      sessionId,
      createdAt
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens)
       VALUES
         ($1, '', 'gpt-page', $2, 1001),
         ($1, 'duplicate-a', 'gpt-page', $2, 1002),
         ($1, 'duplicate-b', 'gpt-page', $2, 1003)`,
      sessionId,
      createdAt
    );

    const pages = await db.prisma.read((reader) =>
      reader.$transaction(async (snapshot) => {
        const result: SqliteTokenEventRow[][] = [];
        for await (const page of tokenEventPages(snapshot, sessionId)) {
          result.push(page);
        }
        return result;
      })
    );
    assert.deepEqual(
      pages.map((page) => page.length),
      [512, 5]
    );
    assert.deepEqual(
      pages.flat().map((row) => Number(row.input_tokens)),
      [
        ...Array.from({ length: 514 }, (_, index) => index + 1),
        1001,
        1002,
        1003,
      ]
    );

    for (const cursor of [
      {
        createdAt,
        model: "gpt-page",
        rowId: 512,
        transportId: null,
      },
      {
        createdAt,
        model: "gpt-page",
        rowId: 516,
        transportId: "duplicate-a",
      },
    ]) {
      for (const statement of tokenEventPageStatements(sessionId, cursor)) {
        const rows = await db.prisma.client.$queryRawUnsafe<
          Array<{ detail: string }>
        >(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.params);
        const plan = rows.map((row) => row.detail).join(" | ");
        assert.ok(
          plan.includes(
            `SEARCH token_events USING INDEX ${TOKEN_EVENT_ORDER_INDEX}`
          ),
          plan
        );
        assert.doesNotMatch(plan, TOKEN_EVENT_NON_SEEK_PLAN);
      }
    }
  });
});

test("timeline paging preserves SQL binary id order inside equal-rank ties", async () => {
  await withDatabase("timeline-binary-order", async (db) => {
    const sessionId = "projection-timeline-binary-order";
    const tiedAt = "2026-09-21T11:20:00.000Z";
    const laterAt = "2026-09-21T11:21:00.000Z";
    await insertSqliteSession(db, sessionId);
    for (const eventId of ["a", "B", "_", "z"]) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, 'other', $3)`,
        eventId,
        sessionId,
        tiedAt
      );
    }
    await db.run(
      `WITH RECURSIVE seq(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM seq WHERE n < 513
       )
       INSERT INTO events (id, session_id, event_type, created_at)
       SELECT printf('later-%04d', n), $1, 'other', $2 FROM seq`,
      sessionId,
      laterAt
    );

    const ids = await db.prisma.read((reader) =>
      reader.$transaction(async (snapshot) => {
        const result: string[] = [];
        for await (const page of timelineEventPages(snapshot, sessionId)) {
          result.push(...page.map((row: SqliteEventRow) => row.id));
        }
        return result;
      })
    );

    assert.deepEqual(ids.slice(0, 4), ["B", "_", "a", "z"]);
    assert.equal(ids.length, 517);
    assert.equal(ids.at(-1), "later-0513");
  });
});

test("malformed trace timestamps retain legacy list semantics", async () => {
  await withDatabase("malformed", async (db) => {
    const sessionId = "projection-malformed";
    await insertSqliteSession(db, sessionId);
    await insertSqliteEvent(db, sessionId, "malformed-timestamp");
    const request = {
      ids: [sessionId],
      quality: "all" as const,
      limit: 10,
      offset: 0,
    };
    const canonical = await getSharedAgentSessions(db.syncSource, request);
    db.syncSource.loadSyncedSessions = () => {
      throw new Error("malformed compatibility must stay inside list repair");
    };
    const projected = await db.syncSource.projectSessionList?.({
      request,
      computeTargetId: null,
      users: [],
    });
    assert.ok(projected);
    const {
      pendingOutboxAvailable,
      queryExecution,
      queryMatchedCount,
      queryScannedCount,
      ...withoutOutbox
    } = projected;
    assert.equal(pendingOutboxAvailable, false);
    assert.equal(queryExecution, ListQueryExecution.HydratedFallback);
    assert.equal(queryMatchedCount, 1);
    assert.equal(queryScannedCount, 1);
    assert.deepEqual(withoutOutbox, canonical);
  });
});

test("attribution writeback is followed by projection promotion", async () => {
  await withDatabase("attribution", async (db) => {
    const sessionId = "projection-attribution";
    const observedAt = "2026-09-21T11:20:00.000Z";
    await insertSqliteSession(db, sessionId);
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name, harness,
          observed_at, created_at, last_seen_at)
       VALUES ('projection-branch', 'branch:projection', 'branch', $1, 'main',
               'codex', $2, $2, $2)`,
      "closedloop-ai/closedloop-ai",
      observedAt
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary,
          status, extractor_version, observed_at, created_at)
       VALUES ('projection-attribution-link', $1, 'projection-branch',
               'workspace', 'test_fixture', '{}', 0, 'candidate', 1, $2, $2)`,
      sessionId,
      observedAt
    );
    const response = await db.syncSource.projectSessionList?.({
      request: { ids: [sessionId], quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });
    assert.equal(
      response?.items[0]?.repositoryFullName,
      "closedloop-ai/closedloop-ai"
    );
    const rows = await db.prisma.client.$queryRawUnsafe<
      Array<{ repo_full_name: string | null }>
    >("SELECT repo_full_name FROM sessions WHERE id = $1", sessionId);
    assert.equal(rows[0]?.repo_full_name, "closedloop-ai/closedloop-ai");
    assert.equal(await projectionRowCount(db, sessionId), 1);
  });
});

async function withDatabase(
  slug: string,
  run: (db: TestDb) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `iss-12461-${slug}-`));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function buildTestProjection(
  _reader: DesktopPrismaReader,
  _sessionId: string
): Promise<SessionListTraceProjection> {
  return Promise.resolve(TEST_PROJECTION);
}

function repair(
  db: TestDb,
  sessionId: string,
  buildProjection: typeof buildTestProjection
): Promise<void> {
  return ensureSessionListTraceProjections(
    db.prisma,
    [sessionId],
    buildProjection
  );
}

function repairAll(db: TestDb, sessionIds: string[]): Promise<void> {
  return ensureSessionListTraceProjections(
    db.prisma,
    sessionIds,
    buildTestProjection
  );
}

function insertPullRequest(
  db: TestDb,
  id: string,
  sessionId: string,
  repoFullName: string,
  prNumber: number
): Promise<void> {
  return db.run(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name)
     VALUES ($1, $2, $3, $4, $5)`,
    id,
    sessionId,
    `https://example.test/${repoFullName}/pull/${prNumber}/${id}`,
    prNumber,
    repoFullName
  );
}

function readProjection(db: TestDb, sessionId: string) {
  return db.prisma.read((reader) =>
    readSessionListTraceProjections(reader, [sessionId])
  );
}

async function projectionRowCount(
  db: TestDb,
  sessionId?: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ count: number | bigint }>
  >(
    sessionId
      ? "SELECT COUNT(*) AS count FROM session_list_trace_projection WHERE session_id = $1"
      : "SELECT COUNT(*) AS count FROM session_list_trace_projection",
    ...(sessionId ? [sessionId] : [])
  );
  return Number(rows[0]?.count ?? 0);
}
