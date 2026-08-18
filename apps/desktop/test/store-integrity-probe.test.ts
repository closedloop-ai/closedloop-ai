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
import { z } from "zod";
import {
  classifyQuickCheckRow,
  createStoreIntegrityProbe,
  defineStoreIntegrityOptionalCheck,
  extractExpectedIndexNames,
  type StoreIntegrityReader,
} from "../src/main/database/database-integrity/store-integrity-probe.js";
import { runStoreIntegrityCheck } from "../src/main/database/database-integrity/store-integrity-reads.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type ForeignKeyIntegrityReader,
  foreignKeyIntegrityCheck,
} from "../src/main/database/foreign-key-integrity.js";
import {
  type InvocationTelemetryIntegrityCounts,
  type InvocationTelemetryReader,
  invocationTelemetryCheck,
} from "../src/main/database/invocation-telemetry-integrity.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { closedloopExpectedIndexNames } from "../src/main/database/store-index-policy.js";
import {
  type TokenParityReader,
  type TokenParityResult,
  tokenParityCheck,
} from "../src/main/database/token-parity.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
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

/** Adapts a real DesktopPrisma to the probe's reader by CALLING the production
 *  read (`database-integrity/store-integrity-reads.ts`) — the same function
 *  `sqlite.ts` exposes as the clone-safe db-host method. Reimplementing its two
 *  `$queryRawUnsafe` calls here would let the extracted production path drift
 *  (a changed PRAGMA, a changed `sqlite_master` filter) while this suite stayed
 *  green, so the only thing the test owns is the `maxErrors` hand-off. */
function realReader(prisma: DesktopPrisma): StoreIntegrityReader {
  return {
    runStoreIntegrityCheck: (maxErrors) =>
      runStoreIntegrityCheck(prisma, maxErrors),
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
      { emit: noopEmit, now: () => 1000 }
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
      maxReportedIssues: 5,
    });
    const result = await probe.runOnce();
    assert.equal(result.issueCount, 50);
    assert.equal(result.issues.length, 5);
    assert.equal(result.truncated, true);
  });

  test("missing index from the injected policy is an index_presence issue", async () => {
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }], indexes: [] }),
      {
        emit: noopEmit,
        expectedIndexNames: extractExpectedIndexNames([
          { sql: 'CREATE INDEX "idx_z" ON t(c);' },
        ]),
      }
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

