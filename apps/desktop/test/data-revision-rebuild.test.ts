/**
 * @file data-revision-rebuild.test.ts
 * @description Tests for the FEA-1785 data-revision rebuild: DATA_REVISION
 * stamping, pre-FEA-1548 migration, the runDataRevisionRebuild orchestrator,
 * deleteSessionRow, boot-complete signal, and concurrent-import serialization.
 * 15 tests as specified in the frozen decision table plus parser-runner coverage.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { HistoricalParseWorkerFailureError } from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import type {
  Harness,
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  ClaudeCodeOtelTableName,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
} from "../src/main/otel/claude-code-persistence.js";
import {
  CodexOtelSpanStatus,
  CodexOtelTokenUsageSource,
} from "../src/main/otel/codex-otel-contract.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
  writeClaudeTranscript,
} from "./normalized-session-test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODEX_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const claudeCodeOtelSideTables = [
  ClaudeCodeOtelTableName.CostEvent,
  ClaudeCodeOtelTableName.PermissionEvent,
  ClaudeCodeOtelTableName.ApiRequest,
] as const;

describe("DATA_REVISION stamping & schema spine (TEST 1-2)", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // FEA-2641: DATA_REVISION constant floor — genuine-human-turn reclassification
  // requires the rollup SQL to use json_each($.messages) instead of the old
  // '"human"' substring count. Sessions parsed before this revision are rebuilt.
  // ═══════════════════════════════════════════════════════════════════════════

  test("FEA-2641: DATA_REVISION >= 11 (genuine-human-turn reclassification)", () => {
    assert.ok(
      DATA_REVISION >= 11,
      `FEA-2641 genuine-human-turn reclassification requires revision >= 11, got ${DATA_REVISION}`
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Revision stamping — import + re-import + hook path
  // ═══════════════════════════════════════════════════════════════════════════

  test("1: Revision stamping — import new session stamps DATA_REVISION; re-import re-stamps after manual downgrade; hook path stamps DATA_REVISION", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t1-"));
    const db = await openTestDb(dir);
    try {
      // Import new session → data_revision = DATA_REVISION
      const session = makeSession({ sessionId: "stamp-new" });
      await db.importer.importSession(session, "claude");

      const row1 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "stamp-new");
      assert.equal(row1[0].data_revision, DATA_REVISION);

      // Re-import existing → stays DATA_REVISION
      await db.importer.importSession(session, "claude");
      const row2 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "stamp-new");
      assert.equal(row2[0].data_revision, DATA_REVISION);

      // Manual downgrade to 1, then re-import stamps DATA_REVISION again
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "stamp-new"
      );
      const downgradedRow = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "stamp-new");
      assert.equal(downgradedRow[0].data_revision, 1);

      await db.importer.importSession(session, "claude");
      const row3 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "stamp-new");
      assert.equal(row3[0].data_revision, DATA_REVISION);

      // Hook path: processEvent SessionStart creates session with data_revision = DATA_REVISION
      await db.processEvent(
        "SessionStart",
        {
          session_id: "hook-stamp",
          cwd: "/workspace/project",
          model: "claude-sonnet-4-5",
        },
        "claude"
      );
      const hookRow = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "hook-stamp");
      assert.equal(hookRow[0].data_revision, DATA_REVISION);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Migration — pre-FEA-1548 schema DB reopens cleanly
  // ═══════════════════════════════════════════════════════════════════════════

  test("2: Schema spine — fresh install carries data_revision/user_id/organization_id; rows default data_revision 1", async () => {
    // Post SQLite migration the 14 incremental migrations collapsed into a single
    // `0001_init`, so there is no longer an ALTER-on-reopen path that lifts an old
    // sessions table — every SQLite install is created fresh at the cutover shape.
    // The surviving, still-meaningful invariant: the sessions table is created
    // with these columns, the data_revision default is 1, and the user_id index
    // exists.
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t2-"));
    const dataDir = path.join(dir, "agent-dashboard.sqlite");
    try {
      const db = await openSqliteAgentDatabase({
        dataDir,
        detectBillingMode: () => "metered_api",
        now: () => "2026-06-07T12:00:00.000Z",
      });
      try {
        // Columns exist (SQLite catalog).
        const cols = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
          `SELECT name FROM pragma_table_info('sessions')
         WHERE name IN ('data_revision', 'user_id', 'organization_id')
         ORDER BY name`
        );
        const colNames = cols.map((r) => r.name).sort();
        assert.deepEqual(colNames, [
          "data_revision",
          "organization_id",
          "user_id",
        ]);

        // A new row defaults to data_revision = 1.
        await db.run(
          `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, harness, billing_mode)
         VALUES ($1, $2, 'completed', '/old/project', 'gpt-4', $3, $3, 'codex', 'api')`,
          "old-session",
          "Old Session",
          "2026-01-01T00:00:00.000Z"
        );
        const existing = await db.prisma.client.$queryRawUnsafe<
          { data_revision: number }[]
        >("SELECT data_revision FROM sessions WHERE id = $1", "old-session");
        assert.equal(existing[0].data_revision, 1);

        // The user_id index exists.
        const idxResult = await db.prisma.client.$queryRawUnsafe<
          { name: string }[]
        >(
          `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_sessions_user_id'`
        );
        assert.equal(idxResult.length, 1, "idx_sessions_user_id created");
      } finally {
        await db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runDataRevisionRebuild correctness — AC1-AC7 (TEST 3-10)", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Rebuild correctness (AC1) — stale session matches fresh import
  // ═══════════════════════════════════════════════════════════════════════════

  test("3: Rebuild correctness (AC1) — rebuilt session matches fresh-import values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t3-"));

    // Build a transcript fixture
    const transcriptPath = writeClaudeTranscript("rebuild-ac1", [
      {
        type: "user",
        timestamp: "2026-06-07T10:00:00.000Z",
        cwd: "/workspace/test",
      },
      {
        type: "assistant",
        timestamp: "2026-06-07T10:00:05.000Z",
        uuid: "u1",
        requestId: "req_001",
        message: {
          id: "msg_001",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    // Import into the main DB, then corrupt it
    const db = await openTestDb(dir);
    try {
      const session = makeSession({
        sessionId: "rebuild-ac1",
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 200,
            output: 100,
            cacheRead: 50,
            cacheWrite: 25,
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-06-07T10:00:05.000Z",
            model: "claude-sonnet-4-5",
            input: 200,
            output: 100,
            cacheRead: 50,
            cacheWrite: 25,
          },
        ],
        messageTimestamps: ["2026-06-07T10:00:05.000Z"],
      });
      await db.importer.importSession(session, "claude");

      // Mark stale + inject inflation (simulate pre-fix corruption)
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "rebuild-ac1"
      );
      // Inflate events to simulate corruption
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ('corrupt-evt-1', 'rebuild-ac1', 'Stop', '2026-06-07T10:00:06.000Z'),
              ('corrupt-evt-2', 'rebuild-ac1', 'Stop', '2026-06-07T10:00:07.000Z')`
      );
      // FEA-1899: stale session→artifact LINK the current parse no longer yields
      // (the fixture has no PR/artifact refs) — the rebuild must clear the session's
      // links for fresh-parse equivalence, BUT the canonical artifact row survives
      // (enrichment lives there and must outlive reparses — AC-3).
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
       VALUES ('art-stale-ac1', 'pr:org/repo:9', 'pull_request', 'org/repo', 9, 'https://github.com/org/repo/pull/9', '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z')`
      );
      await db.run(
        `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES ('link-stale-ac1', 'rebuild-ac1', 'art-stale-ac1', 'created', 'test', '{}', 1, '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z')`
      );
      await seedClaudeCodeOtelSideRows(db, "rebuild-ac1");

      // Record pre-rebuild event count (inflated)
      const preEvents = await db.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >(
        "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
        "rebuild-ac1"
      );
      const preEventCount = preEvents[0].cnt;

      // Build a fake collector that parses the real transcript
      const collector = fakeCollector("claude", {
        sources: [transcriptPath],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "rebuild-ac1",
      });

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(result.rebuilt, 1);

      // data_revision is now current
      const postRow = await db.prisma.client.$queryRawUnsafe<
        {
          data_revision: number;
          updated_at: string;
        }[]
      >(
        "SELECT data_revision, updated_at FROM sessions WHERE id = $1",
        "rebuild-ac1"
      );
      assert.equal(postRow[0].data_revision, DATA_REVISION);
      // updated_at was bumped
      assert.ok(postRow[0].updated_at);

      // Corrupt inflated Stop events are gone — only the import-derived ones remain
      const postEvents = await db.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >(
        "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
        "rebuild-ac1"
      );
      assert.ok(
        postEvents[0].cnt < preEventCount,
        "corrupt events purged by rebuild"
      );

      // Token usage matches what the session provides
      const tu = await db.tokenUsage.getBySession("rebuild-ac1");
      assert.equal(tu.length, 1);
      assert.equal(tu[0].inputTokens, 200);
      assert.equal(tu[0].outputTokens, 100);

      // FEA-1899: the stale session→artifact link the current parse no longer
      // yields is cleared by the rebuild's delete-then-reinsert, but the canonical
      // artifact row survives so its enrichment outlives the reparse (AC-3).
      const staleLink = await db.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >(
        "SELECT COUNT(*) AS cnt FROM session_artifact_links WHERE id = $1",
        "link-stale-ac1"
      );
      assert.equal(staleLink[0].cnt, 0, "stale session_artifact_link cleared");
      const artifactSurvives = await db.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >("SELECT COUNT(*) AS cnt FROM artifacts WHERE id = $1", "art-stale-ac1");
      assert.equal(
        artifactSurvives[0].cnt,
        1,
        "artifact row survives reparse (enrichment outlives reparse)"
      );
      for (const tableName of claudeCodeOtelSideTables) {
        const result = await db.prisma.client.$queryRawUnsafe<
          { cnt: number }[]
        >(
          `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE session_id = $1`,
          "rebuild-ac1"
        );
        assert.equal(
          result[0].cnt,
          0,
          `${tableName} rows are cleared during rebuild`
        );
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Missing source (AC2) — untouched, old revision, counted
  // ═══════════════════════════════════════════════════════════════════════════

  test("4: Missing source (AC2) — stale session with no source is untouched and counted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t4-"));
    const db = await openTestDb(dir);
    try {
      // Import a session, then mark stale
      await db.importer.importSession(
        makeSession({ sessionId: "missing-src" }),
        "claude"
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "missing-src"
      );

      const preTu = await db.tokenUsage.getBySession("missing-src");
      const preEvents = await db.events.getBySession("missing-src");

      // Collector returns NO sources — the session has no surviving transcript
      const collector = fakeCollector("claude", {
        sources: [],
        sessionIdForSource: () => null,
      });

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(result.missingSource, 1);
      assert.equal(result.rebuilt, 0);

      // Session untouched — revision still 1
      const row = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "missing-src");
      assert.equal(row[0].data_revision, 1);

      // Rows unchanged
      const postTu = await db.tokenUsage.getBySession("missing-src");
      const postEvents = await db.events.getBySession("missing-src");
      assert.deepEqual(preTu, postTu);
      assert.equal(preEvents.length, postEvents.length);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("4b: Data-revision rebuild uses injected parser for mapped stale sources", async () => {
    const source = "/fake/rebuild-worker.jsonl";
    const session = makeSession({ sessionId: "rebuild-worker" });
    const parseCalls: Array<{ harness: Harness; source: string }> = [];
    const rebuilt: Array<{ sessionId: string; harness: Harness }> = [];
    let collectorParseCalls = 0;
    const collector = fakeCollector("claude", {
      sources: [source],
      parse: () => {
        collectorParseCalls++;
        return Promise.reject(new Error("rebuild should use injected parser"));
      },
      sessionIdForSource: () => "rebuild-worker",
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "rebuild-worker",
            harness: "claude",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: (parsedSession, harness) => {
          rebuilt.push({ sessionId: parsedSession.sessionId, harness });
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
      },
      parseSource: (parsedCollector, parsedSource) => {
        parseCalls.push({
          harness: parsedCollector.key,
          source: parsedSource,
        });
        return Promise.resolve([session]);
      },
    });

    assert.equal(result.rebuilt, 1);
    assert.equal(collectorParseCalls, 0);
    assert.deepEqual(parseCalls, [{ harness: "claude", source }]);
    assert.deepEqual(rebuilt, [
      { sessionId: "rebuild-worker", harness: "claude" },
    ]);
  });

  test("4c: Data-revision rebuild yields after maintenance writes", async () => {
    const source = "/fake/rebuild-yield.jsonl";
    const delayCalls: number[] = [];
    const collector = fakeCollector("claude", {
      sources: [source],
      sessionIdForSource: () => "rebuild-yield",
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "rebuild-yield",
            harness: "claude",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      cooperativeDelay: (ms) => {
        delayCalls.push(ms);
        return Promise.resolve();
      },
      parseSource: () =>
        Promise.resolve([makeSession({ sessionId: "rebuild-yield" })]),
    });

    assert.equal(result.rebuilt, 1);
    assert.deepEqual(delayCalls, [50]);
  });

  test("4d: Data-revision rebuild stops before parsing when cancellation hook is false", async () => {
    let parseCalls = 0;
    const collector = fakeCollector("claude", {
      sources: ["/fake/cancelled.jsonl"],
      sessionIdForSource: () => "cancelled",
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: "cancelled",
              harness: "claude",
              status: "completed",
            },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      shouldContinue: () => false,
      parseSource: () => {
        parseCalls++;
        return Promise.resolve([makeSession({ sessionId: "cancelled" })]);
      },
    });

    assert.equal(result.staleTotal, 1);
    assert.equal(result.rebuilt, 0);
    assert.equal(parseCalls, 0);
  });

  test("4e: Data-revision rebuild counts parser-output failures as parseErrors without missingSource", async () => {
    const source = "/fake/rebuild-parser-output-error.jsonl";
    const logs: string[] = [];
    const collector = fakeCollector("claude", {
      sources: [source],
      sessionIdForSource: () => "parser-output-error",
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "parser-output-error",
            harness: "claude",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      log: (message) => logs.push(message),
      parseSource: () =>
        Promise.reject(
          new HistoricalParseWorkerFailureError(
            "historical parse worker sent an invalid response for historical-parse-1",
            "parser_output_validation",
            "sessions.0.name:too_big:Too big"
          )
        ),
    });

    assert.equal(result.parseErrors, 1);
    assert.equal(result.missingSource, 0);
    assert.equal(result.errors, 0);
    assert.equal(
      logs.some((message) =>
        message.includes("parseError=parser-output-error")
      ),
      true
    );
    assert.equal(
      logs.some((message) => message.includes("parseErrors=1")),
      true
    );
  });

  test("4e.1: Unmapped parser-output failure does not clear later stale source rebuilds", async () => {
    const malformedSource = "/fake/copilot-chat-bad.json";
    const validSource = "/fake/copilot-chat-good.json";
    const rebuilt: Array<{ sessionId: string; harness: Harness }> = [];
    const logs: string[] = [];
    const collector = fakeCollector("copilot", {
      sources: [malformedSource, validSource],
      sessionIdForSource: () => null,
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "copilot-chat-bad",
            harness: "copilot",
            status: "completed",
          },
          {
            id: "copilot-chat-good",
            harness: "copilot",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: (parsedSession, harness) => {
          rebuilt.push({ sessionId: parsedSession.sessionId, harness });
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
      },
      log: (message) => logs.push(message),
      parseSource: (_parsedCollector, source) => {
        if (source === malformedSource) {
          return Promise.reject(
            new HistoricalParseWorkerFailureError(
              "historical parse worker sent an invalid response for historical-parse-1",
              "parser_output_validation",
              "sessions.0.name:too_big:Too big"
            )
          );
        }
        return Promise.resolve([
          makeSession({ sessionId: "copilot-chat-good" }),
        ]);
      },
    });

    assert.equal(result.parseErrors, 1);
    assert.equal(result.rebuilt, 1);
    assert.equal(result.missingSource, 0);
    assert.deepEqual(rebuilt, [
      { sessionId: "copilot-chat-good", harness: "copilot" },
    ]);
    assert.equal(
      logs.some((message) => message.includes("parseError=unmapped-source")),
      true
    );
  });

  test("4e.2: Data-revision rebuild counts unmapped parser-output failures before cancellation", async () => {
    const malformedSource = "/fake/copilot-chat-bad.json";
    const skippedSource = "/fake/copilot-chat-skipped.json";
    let shouldContinueCalls = 0;
    let parseCalls = 0;
    const collector = fakeCollector("copilot", {
      sources: [malformedSource, skippedSource],
      sessionIdForSource: () => null,
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "copilot-chat-bad",
            harness: "copilot",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      shouldContinue: () => {
        shouldContinueCalls++;
        return shouldContinueCalls <= 3;
      },
      parseSource: () => {
        parseCalls++;
        return Promise.reject(
          new HistoricalParseWorkerFailureError(
            "historical parse worker sent an invalid response for historical-parse-1",
            "parser_output_validation",
            "sessions.0.name:too_big:Too big"
          )
        );
      },
    });

    assert.equal(parseCalls, 1);
    assert.equal(result.parseErrors, 1);
    assert.equal(result.missingSource, 0);
  });

  test("4f: Data-revision rebuild keeps ordinary read failures retryable as missingSource", async () => {
    const collector = fakeCollector("claude", {
      sources: ["/fake/mid-write.jsonl"],
      sessionIdForSource: () => "mid-write",
    });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          {
            id: "mid-write",
            harness: "claude",
            status: "completed",
          },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      parseSource: () =>
        Promise.reject(new Error("file changed while reading")),
    });

    assert.equal(result.parseErrors, 0);
    assert.equal(result.missingSource, 1);
  });

  test("4g: missing-source sessions get their analytics rollup recomputed from stored metadata (FEA-2641)", async () => {
    const recomputed: string[][] = [];
    const collector = fakeCollector("claude", { sources: [] });

    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => [
          // claude session whose transcript is gone (collector has no sources)
          { id: "gone-claude", harness: "claude", status: "completed" },
          // orphaned harness with no collector at all
          { id: "gone-orphan", harness: "mystery", status: "completed" },
          // active session must NOT be recomputed (heals via reimport)
          { id: "still-active", harness: "claude", status: "active" },
        ],
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (ids) => {
          recomputed.push(ids);
          return Promise.resolve();
        },
      },
    });

    assert.equal(result.missingSource, 2);
    assert.equal(result.missingSourceRollupsRecomputed, 2);
    assert.equal(recomputed.length, 1);
    assert.deepEqual(recomputed[0]?.toSorted(), ["gone-claude", "gone-orphan"]);
  });

  test("4h: missing-source recompute heals a polluted is_human row from stored metadata while data_revision stays stale (FEA-2641)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea2641-t4h-"));
    const db = await openTestDb(dir);
    try {
      const session = makeSession({ sessionId: "gone-source" });
      await db.importer.importSession(session, "claude");
      // Simulate the pre-FEA-2641 polluted rollup (substring-fallback era) and
      // a stale revision whose source transcript no longer exists.
      await db.run(
        "UPDATE session_analytics SET is_human = 1, human_turns = 0 WHERE session_id = $1",
        "gone-source"
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "gone-source"
      );

      const collector = fakeCollector("claude", { sources: [] });
      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(result.missingSource, 1);
      assert.equal(result.missingSourceRollupsRecomputed, 1);
      const [row] = await db.prisma.client.$queryRawUnsafe<
        { is_human: number; human_turns: number; data_revision: number }[]
      >(
        `SELECT sa.is_human, sa.human_turns, s.data_revision
         FROM session_analytics sa JOIN sessions s ON s.id = sa.session_id
         WHERE sa.session_id = $1`,
        "gone-source"
      );
      // Stored metadata has an empty $.messages array → transcript-first count
      // is 0; the polluted classification heals without a source file.
      assert.equal(row.is_human, 0);
      assert.equal(row.human_turns, 0);
      // The stale stamp is the durable "not re-derived from source" marker.
      assert.equal(row.data_revision, 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Idempotency (AC3) — second pass rebuilds nothing
  // ═══════════════════════════════════════════════════════════════════════════

  test("5: Idempotency (AC3) — second runDataRevisionRebuild rebuilds nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t5-"));
    const db = await openTestDb(dir);
    try {
      const session = makeSession({ sessionId: "idemp" });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "idemp"
      );

      const collector = fakeCollector("claude", {
        sources: ["/fake/transcript.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "idemp",
      });

      // First rebuild
      const r1 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r1.rebuilt, 1);

      // Second rebuild — nothing stale
      const r2 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r2.staleTotal, 0);
      assert.equal(r2.rebuilt, 0);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: Interrupt resume (AC4) — parse error, second pass completes
  // ═══════════════════════════════════════════════════════════════════════════

  test("6: Interrupt resume (AC4) — parse error leaves session stale; second pass rebuilds it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t6-"));
    const db = await openTestDb(dir);
    try {
      const sessionA = makeSession({ sessionId: "resume-a" });
      const sessionB = makeSession({ sessionId: "resume-b" });
      await db.importer.importSession(sessionA, "claude");
      await db.importer.importSession(sessionB, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id IN ($2, $3)",
        1,
        "resume-a",
        "resume-b"
      );

      let parseCallCountB = 0;
      const collector = fakeCollector("claude", {
        sources: ["/fake/a.jsonl", "/fake/b.jsonl"],
        parse: (source: string) => {
          if (source === "/fake/a.jsonl") {
            return Promise.resolve([sessionA]);
          }
          parseCallCountB++;
          if (parseCallCountB === 1) {
            return Promise.reject(new Error("simulated parse error"));
          }
          return Promise.resolve([sessionB]);
        },
        sessionIdForSource: (source: string) =>
          source.includes("a.jsonl") ? "resume-a" : "resume-b",
      });

      // First run: A rebuilt, B fails (parse throw caught → stays stale)
      const r1 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r1.rebuilt, 1); // A
      // B stays stale (missingSource because the parse throw makes it skip)
      const rowB1 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "resume-b");
      assert.equal(rowB1[0].data_revision, 1);

      // Second run: B rebuilds because parse now succeeds
      const r2 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r2.rebuilt, 1); // B

      // No duplicates — check event counts match a single import
      const eventsA = await db.events.getBySession("resume-a");
      const eventsB = await db.events.getBySession("resume-b");
      // Both should have the same event count (imported from identical session shape)
      assert.equal(eventsA.length, eventsB.length);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 7: Wipe-and-reimport equivalence (AC5) — aggregates match
  // ═══════════════════════════════════════════════════════════════════════════

  test("7: Wipe-and-reimport equivalence (AC5) — rebuilt DB aggregates match fresh-import DB", async () => {
    const dirRebuild = await mkdtemp(path.join(os.tmpdir(), "fea1785-t7r-"));
    const dirFresh = await mkdtemp(path.join(os.tmpdir(), "fea1785-t7f-"));
    const session = makeSession({
      sessionId: "equiv-test",
      tokensByModel: {
        "claude-sonnet-4-5": {
          input: 500,
          output: 250,
          cacheRead: 100,
          cacheWrite: 50,
        },
      },
      tokenSeries: [
        {
          timestamp: "2026-06-07T10:00:30.000Z",
          model: "claude-sonnet-4-5",
          input: 250,
          output: 125,
          cacheRead: 50,
          cacheWrite: 25,
        },
        {
          timestamp: "2026-06-07T10:01:00.000Z",
          model: "claude-sonnet-4-5",
          input: 250,
          output: 125,
          cacheRead: 50,
          cacheWrite: 25,
        },
      ],
      messageTimestamps: [
        "2026-06-07T10:00:30.000Z",
        "2026-06-07T10:01:00.000Z",
      ],
      toolUses: [
        { name: "Read", timestamp: "2026-06-07T10:00:35.000Z", id: "toolu_A" },
      ],
    });

    const dbRebuild = await openTestDb(dirRebuild);
    const dbFresh = await openTestDb(dirFresh);
    try {
      // Rebuild DB: import, corrupt, rebuild
      await dbRebuild.importer.importSession(session, "claude");
      await dbRebuild.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "equiv-test"
      );
      // Inflate an extra token_usage row (corruption)
      await dbRebuild.run(
        `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, 'corrupt-model', '2026-06-07T09:00:00.000Z', 9999, 9999, 0, 0)`,
        "equiv-test"
      );

      const collector = fakeCollector("claude", {
        sources: ["/fake/equiv.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "equiv-test",
      });
      await runDataRevisionRebuild({ collectors: [collector], db: dbRebuild });

      // Fresh DB: clean import only
      await dbFresh.importer.importSession(session, "claude");

      // Compare token_usage aggregates
      const tuRebuild = await dbRebuild.tokenUsage.getBySession("equiv-test");
      const tuFresh = await dbFresh.tokenUsage.getBySession("equiv-test");
      assert.equal(tuRebuild.length, tuFresh.length);
      for (let i = 0; i < tuRebuild.length; i++) {
        assert.equal(tuRebuild[i].inputTokens, tuFresh[i].inputTokens);
        assert.equal(tuRebuild[i].outputTokens, tuFresh[i].outputTokens);
      }

      // Compare event counts
      const evRebuild = await dbRebuild.events.getBySession("equiv-test");
      const evFresh = await dbFresh.events.getBySession("equiv-test");
      assert.equal(evRebuild.length, evFresh.length);

      // Compare agent counts
      const agRebuild = await dbRebuild.agents.getBySession("equiv-test");
      const agFresh = await dbFresh.agents.getBySession("equiv-test");
      assert.equal(agRebuild.length, agFresh.length);

      // Compare token_events counts
      const teRebuild = await dbRebuild.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >(
        "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
        "equiv-test"
      );
      const teFresh = await dbFresh.prisma.client.$queryRawUnsafe<
        { cnt: number }[]
      >(
        "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
        "equiv-test"
      );
      assert.equal(teRebuild[0].cnt, teFresh[0].cnt);
    } finally {
      await dbRebuild.close();
      await dbFresh.close();
      await rm(dirRebuild, { recursive: true, force: true });
      await rm(dirFresh, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 8: != both directions (AC6) — revision 99 also rebuilds
  // ═══════════════════════════════════════════════════════════════════════════

  test("8: != both directions (AC6) — session with data_revision=99 is rebuilt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t8-"));
    const db = await openTestDb(dir);
    try {
      const session = makeSession({ sessionId: "future-rev" });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        99,
        "future-rev"
      );

      const collector = fakeCollector("claude", {
        sources: ["/fake/future.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "future-rev",
      });

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(result.staleTotal, 1);
      assert.equal(result.rebuilt, 1);

      const row = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "future-rev");
      assert.equal(row[0].data_revision, DATA_REVISION);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 9: Burst-artifact deletion (AC7) — codex burst → session deleted
  // ═══════════════════════════════════════════════════════════════════════════

  test("9: Burst-artifact deletion (AC7) — stale codex session whose source yields [] is deleted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t9-"));
    const db = await openTestDb(dir);
    try {
      // Import a session under codex harness
      const session = makeSession({
        sessionId: CODEX_UUID,
        entrypoint: "codex",
        model: "gpt-5.5",
      });
      await db.importer.importSession(session, "codex");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        CODEX_UUID
      );

      // The collector parses the source to [] (burst detection → null / empty)
      // and positively classifies it as a burst artifact via isBurstArtifactSource.
      const collector: HarnessCollector = {
        ...fakeCollector("codex", {
          sources: ["/fake/burst-rollout.jsonl"],
          parse: () => Promise.resolve([]),
          sessionIdForSource: () => CODEX_UUID,
        }),
        isBurstArtifactSource: () => true,
      };

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(result.deleted, 1);

      // Session row is gone
      const row = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM sessions WHERE id = $1",
        CODEX_UUID
      );
      assert.equal(row.length, 0);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 10: OpenCode bypass — listSourcesForRebuild consulted
  // ═══════════════════════════════════════════════════════════════════════════

  test("10: OpenCode bypass — listSourcesForRebuild is used instead of listSources for rebuild", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t10-"));
    const db = await openTestDb(dir);
    try {
      const session = makeSession({
        sessionId: "opencode-stale",
        entrypoint: "opencode",
      });
      await db.importer.importSession(session, "opencode");
      await db.run(
        "UPDATE sessions SET data_revision = $1, harness = 'opencode' WHERE id = $2",
        1,
        "opencode-stale"
      );

      // Batch collector: listSources returns [] (fingerprint unchanged)
      // but listSourcesForRebuild returns a sentinel that parses the session
      const collector = fakeCollector("opencode", {
        sources: [], // empty — fingerprint says unchanged
        batch: true,
        listSourcesForRebuild: () => ["/fake/opencode-sentinel"],
        parse: (source: string) => {
          if (source === "/fake/opencode-sentinel") {
            return Promise.resolve([session]);
          }
          return Promise.resolve([]);
        },
        // OpenCode has no sessionIdForSource — parse-then-match
      });

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(result.rebuilt, 1);
      const row = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "opencode-stale");
      assert.equal(row[0].data_revision, DATA_REVISION);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Rebuild lifecycle & integration: boot signal, deletion, concurrency, guards (TEST 11-17)", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 11: Boot-complete signal — fires once; not after stop()
  // ═══════════════════════════════════════════════════════════════════════════

  test("11: Boot-complete signal — onBootImportComplete fires once after initial imports; not after stop()", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fea1785-t11-"));
    try {
      const imported: string[] = [];
      let bootCompleteCount = 0;

      // Part 1: fires once after initial imports settle
      let resolveBootComplete: () => void;
      const bootCompletePromise = new Promise<void>((resolve) => {
        resolveBootComplete = resolve;
      });

      const manager = new CollectorManager({
        importer: {
          importSession: (session) => {
            imported.push(session.sessionId);
            return { skipped: false, reactivated: false };
          },
        },
        detectBillingMode: () => "metered_api",
        stateDir: dir,
        emit: () => {},
        getCollectionMode: () => "watcher",
        onBootImportComplete: () => {
          bootCompleteCount++;
          resolveBootComplete();
        },
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/boot1.jsonl"],
            parse: () =>
              Promise.resolve([makeSession({ sessionId: "boot-session" })]),
          }),
        ],
      });

      manager.start();
      await bootCompletePromise;
      manager.stop();

      assert.equal(
        bootCompleteCount,
        1,
        "onBootImportComplete fires exactly once"
      );
      assert.ok(imported.includes("boot-session"));

      // Part 2: stop() before imports settle — onBootImportComplete does NOT fire.
      // Uses a deferred promise so we deterministically control when the import
      // resolves, avoiding timing-based assertions.
      let stopBootCount = 0;
      let resolveImport: (() => void) | undefined;
      let importStarted = false;
      let resolveImportStarted: (() => void) | undefined;
      const importStartedPromise = new Promise<void>((r) => {
        resolveImportStarted = r;
      });

      const manager2 = new CollectorManager({
        importer: {
          importSession: async () => {
            importStarted = true;
            resolveImportStarted?.();
            await new Promise<void>((res) => {
              resolveImport = res;
            });
            return { skipped: false, reactivated: false };
          },
        },
        detectBillingMode: () => "metered_api",
        stateDir: dir,
        emit: () => {},
        getCollectionMode: () => "watcher",
        onBootImportComplete: () => {
          stopBootCount++;
        },
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/stop-test.jsonl"],
            parse: () =>
              Promise.resolve([makeSession({ sessionId: "stop-session" })]),
          }),
        ],
      });

      manager2.start();
      await importStartedPromise;
      manager2.stop();
      resolveImport?.();

      // Allow any pending microtasks/callbacks to fire
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.ok(importStarted, "import should have started");
      assert.equal(
        stopBootCount,
        0,
        "onBootImportComplete does not fire after stop()"
      );
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
  });

  test("11b: ordinary import deletes current-revision folded child rows only after positive classification", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fea1785-t11b-"));
    try {
      const deleted: string[] = [];
      let resolveBootComplete: (() => void) | undefined;
      const bootComplete = new Promise<void>((resolve) => {
        resolveBootComplete = resolve;
      });
      const collector: HarnessCollector = {
        ...fakeCollector("codex", {
          sources: ["/fake/folded-child.jsonl", "/fake/missing-parent.jsonl"],
          parse: () => Promise.resolve([]),
          sessionIdForSource: (source) =>
            source.includes("folded-child")
              ? "folded-child"
              : "missing-parent-child",
        }),
        isBurstArtifactSource: (source) => source.includes("folded-child"),
      };
      const manager = new CollectorManager({
        importer: {
          importSession: async () => ({ skipped: false, reactivated: false }),
        },
        detectBillingMode: () => "metered_api",
        stateDir: dir,
        emit: () => {},
        getCollectionMode: () => "disabled",
        catchupPollMs: null,
        collectors: [collector],
        deleteSessionRow: (sessionId) => {
          deleted.push(sessionId);
          return Promise.resolve();
        },
        onBootImportComplete: () => {
          resolveBootComplete?.();
        },
      });

      manager.start();
      await bootComplete;
      manager.stop();

      assert.deepEqual(deleted, ["folded-child"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11c: cached Codex child rows converge when parent appears later", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t11c-"));
    const db = await openTestDb(dir);
    try {
      const stateDir = path.join(dir, "state");
      const sourcesDir = path.join(dir, "sources");
      const parentSource = path.join(sourcesDir, "parent.jsonl");
      const childSource = path.join(sourcesDir, "child.jsonl");
      const missingParentChildSource = path.join(
        sourcesDir,
        "missing-parent-child.jsonl"
      );
      mkdirSync(sourcesDir, { recursive: true });
      writeFileSync(childSource, "{}\n", "utf8");
      writeFileSync(missingParentChildSource, "{}\n", "utf8");

      const deleted: string[] = [];
      const startManager = async (
        sources: string[],
        parse: (source: string) => Promise<NormalizedSession[]>,
        isBurstArtifactSource: (source: string) => boolean
      ) => {
        let resolveBootComplete: (() => void) | undefined;
        const bootComplete = new Promise<void>((resolve) => {
          resolveBootComplete = resolve;
        });
        const collector: HarnessCollector = {
          ...fakeCollector("codex", {
            sources,
            parse,
            sessionIdForSource: (source) => path.basename(source, ".jsonl"),
          }),
          isBurstArtifactSource,
        };
        const manager = new CollectorManager({
          importer: db.importer,
          detectBillingMode: () => "metered_api",
          stateDir,
          emit: () => {},
          getCollectionMode: () => "disabled",
          catchupPollMs: null,
          collectors: [collector],
          listExistingSessionIds: () => db.listExistingSessionIds(),
          deleteSessionRow: async (sessionId) => {
            deleted.push(sessionId);
            await db.deleteSessionRow(sessionId);
          },
          onBootImportComplete: () => {
            resolveBootComplete?.();
          },
        });
        manager.start();
        await bootComplete;
        manager.stop();
      };

      await startManager(
        [childSource, missingParentChildSource],
        async (source) => [
          makeSession({
            sessionId: path.basename(source, ".jsonl"),
            toolUses:
              source === childSource
                ? [
                    {
                      name: "Read",
                      timestamp: "2026-06-07T10:00:40.000Z",
                      input: { file_path: "child.ts" },
                    },
                  ]
                : [],
          }),
        ],
        () => false
      );
      assert.ok(await db.sessions.getById("child"));
      assert.ok(await db.sessions.getById("missing-parent-child"));
      assert.equal((await db.events.getBySession("child")).length > 0, true);

      writeFileSync(parentSource, "{}\n", "utf8");
      await startManager(
        [parentSource, childSource, missingParentChildSource],
        async (source) =>
          source === parentSource ? [makeSession({ sessionId: "parent" })] : [],
        (source) => source === childSource
      );

      assert.deepEqual(deleted, ["child"]);
      assert.equal(await db.sessions.getById("child"), undefined);
      assert.deepEqual(await db.events.getBySession("child"), []);
      assert.ok(await db.sessions.getById("parent"));
      assert.ok(await db.sessions.getById("missing-parent-child"));

      await startManager(
        [parentSource, childSource, missingParentChildSource],
        async (source) =>
          source === parentSource ? [makeSession({ sessionId: "parent" })] : [],
        (source) => source === childSource
      );

      assert.deepEqual(deleted, ["child"]);
      assert.ok(await db.sessions.getById("missing-parent-child"));
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 12: Orphan-free deletion — zero rows in all child tables
  // ═══════════════════════════════════════════════════════════════════════════

  test("12: Orphan-free deletion — deleteSessionRow removes rows from all child tables + sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t12-"));
    const db = await openTestDb(dir);
    try {
      const sid = "orphan-test";
      // Import a session to get the base structure
      await db.importer.importSession(
        makeSession({
          sessionId: sid,
          tokensByModel: {
            "claude-sonnet-4-5": {
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 5,
            },
          },
          tokenSeries: [
            {
              timestamp: "2026-06-07T10:00:30.000Z",
              model: "claude-sonnet-4-5",
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 5,
            },
          ],
          messageTimestamps: ["2026-06-07T10:00:30.000Z"],
          toolUses: [
            {
              name: "Task",
              timestamp: "2026-06-07T10:00:40.000Z",
              id: "toolu_X",
              input: { prompt: "test" },
              resultTimestamp: "2026-06-07T10:00:50.000Z",
            },
          ],
        }),
        "claude"
      );

      // FEA-1899: insert an artifact + a session→artifact link (replacing the
      // dropped pull_requests / pr_backfill_seen tables). deleteSessionRow clears
      // the link; the artifact row is session-agnostic and intentionally survives.
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 1, 'https://github.com/org/repo/pull/1', $3, $3)`,
        `art-${sid}`,
        `pr:org/repo:1:${sid}`,
        "2026-06-07T10:00:00.000Z"
      );
      await db.run(
        `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'created', 'test', '{}', 1, $4, $4)`,
        `link-${sid}`,
        sid,
        `art-${sid}`,
        "2026-06-07T10:00:00.000Z"
      );
      await db.codexOtel.persistBatch({
        spans: [
          {
            traceId: "delete-trace",
            spanId: "delete-span",
            sessionId: sid,
            name: "codex.exec",
            startTime: "2026-06-07T10:00:30.000Z",
            endTime: "2026-06-07T10:00:31.000Z",
            durationMs: 1000,
            status: CodexOtelSpanStatus.Ok,
            toolName: "shell",
          },
        ],
        tokenUsage: [
          {
            sessionId: sid,
            model: "gpt-5-codex",
            inputTokens: 9,
            outputTokens: 8,
            cacheReadTokens: 7,
            cacheWriteTokens: 6,
            observedAt: "2026-06-07T10:00:30.000Z",
          },
        ],
      });
      await seedClaudeCodeOtelSideRows(db, sid);

      // FEA-3132: session_turn_bucket has no FK cascade (re-derived per import),
      // so deleteSessionRow must purge it explicitly. Seed a row directly so the
      // pre-delete assertion is deterministic regardless of import materialization.
      await db.run(
        `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
       VALUES ($1, $2, 'human', 3)`,
        sid,
        "2026-06-07T10:00:30.000Z"
      );

      // Verify rows exist before deletion
      const tables = [
        { name: "sessions", col: "id" },
        { name: "events", col: "session_id" },
        { name: "token_events", col: "session_id" },
        { name: "token_usage", col: "session_id" },
        { name: "codex_trace_span", col: "session_id" },
        { name: ClaudeCodeOtelTableName.CostEvent, col: "session_id" },
        { name: ClaudeCodeOtelTableName.PermissionEvent, col: "session_id" },
        { name: ClaudeCodeOtelTableName.ApiRequest, col: "session_id" },
        { name: "agents", col: "session_id" },
        { name: "session_artifact_links", col: "session_id" },
        { name: "session_turn_bucket", col: "session_id" },
      ];

      for (const t of tables) {
        const result = await db.prisma.client.$queryRawUnsafe<
          { cnt: number }[]
        >(`SELECT COUNT(*) AS cnt FROM ${t.name} WHERE ${t.col} = $1`, sid);
        assert.ok(
          result[0].cnt > 0,
          `${t.name} should have rows before delete`
        );
      }

      // Delete the session
      await db.deleteSessionRow(sid);

      // Verify zero rows in ALL tables
      for (const t of tables) {
        const result = await db.prisma.client.$queryRawUnsafe<
          { cnt: number }[]
        >(`SELECT COUNT(*) AS cnt FROM ${t.name} WHERE ${t.col} = $1`, sid);
        assert.equal(
          result[0].cnt,
          0,
          `${t.name} should have zero rows after delete`
        );
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("12b: Data revision rebuild preserves OTel token rows and trace spans while replacing parser rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t12b-"));
    const db = await openTestDb(dir);
    try {
      const sid = "otel-rebuild-preserve";
      const parserModel = "claude-sonnet-4-5";
      const otelModel = "gpt-5-codex";
      const session = makeSession({
        sessionId: sid,
        tokensByModel: {
          [parserModel]: {
            input: 20,
            output: 10,
            cacheRead: 4,
            cacheWrite: 2,
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-06-07T10:00:30.000Z",
            model: parserModel,
            input: 20,
            output: 10,
            cacheRead: 4,
            cacheWrite: 2,
          },
        ],
      });
      await db.importer.importSession(
        makeSession({
          ...session,
          tokensByModel: {
            [parserModel]: {
              input: 999,
              output: 999,
              cacheRead: 999,
              cacheWrite: 999,
            },
          },
        }),
        "claude"
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        sid
      );
      await db.codexOtel.persistBatch({
        spans: [
          {
            traceId: "preserve-trace",
            spanId: "preserve-span",
            sessionId: sid,
            name: "codex.exec",
            startTime: "2026-06-07T10:00:30.000Z",
            endTime: "2026-06-07T10:00:31.000Z",
            durationMs: 1000,
            status: CodexOtelSpanStatus.Ok,
            toolName: "shell",
          },
        ],
        tokenUsage: [
          {
            sessionId: sid,
            model: otelModel,
            inputTokens: 111,
            outputTokens: 55,
            cacheReadTokens: 22,
            cacheWriteTokens: 11,
            observedAt: "2026-06-07T10:00:30.000Z",
          },
        ],
      });

      const staleRow = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", sid);
      assert.equal(staleRow[0].data_revision, 1);

      const result = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/otel-rebuild-preserve.jsonl"],
            parse: () => Promise.resolve([session]),
            sessionIdForSource: () => sid,
          }),
        ],
        db,
      });

      assert.equal(result.staleTotal, 1);
      assert.equal(result.rebuilt, 1);
      // input_tokens is a BigInt column → Prisma raw returns it as `bigint`;
      // coerce to a number to match the prior raw path and the expected literals.
      const tokenRows = (
        await db.prisma.client.$queryRawUnsafe<
          {
            model: string;
            input_tokens: number | bigint;
            usage_source: string;
            revision_id: number;
          }[]
        >(
          `SELECT model, input_tokens, usage_source, revision_id
       FROM token_usage
       WHERE session_id = $1
       ORDER BY model ASC`,
          sid
        )
      ).map((r) => ({ ...r, input_tokens: Number(r.input_tokens) }));
      assert.deepEqual(tokenRows, [
        {
          model: parserModel,
          input_tokens: 20,
          usage_source: CodexOtelTokenUsageSource.JsonlParser,
          revision_id: DATA_REVISION,
        },
        {
          model: otelModel,
          input_tokens: 111,
          usage_source: CodexOtelTokenUsageSource.OtelLogPayload,
          revision_id: DATA_REVISION,
        },
      ]);
      const spans = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
        "SELECT COUNT(*) AS cnt FROM codex_trace_span WHERE session_id = $1",
        sid
      );
      assert.equal(spans[0].cnt, 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 13: Concurrent import during rebuild — write-queue serialization
  // ═══════════════════════════════════════════════════════════════════════════

  test("13: Concurrent import during rebuild — both sessions complete correctly via write-queue serialization", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t13-"));
    const db = await openTestDb(dir);
    try {
      const sessionA = makeSession({
        sessionId: "concurrent-a",
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
      const sessionB = makeSession({
        sessionId: "concurrent-b",
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 200,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });

      // Import A and mark stale
      await db.importer.importSession(sessionA, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        "concurrent-a"
      );

      // Use a deferred promise to control interleaving
      let resolveDeferred: () => void;
      const deferredPromise = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });

      const collector = fakeCollector("claude", {
        sources: ["/fake/a.jsonl"],
        parse: async () => {
          // While rebuild is processing A, wait on the deferred promise
          await deferredPromise;
          return [sessionA];
        },
        sessionIdForSource: () => "concurrent-a",
      });

      // Start rebuild (it will block on the deferred parse)
      const rebuildPromise = runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      // While rebuild is blocked, import B via the normal path
      const importPromise = db.importer.importSession(sessionB, "claude");

      // Resolve the deferred promise so rebuild can proceed
      resolveDeferred!();

      // Wait for both to complete
      const [rebuildResult] = await Promise.all([
        rebuildPromise,
        importPromise,
      ]);

      assert.equal(rebuildResult.rebuilt, 1);

      // Both sessions exist and are correct
      const rowA = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "concurrent-a");
      assert.equal(rowA[0].data_revision, DATA_REVISION);

      const rowB = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "concurrent-b");
      assert.equal(rowB[0].data_revision, DATA_REVISION);

      // Token usage is correct for both
      const tuA = await db.tokenUsage.getBySession("concurrent-a");
      assert.equal(tuA[0].inputTokens, 100);

      const tuB = await db.tokenUsage.getBySession("concurrent-b");
      assert.equal(tuB[0].inputTokens, 200);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 14: Active-session guard — skipped + counted; flip → rebuilds
  // ═══════════════════════════════════════════════════════════════════════════

  test("14: Active-session guard — stale active session is skipped; after completing, next run rebuilds it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t14-"));
    const db = await openTestDb(dir);
    try {
      // Import a session and set it as active + stale
      const session = makeSession({ sessionId: "active-guard" });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, status = 'active' WHERE id = $2",
        1,
        "active-guard"
      );

      const collector = fakeCollector("claude", {
        sources: ["/fake/active.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "active-guard",
      });

      // First run: active → skipped
      const r1 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r1.skippedActive, 1);
      assert.equal(r1.rebuilt, 0);

      // Session untouched — still revision 1
      const row1 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "active-guard");
      assert.equal(row1[0].data_revision, 1);

      // Flip status to completed
      await db.run(
        "UPDATE sessions SET status = 'completed' WHERE id = $1",
        "active-guard"
      );

      // Second run: now rebuilds
      const r2 = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(r2.rebuilt, 1);
      assert.equal(r2.skippedActive, 0);

      const row2 = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", "active-guard");
      assert.equal(row2[0].data_revision, DATA_REVISION);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 15: Reactivated rebuild — recreated main agent reflects post-reactivation
  // state (PR #1565 review): a stale terminal session whose source is inside the
  // recent-activity window is reactivated during rebuild; the recreated main
  // agent must be 'waiting', not 'completed'.
  // ═══════════════════════════════════════════════════════════════════════════

  test("15: Reactivated rebuild — main agent recreated as waiting, not completed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t15-"));
    const db = await openTestDb(dir);
    try {
      const sid = "rebuild-reactivate";
      const base = makeSession({
        sessionId: sid,
        messageTimestamps: ["2026-06-07T10:00:05.000Z"],
      });
      await db.importer.importSession(base, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        1,
        sid
      );

      const preRow = await db.prisma.client.$queryRawUnsafe<
        { status: string }[]
      >("SELECT status FROM sessions WHERE id = $1", sid);
      assert.equal(preRow[0].status, "completed", "precondition: terminal");

      // Re-parsed session is inside the 10-minute recent-activity window
      // relative to the pinned clock (2026-06-07T12:00:00Z) → reactivation fires.
      const reparsed = makeSession({
        sessionId: sid,
        messageTimestamps: ["2026-06-07T10:00:05.000Z"],
        fileModifiedAt: Date.parse("2026-06-07T11:55:00.000Z"),
      });
      const collector = fakeCollector("claude", {
        sources: ["/tmp/fake-source"],
        parse: () => Promise.resolve([reparsed]),
        sessionIdForSource: () => sid,
      });
      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(result.rebuilt, 1);

      const post = await db.prisma.client.$queryRawUnsafe<{ status: string }[]>(
        "SELECT status FROM sessions WHERE id = $1",
        sid
      );
      assert.equal(post[0].status, "active", "session reactivated");

      const agent = await db.prisma.client.$queryRawUnsafe<
        {
          status: string;
          ended_at: string | null;
        }[]
      >(
        "SELECT status, ended_at FROM agents WHERE session_id = $1 AND type = 'main'",
        sid
      );
      assert.equal(agent.length, 1, "main agent recreated");
      assert.equal(agent[0].status, "waiting", "agent reflects active session");
      assert.equal(agent[0].ended_at, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 15b: Metadata refresh — rebuild updates sessions.metadata
  // ═══════════════════════════════════════════════════════════════════════════

  test("15b: Metadata refresh — rebuild replaces stale metadata with current parse output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t15-"));
    const db = await openTestDb(dir);
    try {
      const sid = "meta-refresh";
      // Import a session with initial metadata
      const session = makeSession({
        sessionId: sid,
        plans: [{ title: "old plan", status: "active" }],
        userMessages: 5,
      });
      await db.importer.importSession(session, "claude");

      const before = await db.prisma.client.$queryRawUnsafe<
        { metadata: string }[]
      >("SELECT metadata FROM sessions WHERE id = $1", sid);
      const metaBefore = JSON.parse(before[0].metadata);
      assert.equal(metaBefore.userMessages, 5);
      assert.equal(metaBefore.plans.length, 1);

      // Downgrade revision to make it stale
      await db.run(
        "UPDATE sessions SET data_revision = 0, status = 'completed' WHERE id = $1",
        sid
      );

      // Rebuild with updated metadata
      const updatedSession = makeSession({
        sessionId: sid,
        plans: [
          { title: "plan 1", status: "active" },
          { title: "plan 2", status: "completed" },
        ],
        userMessages: 12,
      });
      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: [`/fake/${sid}.jsonl`],
            sessionIdForSource: () => sid,
            parse: () => Promise.resolve([updatedSession]),
          }),
        ],
        db,
      });
      assert.equal(summary.rebuilt, 1);

      const after = await db.prisma.client.$queryRawUnsafe<
        { metadata: string }[]
      >("SELECT metadata FROM sessions WHERE id = $1", sid);
      const metaAfter = JSON.parse(after[0].metadata);
      assert.equal(
        metaAfter.userMessages,
        12,
        "metadata reflects current parse"
      );
      assert.equal(
        metaAfter.plans.length,
        2,
        "plans updated from current parse"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 16: Rebuild bumps updated_at so sync picks up new revision
  // ═══════════════════════════════════════════════════════════════════════════

  test("16: Rebuild bumps updated_at so revision-gated cloud replace triggers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t16-"));
    const db = await openTestDb(dir);
    try {
      const sid = "sync-gate";
      await db.importer.importSession(
        makeSession({ sessionId: sid }),
        "claude"
      );

      const before = await db.prisma.client.$queryRawUnsafe<
        { updated_at: string }[]
      >("SELECT updated_at FROM sessions WHERE id = $1", sid);
      const originalUpdatedAt = before[0].updated_at;

      // Downgrade revision to make it stale
      await db.run(
        "UPDATE sessions SET data_revision = 0, status = 'completed' WHERE id = $1",
        sid
      );

      await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: [`/fake/${sid}.jsonl`],
            sessionIdForSource: () => sid,
            parse: () => Promise.resolve([makeSession({ sessionId: sid })]),
          }),
        ],
        db,
      });

      const after = await db.prisma.client.$queryRawUnsafe<
        { updated_at: string }[]
      >("SELECT updated_at FROM sessions WHERE id = $1", sid);
      assert.notEqual(
        after[0].updated_at,
        originalUpdatedAt,
        "updated_at bumped — rebuilt session enters sync queue for cloud replace"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 17: Non-terminal status skip — running sessions are skipped like active
  // ═══════════════════════════════════════════════════════════════════════════

  test("17: Non-terminal status skip — running sessions are skipped, not just active", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t17-"));
    const db = await openTestDb(dir);
    try {
      const sid = "running-skip";
      await db.importer.importSession(
        makeSession({ sessionId: sid }),
        "claude"
      );

      // Set to running with stale revision
      await db.run(
        "UPDATE sessions SET data_revision = 0, status = 'running' WHERE id = $1",
        sid
      );

      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: [`/fake/${sid}.jsonl`],
            sessionIdForSource: () => sid,
            parse: () => Promise.resolve([makeSession({ sessionId: sid })]),
          }),
        ],
        db,
      });

      assert.equal(summary.skippedActive, 1, "running session skipped");
      assert.equal(summary.rebuilt, 0, "nothing rebuilt");

      // Verify revision unchanged
      const row = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >("SELECT data_revision FROM sessions WHERE id = $1", sid);
      assert.equal(row[0].data_revision, 0, "revision not stamped");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function seedClaudeCodeOtelSideRows(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<void> {
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.CostEvent} (id, session_id, model, cost_usd, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.25, '2026-06-07T10:00:40.000Z', $3, '2026-06-07T10:00:40.000Z', '2026-06-07T10:00:40.000Z')`,
    `${sessionId}-otel-cost`,
    sessionId,
    DATA_REVISION
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PermissionEvent} (id, session_id, tool_name, decision, source, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'Bash', $3, $4, '2026-06-07T10:00:41.000Z', $5, '2026-06-07T10:00:41.000Z', '2026-06-07T10:00:41.000Z')`,
    `${sessionId}-otel-permission`,
    sessionId,
    ClaudeCodePermissionDecision.Allow,
    ClaudeCodePermissionSource.Hook,
    DATA_REVISION
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ApiRequest} (id, session_id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, cost_usd, started_at, duration_ms, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 100, 50, 10, 5, 1.75, '2026-06-07T10:00:42.000Z', 2500, $3, '2026-06-07T10:00:42.000Z', '2026-06-07T10:00:42.000Z')`,
    `${sessionId}-otel-api-request`,
    sessionId,
    DATA_REVISION
  );
}
