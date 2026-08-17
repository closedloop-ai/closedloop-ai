/**
 * @file migration-manifest-drop-uniqueness.test.ts
 * @description cr-11829 [P2]: the invariant the runner's column-name heal rests on.
 *
 * `isAlreadyAppliedStatement` tolerates `no such column: X` on an earlier
 * migration's statement when a LATER migration drops X, keyed on the bare column
 * NAME — SQLite's error does not name the table, and inferring it would mean
 * parsing the table out of arbitrary DDL and DML, where a parse MISS denies
 * tolerance and refuses boot.
 *
 * A bare name is only unambiguous while no two migrations drop the same column
 * name from different tables. That is not a property of the runner, it is a
 * property of the MANIFEST — so it is pinned here rather than assumed. If this
 * fails, the fix is either to rename the incoming column or to make the heal
 * table-scoped; do NOT relax this test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";

/** `ALTER TABLE "t" DROP COLUMN "c"` → the (table, column) pair it targets. */
const ALTER_TABLE_DROP_RE =
  /ALTER\s+TABLE\s+"?(\w+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi;
const LINE_COMMENT_RE = /--[^\n]*/g;

function droppedPairs(): {
  table: string;
  column: string;
  migration: string;
}[] {
  const pairs: { table: string; column: string; migration: string }[] = [];
  for (const migration of MIGRATIONS) {
    const sql = migration.sql.replace(LINE_COMMENT_RE, "");
    for (const match of sql.matchAll(ALTER_TABLE_DROP_RE)) {
      pairs.push({
        table: match[1],
        column: match[2],
        migration: migration.name,
      });
    }
  }
  return pairs;
}

test("no two migrations drop the same column name from different tables", () => {
  const tablesByColumn = new Map<string, Map<string, string>>();
  for (const pair of droppedPairs()) {
    const tables = tablesByColumn.get(pair.column) ?? new Map<string, string>();
    tables.set(pair.table, pair.migration);
    tablesByColumn.set(pair.column, tables);
  }
  const ambiguous = [...tablesByColumn.entries()]
    .filter(([, tables]) => tables.size > 1)
    .map(
      ([column, tables]) =>
        `${column} dropped from ${[...tables.entries()]
          .map(([table, migration]) => `${table} (${migration})`)
          .join(" and ")}`
    );
  assert.deepEqual(
    ambiguous,
    [],
    `the runner's column-name heal cannot disambiguate these: ${ambiguous.join("; ")}`
  );
});

test("the manifest actually contains DROP COLUMN statements to constrain", () => {
  // Guards the guard: a regex that silently stops matching would make the
  // invariant above vacuously true forever.
  assert.ok(
    droppedPairs().length > 0,
    "parsed zero DROP COLUMN pairs — the pattern no longer matches the manifest"
  );
});