describe("an optional check can never fail the parent run", () => {
  /** An optional check whose READ and PARSE both succeed and whose CLASSIFIER
   *  then throws — after pushing one issue, so a partial classification is
   *  covered too. */
  function explodingClassifierCheck() {
    return defineStoreIntegrityOptionalCheck({
      name: "token_parity",
      label: "exploding classifier",
      read: () => Promise.resolve({ ok: true }),
      schema: z.object({ ok: z.boolean() }),
      classify: (_value, issues) => {
        issues.push({
          check: "token_parity",
          category: "token_store_divergence",
          object: "input_tokens",
          objectType: "unknown",
        });
        throw new Error("classifier boom");
      },
    });
  }

  test("a throwing classifier keeps the diagnostics that already completed", async () => {
    const logs: string[] = [];
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }], indexes: [] }),
      {
        emit: noopEmit,
        expectedIndexNames: ["idx_missing"],
        log: (message) => logs.push(message),
        extraChecks: [explodingClassifierCheck()],
      }
    );

    // Does not reject: classification runs under the same guard as the read.
    const diag = await probe.runOnce();

    // quick_check / index_presence completed BEFORE the extra check ran; the
    // throwing classifier must not discard either of them.
    assert.deepEqual(diag.checksRun, ["quick_check", "index_presence"]);
    assert.deepEqual(diag.issues, [
      {
        check: "index_presence",
        category: "missing_index",
        object: "idx_missing",
        objectType: "index",
      },
    ]);
    assert.equal(diag.issueCount, 1);
    // Nor may its partial issue leak into the run it failed inside.
    assert.equal(
      diag.issues.some((issue) => issue.check === "token_parity"),
      false
    );
    assert.ok(logs.some((message) => message.includes("exploding classifier")));
  });

  test("the emit path still receives diagnostics when a classifier throws", async () => {
    const emitted: StoreIntegrityDiagnostics[] = [];
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }], indexes: [] }),
      {
        emit: (diagnostics) => emitted.push(diagnostics),
        initialDelayMs: 1,
        intervalMs: 5,
        extraChecks: [explodingClassifierCheck()],
      }
    );
    probe.start();
    await delay(40);
    probe.stop();
    assert.ok(emitted.length >= 1, "expected the tick to still emit");
    assert.equal(emitted[0]?.healthy, true);
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
        expectedIndexNames: closedloopExpectedIndexNames(),
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
        expectedIndexNames: closedloopExpectedIndexNames(),
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
    const reader: StoreIntegrityReader & TokenParityReader = {
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
      extraChecks: [tokenParityCheck(reader)],
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
    const reader: StoreIntegrityReader & TokenParityReader = {
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
      extraChecks: [tokenParityCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, true);
    assert.ok(diag.checksRun.includes("token_parity"));
    const parityIssues = diag.issues.filter((i) => i.check === "token_parity");
    assert.equal(parityIssues.length, 0);
  });

  test("skips parity check when reader does not provide the method", async () => {
    // Declared as the parity reader too, with the optional method ABSENT —
    // that absence is what this test is about, and a reader typed without the
    // surface at all could not be handed to `tokenParityCheck` in the first
    // place, which is not the skip path production takes.
    const reader: StoreIntegrityReader & TokenParityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [tokenParityCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, true);
    assert.ok(!diag.checksRun.includes("token_parity"));
  });

  test("ISS-5342: reports an impossible total instead of swallowing it", async () => {
    // Neither token table carries a nonnegative CHECK on its BIGINT columns, so
    // a negative total is what the REAL query returns against a corrupt store —
    // not only what a version-skewed host could fabricate. Rejecting it at the
    // wire schema routed genuine corruption through `runOptionalCheck`'s
    // transport-failure catch, which returns before `checksRun`/`issues` are
    // appended, so the run reported `healthy: true` and the monitored
    // `storeIntegrityResult` event published nothing.
    const reader: StoreIntegrityReader & TokenParityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runTokenParityCheck: () =>
        Promise.resolve({
          usageInput: -1,
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
      extraChecks: [tokenParityCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, false);
    assert.ok(diag.checksRun.includes("token_parity"));
    const parityIssues = diag.issues.filter((i) => i.check === "token_parity");
    assert.deepEqual(parityIssues, [
      {
        check: "token_parity",
        category: "token_total_out_of_range",
        object: "usage_input_tokens",
        objectType: "unknown",
      },
    ]);
    // `usageInput` also disagrees with `eventsInput`, but that comparison is
    // meaningless against a corrupt operand — a divergence issue here would
    // point at the wrong root cause and double-count one fault.
    assert.equal(
      parityIssues.some((i) => i.category === "token_store_divergence"),
      false
    );
  });

  test("ISS-5342: bounds the issue count at one per side per column", async () => {
    // The totals are aggregates, so nothing here can scale with row count — but
    // pin the ceiling anyway: four columns × two stores, plus the pair tally.
    const reader: StoreIntegrityReader & TokenParityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runTokenParityCheck: () =>
        Promise.resolve({
          usageInput: -1,
          usageOutput: -2,
          usageCacheRead: -3,
          usageCacheWrite: 1.5,
          eventsInput: -4,
          eventsOutput: Number.MAX_SAFE_INTEGER + 2,
          eventsCacheRead: -6,
          eventsCacheWrite: -7,
          divergentSessionCount: -1,
        }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [tokenParityCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, false);
    const parityIssues = diag.issues.filter((i) => i.check === "token_parity");
    assert.equal(parityIssues.length, 9);
    assert.ok(
      parityIssues.every((i) => i.category === "token_total_out_of_range")
    );
    assert.ok(
      parityIssues.some((i) => i.object === "divergent_session_count"),
      "an impossible pair tally is reported, not tested for > 0"
    );
  });

  test("still omits the check when the host answers a shape it cannot parse", async () => {
    // The version-skew contract is unchanged: the op path exists on the proxy
    // whatever the host build is, so a host predating this read can resolve a
    // partial row or a string. That is not a store fact — nothing was measured —
    // so it must still degrade to "not evaluated" and never fail the run.
    // A string where a number belongs, and the pair tally missing entirely —
    // both shapes the typed contract forbids in-process but a version-skewed
    // host can put on the wire.
    const skewed: Record<string, unknown> = {
      usageInput: "1000",
      usageOutput: 500,
      usageCacheRead: 100,
      usageCacheWrite: 50,
      eventsInput: 1000,
      eventsOutput: 500,
      eventsCacheRead: 100,
      eventsCacheWrite: 50,
    };
    const reader: StoreIntegrityReader & TokenParityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runTokenParityCheck: () => Promise.resolve(skewed as TokenParityResult),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [tokenParityCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.checksRun.includes("token_parity"), false);
    assert.equal(
      diag.issues.some((i) => i.check === "token_parity"),
      false
    );
    assert.equal(diag.healthy, true);
    // The primary engine-level checks still ran and are still reported.
    assert.ok(diag.checksRun.includes("quick_check"));
    assert.ok(diag.checksRun.includes("index_presence"));
  });
});

describe("the reader is the db-host method proxy in production", () => {
  /**
   * Every other reader in this file is a plain object literal, on which
   * `Function.prototype.bind` is the real `bind`. Production passes
   * `agentDatabase` — the db-host method PROXY — whose `get` trap answers every
   * string property with another op-path proxy. `reader.runTokenParityCheck
   * .bind(reader)` therefore did not bind: it built the op path
   * `runTokenParityCheck.bind` and posted it with the proxy itself as an
   * argument, which is not structured-clone-safe. `read` was left holding a
   * Promise instead of a function ("args.read is not a function"), both optional
   * checks silently dropped out of `checksRun`, and the unawaited
   * `DbHostDataCloneError` reached `handleUnhandledRejection`, which shows the
   * crash dialog and calls `app.exit(1)`.
   *
   * So this drives the probe through the REAL proxy: the fake stops at the IPC
   * boundary, which is the exact seam the object-literal fakes above skip over.
   */
  function proxyReader(): {
    reader: StoreIntegrityReader &
      TokenParityReader &
      InvocationTelemetryReader &
      ForeignKeyIntegrityReader;
    ops: string[];
  } {
    const ops: string[] = [];
    const client = {
      invoke: (op: string) => {
        ops.push(op);
        if (op === "runStoreIntegrityCheck") {
          return Promise.resolve({
            quickRows: [{ quick_check: "ok" }],
            indexRows: [],
          });
        }
        if (op === "runTokenParityCheck") {
          return Promise.resolve({
            usageInput: 1000,
            usageOutput: 500,
            usageCacheRead: 100,
            usageCacheWrite: 50,
            eventsInput: 1000,
            eventsOutput: 500,
            eventsCacheRead: 100,
            eventsCacheWrite: 50,
            divergentSessionCount: 0,
          });
        }
        if (op === "readWalProbeHealth") {
          return Promise.resolve({
            measurable: true,
            probes: 12,
            anomalies: 0,
            lastAnomalyReason: null,
          });
        }
        if (op === "runInvocationTelemetryIntegrityCheck") {
          return Promise.resolve({
            outOfRangeTokenRows: 0,
            outOfRangeCostRows: 0,
            nonSubagentUsageRows: 0,
          });
        }
        if (op === "runForeignKeyIntegrityCheck") {
          return Promise.resolve({
            violationTotal: 0,
            violationTables: [],
            orphanEventAgentRows: 0,
          });
        }
        // Any other op is the bug: an op path this probe must never build.
        return Promise.reject(new Error(`unexpected db-host op: ${op}`));
      },
    } as unknown as DbHostClient;
    return {
      reader: createDbHostAgentDatabase(
        client
      ) as unknown as StoreIntegrityReader &
        TokenParityReader &
        InvocationTelemetryReader &
        ForeignKeyIntegrityReader,
      ops,
    };
  }

  test("runs every optional check over the proxy and records them as run", async () => {
    const { reader } = proxyReader();
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [
        tokenParityCheck(reader),
        invocationTelemetryCheck(reader),
        foreignKeyIntegrityCheck(reader),
      ],
    });

    const diag = await probe.runOnce();

    // `checksRun` is the only place "did not run" is distinguishable from "ran
    // and found nothing", and the crash made the optional checks silently
    // absent while `healthy` stayed true. Assert they actually ran.
    assert.ok(diag.checksRun.includes("token_parity"));
    assert.ok(diag.checksRun.includes("wal_frame_probe"));
    assert.ok(diag.checksRun.includes("invocation_telemetry"));
    assert.ok(diag.checksRun.includes("foreign_key_check"));
    assert.equal(diag.healthy, true);
    assert.equal(diag.issueCount, 0);
  });

  test("dispatches only real op paths — never a `.bind` detach path", async () => {
    const { reader, ops } = proxyReader();
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [
        tokenParityCheck(reader),
        invocationTelemetryCheck(reader),
        foreignKeyIntegrityCheck(reader),
      ],
    });

    await probe.runOnce();

    // Injected `extraChecks` run after the built-ins, so the schema-aware checks
    // are dispatched last. The invariant under test is the op PATHS, not their
    // order: every one is a real method name and none is a `.bind` detach path.
    assert.deepEqual(ops, [
      "runStoreIntegrityCheck",
      "readWalProbeHealth",
      "runTokenParityCheck",
      "runInvocationTelemetryIntegrityCheck",
      "runForeignKeyIntegrityCheck",
    ]);
    assert.ok(!ops.some((op) => op.endsWith(".bind")));
  });
});

