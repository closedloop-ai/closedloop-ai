/**
 * @file db-host-query-perf.test.ts
 * @description ISS-6339 — the query-duration accumulator's counting contract.
 *
 * Three behaviors, each of which would break silently:
 *  - a slow statement must move the histogram AND the slow counter, which is the
 *    ticket's own acceptance criterion;
 *  - the label must be the statement FAMILY and nothing else, because a label
 *    derived from the SQL text is a cost incident on the metrics backend and
 *    carries bound values off the machine; and
 *  - an idle window must be distinguishable from a broken accumulator.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createQueryPerfRecorder,
  QUERY_DURATION_BUCKET_BOUNDS_MS,
  sqlStatementFamily,
} from "../src/main/database/db-host/db-host-query-perf.js";
import { SqlStatementFamily } from "../src/main/telemetry/telemetry-protocol.js";

const OVERFLOW_BUCKET = QUERY_DURATION_BUCKET_BOUNDS_MS.length;

describe("query-duration accumulator (ISS-6339)", () => {
  test("a slow statement moves the histogram and the slow counter", () => {
    const recorder = createQueryPerfRecorder({ slowQueryThresholdMs: 100 });
    recorder.record("SELECT 1", 0.4);
    recorder.record("SELECT 1", 0.4);
    recorder.record(
      'SELECT COUNT(*) FROM "events" WHERE "session_id" = ?1',
      4200
    );

    const sample = recorder.drain();
    assert.ok(sample);
    const [select] = sample.families;
    assert.equal(select.family, SqlStatementFamily.Select);
    assert.equal(select.count, 3);
    // The slow one, and only the slow one.
    assert.equal(select.slowCount, 1);
    assert.equal(select.maxDurationMs, 4200);
    // Two sub-millisecond reads in the first bucket, the 4.2s read in overflow —
    // and nothing in between, so a fixture cannot satisfy this by smearing.
    assert.equal(select.buckets[0], 2);
    assert.equal(select.buckets[OVERFLOW_BUCKET], 1);
    assert.equal(
      select.buckets.reduce((sum, count) => sum + count, 0),
      3
    );
  });

  test("a statement at the threshold counts as slow, one below it does not", () => {
    const recorder = createQueryPerfRecorder({ slowQueryThresholdMs: 100 });
    recorder.record("SELECT 1", 100);
    recorder.record("SELECT 1", 99.9);
    const sample = recorder.drain();
    assert.equal(sample?.families[0].slowCount, 1);
    assert.equal(sample?.slowQueryThresholdMs, 100);
  });

  test("families are separate rows, and a duration is never labelled by SQL text", () => {
    const recorder = createQueryPerfRecorder();
    recorder.record('INSERT INTO "sessions" ("id") VALUES (?1)', 3);
    recorder.record('UPDATE "sessions" SET "status" = ?1', 3);
    recorder.record('DELETE FROM "events" WHERE "id" = ?1', 3);
    recorder.record("PRAGMA wal_checkpoint(TRUNCATE)", 3);

    const sample = recorder.drain();
    assert.ok(sample);
    assert.deepEqual(
      sample.families.map((row) => row.family).sort(),
      [
        SqlStatementFamily.Delete,
        SqlStatementFamily.Insert,
        SqlStatementFamily.Pragma,
        SqlStatementFamily.Update,
      ].sort()
    );
    // The cardinality contract, asserted rather than described: the ONLY string
    // in the drained sample is a member of the closed family enum. A table name,
    // a column, or a bound value reaching a label would fail here.
    const families: readonly string[] = Object.values(SqlStatementFamily);
    for (const row of sample.families) {
      assert.ok(families.includes(row.family));
    }
    assert.ok(sample.families.length <= families.length);
  });

  test("an idle window drains to null rather than a zeroed sample", () => {
    const recorder = createQueryPerfRecorder();
    assert.equal(recorder.drain(), null);
    recorder.record("SELECT 1", 1);
    assert.ok(recorder.drain());
    // Draining consumes the window: a second drain over no new work is idle
    // again, not a repeat of the previous numbers.
    assert.equal(recorder.drain(), null);
  });

  test("a duration that cannot describe a statement is left out entirely", () => {
    const recorder = createQueryPerfRecorder();
    recorder.record("SELECT 1", Number.NaN);
    recorder.record("SELECT 1", -1);
    recorder.record("SELECT 1", Number.POSITIVE_INFINITY);
    // Not counted with a coerced value — counting them would inflate `count`
    // and corrupt `maxDurationMs` for every rate computed over the window.
    assert.equal(recorder.drain(), null);
  });
});

describe("statement-family classifier (ISS-6339)", () => {
  test("classifies each family from its leading keyword", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["SELECT 1", SqlStatementFamily.Select],
      ['  select "a" from "b"', SqlStatementFamily.Select],
      ["WITH x AS (SELECT 1) SELECT * FROM x", SqlStatementFamily.Select],
      ["INSERT INTO t VALUES (1)", SqlStatementFamily.Insert],
      ["UPDATE t SET a = 1", SqlStatementFamily.Update],
      ["DELETE FROM t", SqlStatementFamily.Delete],
      ["PRAGMA journal_mode", SqlStatementFamily.Pragma],
      ["CREATE INDEX i ON t(a)", SqlStatementFamily.Ddl],
      ["BEGIN DEFERRED", SqlStatementFamily.Transaction],
      ["COMMIT", SqlStatementFamily.Transaction],
    ];
    for (const [sql, family] of cases) {
      assert.equal(sqlStatementFamily(sql), family, sql);
    }
  });

  test("looks past comments and parentheses Prisma actually emits", () => {
    assert.equal(
      sqlStatementFamily("-- traceparent=00-abc\nSELECT 1"),
      SqlStatementFamily.Select
    );
    assert.equal(
      sqlStatementFamily("/* db=main */ SELECT 1"),
      SqlStatementFamily.Select
    );
    assert.equal(
      sqlStatementFamily("(SELECT 1) UNION (SELECT 2)"),
      SqlStatementFamily.Select
    );
  });

  test("an unmapped or empty statement is `other`, never a thrown error", () => {
    // The classifier runs inside the measurement path, so it must never become
    // the measured work's failure.
    assert.equal(sqlStatementFamily(""), SqlStatementFamily.Other);
    assert.equal(sqlStatementFamily("VACUUM"), SqlStatementFamily.Other);
    // A keyword that merely STARTS with a mapped one must not match it.
    assert.equal(sqlStatementFamily("SELECTED"), SqlStatementFamily.Other);
    assert.equal(sqlStatementFamily("DELETED_ROWS"), SqlStatementFamily.Other);
  });
});
