/**
 * @file store-integrity-probe.test.ts
 * @description FEA-1999 — tests for the SQLite store integrity-health probe.
 * Covers the pure manifest parser and quick_check classifier, the redaction
 * guarantee (never row content), the real reader-pool integration (healthy +
 * missing-index, off the write queue), bounding/truncation, and the poller
 * lifecycle (boot-import skip, concurrency guard, start/stop).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MIGRATIONS } from "../src/main/database/migrations-manifest.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  classifyQuickCheckRow,
  createStoreIntegrityProbe,
  extractExpectedIndexNames,
  type StoreIntegrityReader,
} from "../src/main/database/store-integrity-probe.js";
import {
  STORE_INTEGRITY_INDEX_SQL,
  storeIntegrityQuickCheckSql,
} from "../src/main/database/store-integrity-sql.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry-protocol.js";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

/** A scripted reader: returns staged quick_check/index rows directly so the
 *  corrupt/cap paths can inject output without a physically corrupt database. */
function scriptedReader(script: {
  quickCheck?: unknown[];
  indexes?: { name: string }[];
}): StoreIntegrityReader {
  return {
    runStoreIntegrityCheck: () =>
      Promise.resolve({
        quickRows: (script.quickCheck ?? []) as Record<string, unknown>[],
        indexRows: script.indexes ?? [],
      }),
  };
}

/** Adapts a real DesktopPrisma to the probe's reader, mirroring the production
 *  `runStoreIntegrityCheck` method so the integration tests exercise real reads. */
function realReader(prisma: DesktopPrisma): StoreIntegrityReader {
  return {
    runStoreIntegrityCheck: (maxErrors) =>
      prisma.read(async (client) => ({
        quickRows: await client.$queryRawUnsafe<Record<string, unknown>[]>(
          storeIntegrityQuickCheckSql(maxErrors)
        ),
        indexRows: await client.$queryRawUnsafe<{ name: string }[]>(
          STORE_INTEGRITY_INDEX_SQL
        ),
      })),
  };
}

const noopEmit = (_: StoreIntegrityDiagnostics): void => {};

describe("extractExpectedIndexNames", () => {
  test("parses CREATE / UNIQUE / IF NOT EXISTS / quoted names and honours DROP", () => {
    const names = extractExpectedIndexNames([
      {
        sql: 'CREATE INDEX IF NOT EXISTS "idx_a" ON "t"("c");\nCREATE UNIQUE INDEX "idx_b" ON "t"("d");',
      },
      { sql: 'CREATE INDEX idx_c ON t(e);\nDROP INDEX IF EXISTS "idx_a";' },
    ]);
    assert.deepEqual([...names].sort(), ["idx_b", "idx_c"]);
  });

  test("DROP TABLE removes every index declared on that table", () => {
    const names = extractExpectedIndexNames([
      {
        sql: 'CREATE INDEX "idx_p_a" ON "p"("a");\nCREATE INDEX "idx_p_b" ON "p"("b");\nCREATE INDEX "idx_q_a" ON "q"("a");',
      },
      { sql: 'DROP TABLE IF EXISTS "p";' },
    ]);
    assert.deepEqual([...names].sort(), ["idx_q_a"]);
  });

  test("drop-then-recreate of the same index within one migration keeps it", () => {
    // Prisma emits an index-definition change as one migration with both
    // statements; textual order must win (recreate is the net effect).
    const names = extractExpectedIndexNames([
      {
        sql: 'DROP INDEX IF EXISTS "idx_x";\nCREATE INDEX "idx_x" ON "t"("c", "d");',
      },
    ]);
    assert.deepEqual([...names], ["idx_x"]);
  });

  test("recreate-after-drop-table within one migration keeps the index", () => {
    const names = extractExpectedIndexNames([
      {
        sql: 'CREATE INDEX "idx_old" ON "t"("a");\nDROP TABLE "t";\nCREATE TABLE "t" ("a");\nCREATE INDEX "idx_old" ON "t"("a");',
      },
    ]);
    assert.deepEqual([...names], ["idx_old"]);
  });

  test("a DDL keyword inside a -- comment is ignored", () => {
    const names = extractExpectedIndexNames([
      {
        sql: 'CREATE INDEX "idx_real" ON "t"("a");\n-- DROP TABLE t; previously used CREATE INDEX idx_ghost ON t(b)\n',
      },
    ]);
    assert.deepEqual([...names], ["idx_real"]);
  });

  test("real migration manifest yields a non-empty, known index set", () => {
    const names = new Set(extractExpectedIndexNames(MIGRATIONS));
    assert.ok(names.size > 0, "expected at least one declared index");
    // A representative index that has existed since the genesis migration.
    assert.ok(
      names.has("idx_events_session_id"),
      "expected idx_events_session_id in the manifest-derived set"
    );
  });
});