/**
 * ISS-4976 (@wongk T7 / @closedloop-ai-stage T3): the row→wire projection OMITS
 * an impossible telemetry value so the cloud `.strict()` boundary cannot reject
 * (and dead-letter) the whole generation over it. Omission is right for the
 * hash, but it makes the resulting cloud NULL indistinguishable from "capture
 * never computed it" — this check is the missing half that says a collector
 * actually WROTE an impossible value.
 *
 * It names one of our tables, so (like token parity) it rides the probe as an
 * INJECTED `extraChecks` entry rather than living in `database-integrity/`.
 */
describe("ISS-4976: invocation telemetry integrity check", () => {
  function readerWith(
    counts: unknown
  ): StoreIntegrityReader & InvocationTelemetryReader {
    return {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
      runInvocationTelemetryIntegrityCheck: () =>
        Promise.resolve(counts as InvocationTelemetryIntegrityCounts),
    };
  }

  test("reports a collector-written impossible telemetry value", async () => {
    const reader = readerWith({
      outOfRangeTokenRows: 3,
      outOfRangeCostRows: 1,
      nonSubagentUsageRows: 2,
    });
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [invocationTelemetryCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, false);
    assert.ok(diag.checksRun.includes("invocation_telemetry"));
    const issues = diag.issues.filter(
      (i) => i.check === "invocation_telemetry"
    );
    assert.equal(issues.length, 3);
    assert.ok(
      issues.every((i) => i.category === "invocation_telemetry_out_of_range")
    );
    assert.deepEqual(issues.map((i) => i.object).sort(), [
      "component_kind",
      "estimated_cost",
      "token_counts",
    ]);
  });

  test("stays silent when every stored telemetry value is possible", async () => {
    const reader = readerWith({
      outOfRangeTokenRows: 0,
      outOfRangeCostRows: 0,
      nonSubagentUsageRows: 0,
    });
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [invocationTelemetryCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.healthy, true);
    assert.ok(diag.checksRun.includes("invocation_telemetry"));
  });

  test("omits the check on a version-skewed host that cannot serve it", async () => {
    const reader: StoreIntegrityReader & InvocationTelemetryReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [invocationTelemetryCheck(reader)],
    });
    const diag = await probe.runOnce();

    // Not evaluated is NOT the same as clean: the check is left out of
    // `checksRun` rather than reported as having passed.
    assert.equal(diag.checksRun.includes("invocation_telemetry"), false);
    assert.equal(diag.healthy, true);
  });

  test("omits the check when a version-skewed host answers with a shape this build cannot read", async () => {
    // The op path exists on the proxy whatever the host build is, so an older
    // host can resolve a partial/unknown shape rather than simply omitting the
    // method. That must degrade to "not evaluated", never to a fabricated tally.
    const reader = readerWith({ outOfRangeTokenRows: 3 });
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      extraChecks: [invocationTelemetryCheck(reader)],
    });
    const diag = await probe.runOnce();

    assert.equal(diag.checksRun.includes("invocation_telemetry"), false);
    assert.equal(
      diag.issues.some((i) => i.check === "invocation_telemetry"),
      false
    );
    assert.equal(diag.healthy, true);
  });
});