describe("classifyQuickCheckRow (redaction)", () => {
  test('"ok" and empty rows are healthy (null)', () => {
    assert.equal(classifyQuickCheckRow("ok"), null);
    assert.equal(classifyQuickCheckRow("  ok  "), null);
    assert.equal(classifyQuickCheckRow(""), null);
    assert.equal(classifyQuickCheckRow(123), null);
  });

  test("missing-index-entry message yields the index name only — no rowid", () => {
    const issue = classifyQuickCheckRow(
      "row 999 missing from index idx_events_session_id"
    );
    assert.deepEqual(issue, {
      check: "quick_check",
      category: "missing_index_entry",
      object: "idx_events_session_id",
      objectType: "index",
    });
    // The rowid and the raw message text must never survive into the issue
    // (the `missing_index_entry` category legitimately contains "missing").
    assert.equal(JSON.stringify(issue).includes("999"), false);
    assert.equal(JSON.stringify(issue).includes("missing from"), false);
  });

  test("NULL-value constraint message yields the table, drops the column", () => {
    const issue = classifyQuickCheckRow("NULL value in sessions.user_id");
    assert.deepEqual(issue, {
      check: "quick_check",
      category: "constraint",
      object: "sessions",
      objectType: "table",
    });
    assert.equal(JSON.stringify(issue).includes("user_id"), false);
  });

  test("structural corruption is malformed_structure with NO object", () => {
    const issue = classifyQuickCheckRow(
      "*** in database main *** Page 42: btreeInitPage() returns error code 11"
    );
    assert.deepEqual(issue, {
      check: "quick_check",
      category: "malformed_structure",
    });
    assert.equal(JSON.stringify(issue).includes("42"), false);
  });

  test("unrecognised message degrades to other with NO object", () => {
    const issue = classifyQuickCheckRow("some brand new check failure text");
    assert.deepEqual(issue, { check: "quick_check", category: "other" });
  });
});

describe("runOnce — scripted reader", () => {
  test("corrupt store: parses issues, never carries row content", async () => {
    const probe = createStoreIntegrityProbe(
      scriptedReader({
        quickCheck: [
          { quick_check: "row 999 missing from index idx_events_session_id" },
          { quick_check: "NULL value in sessions.user_id" },
        ],
      }),
      { emit: noopEmit, migrations: [], now: () => 1000 }
    );
    const result = await probe.runOnce();
    assert.equal(result.healthy, false);
    assert.equal(result.issueCount, 2);
    assert.deepEqual(result.checksRun, ["quick_check", "index_presence"]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("999"), false);
    assert.equal(serialized.includes("user_id"), false);
    assert.equal(serialized.includes("missing from"), false);
  });

  test("issues are capped with a truncated flag; issueCount is the full total", async () => {
    const quickCheck = Array.from({ length: 50 }, (_, i) => ({
      quick_check: `wrong # of entries in index idx_${i}`,
    }));
    const probe = createStoreIntegrityProbe(scriptedReader({ quickCheck }), {
      emit: noopEmit,
      migrations: [],
      maxReportedIssues: 5,
    });
    const result = await probe.runOnce();
    assert.equal(result.issueCount, 50);
    assert.equal(result.issues.length, 5);
    assert.equal(result.truncated, true);
  });

  test("missing manifest index is reported as an index_presence issue", async () => {
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }], indexes: [] }),
      { emit: noopEmit, migrations: [{ sql: 'CREATE INDEX "idx_z" ON t(c);' }] }
    );
    const result = await probe.runOnce();
    assert.equal(result.healthy, false);
    assert.deepEqual(result.issues, [
      {
        check: "index_presence",
        category: "missing_index",
        object: "idx_z",
        objectType: "index",
      },
    ]);
  });
});

describe("runOnce — real reader pool (integration)", () => {
  test("a freshly-migrated store is healthy and does not touch the write queue", async () => {
    const queue = makeRecordingQueue();
    const { prisma, close } = await openTestPrisma(queue);
    try {
      const runsBefore = queue.runs;
      const probe = createStoreIntegrityProbe(realReader(prisma), {
        emit: noopEmit,
      });
      const result = await probe.runOnce();
      assert.equal(result.healthy, true);
      assert.equal(result.issueCount, 0);
      assert.deepEqual(result.issues, []);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.checksRun, ["quick_check", "index_presence"]);
      assert.ok(result.durationMs >= 0);
      // AC2: the probe reads on the reader pool, never the write queue.
      assert.equal(queue.runs, runsBefore);
    } finally {
      await close();
    }
  });

  test("a dropped manifest index is detected against the live store", async () => {
    const { db, prisma, close } = await openTestPrisma();
    try {
      await db.exec('DROP INDEX "idx_events_session_id";');
      const probe = createStoreIntegrityProbe(realReader(prisma), {
        emit: noopEmit,
      });
      const result = await probe.runOnce();
      assert.equal(result.healthy, false);
      const missing = result.issues.filter(
        (issue) => issue.check === "index_presence"
      );
      assert.ok(
        missing.some((issue) => issue.object === "idx_events_session_id"),
        "expected idx_events_session_id to be reported missing"
      );
    } finally {
      await close();
    }
  });
});

describe("poller lifecycle", () => {
  test("skips the tick while a boot import is in progress", async () => {
    const emitted: StoreIntegrityDiagnostics[] = [];
    const logs: string[] = [];
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }] }),
      {
        emit: (d) => emitted.push(d),
        migrations: [],
        initialDelayMs: 1,
        intervalMs: 5,
        isBootImportInProgress: () => true,
        log: (m) => logs.push(m),
      }
    );
    probe.start();
    await delay(30);
    probe.stop();
    assert.equal(emitted.length, 0);
    assert.ok(logs.some((m) => m.includes("boot import in progress")));
  });

  test("start() emits, and stop() halts further ticks", async () => {
    const emitted: StoreIntegrityDiagnostics[] = [];
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }] }),
      {
        emit: (d) => emitted.push(d),
        migrations: [],
        initialDelayMs: 1,
        intervalMs: 5,
      }
    );
    probe.start();
    await delay(40);
    probe.stop();
    const countAtStop = emitted.length;
    assert.ok(countAtStop >= 1, "expected at least one emission");
    await delay(30);
    assert.equal(emitted.length, countAtStop, "no emissions after stop()");
  });

  test("concurrency guard: ticks never overlap when a check is slow", async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const slowReader: StoreIntegrityReader = {
      runStoreIntegrityCheck: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active -= 1;
        completed += 1;
        return { quickRows: [], indexRows: [] };
      },
    };
    const probe = createStoreIntegrityProbe(slowReader, {
      emit: noopEmit,
      migrations: [],
      initialDelayMs: 1,
      intervalMs: 5,
    });
    probe.start();
    await delay(80);
    probe.stop();
    await delay(60);
    assert.equal(maxActive, 1, "no two checks ran concurrently");
    assert.ok(completed >= 1);
  });
});

describe("FEA-2345: token parity check", () => {
  test("reports token_store_divergence when stores disagree", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runTokenParityCheck: () =>
        Promise.resolve({
          usageInput: 1000,
          usageOutput: 500,
          usageCacheRead: 100,
          usageCacheWrite: 50,
          eventsInput: 1200,
          eventsOutput: 500,
          eventsCacheRead: 100,
          eventsCacheWrite: 50,
          divergentSessionCount: 1,
        }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      migrations: [],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, false);
    assert.ok(diag.checksRun.includes("token_parity"));
    const parityIssues = diag.issues.filter((i) => i.check === "token_parity");
    assert.ok(parityIssues.length >= 2);
    assert.ok(
      parityIssues.some(
        (i) =>
          i.category === "token_store_divergence" && i.object === "input_tokens"
      )
    );
    assert.ok(
      parityIssues.some(
        (i) =>
          i.category === "token_store_divergence" && i.object === "token_events"
      )
    );
  });

  test("stays silent when stores agree", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runTokenParityCheck: () =>
        Promise.resolve({
          usageInput: 1000,
          usageOutput: 500,
          usageCacheRead: 100,
          usageCacheWrite: 50,
          eventsInput: 1000,
          eventsOutput: 500,
          eventsCacheRead: 100,
          eventsCacheWrite: 50,
          divergentSessionCount: 0,
        }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      migrations: [],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, true);
    assert.ok(diag.checksRun.includes("token_parity"));
    const parityIssues = diag.issues.filter((i) => i.check === "token_parity");
    assert.equal(parityIssues.length, 0);
  });

  test("skips parity check when reader does not provide the method", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      migrations: [],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, true);
    assert.ok(!diag.checksRun.includes("token_parity"));
  });
});
