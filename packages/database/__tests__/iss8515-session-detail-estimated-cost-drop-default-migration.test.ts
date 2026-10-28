import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ISS-8515: this migration drops `DEFAULT 0` from `session_detail.estimated_cost`
 * and does nothing else. It is the mirror of
 * `iss7813-session-detail-estimated-cost-nullable-migration.test.ts`, which pins
 * that the EARLIER migration must NOT drop the default — that one kept it because
 * the create arm still omitted the column, so dropping it then would have written
 * NULL from a path nobody had changed.
 *
 * Two properties are pinned here, and they fail for different reasons.
 *
 * ROW SAFETY: no `UPDATE`/`DELETE`/`INSERT`/`TRUNCATE`. Existing zeros stay zero;
 * repairing them is ISS-8517. And no `SET NOT NULL` — the column has been nullable
 * since ISS-7813 and re-tightening it would break every explicit `null` write this
 * ticket adds.
 *
 * LOCK SAFETY: the `SET lock_timeout` / `RESET lock_timeout` pair must survive.
 * `DROP DEFAULT` is catalog-only but still takes ACCESS EXCLUSIVE on a large hot
 * table, so an unbounded statement can queue behind a long reader and stall every
 * write behind it. Deleting the `RESET` is the subtler regression: `prisma migrate
 * deploy` runs every pending migration over ONE connection, so a leaked
 * session-scoped 5s bound would silently follow the rest of the deploy and could
 * fail an unrelated later migration that legitimately waits longer for its lock.
 */
const MIGRATION_NAME =
  "20260903000000_iss8515_session_detail_estimated_cost_drop_default";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

const LINE_COMMENT_RE = /^\s*--.*$/gm;
const WHITESPACE_RUN_RE = /\s+/g;
/** Anything that would touch stored rows. This migration must be pure DDL. */
const ROW_MUTATION_RE = /\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i;

describe("ISS-8515 session_detail.estimated_cost DROP DEFAULT migration", () => {
  it("drops the default inside a bounded lock, and does only that", async () => {
    const statements = await readStatements();

    expect(statements).toEqual([
      "SET lock_timeout = '5s'",
      'ALTER TABLE "session_detail" ALTER COLUMN "estimated_cost" DROP DEFAULT',
      "RESET lock_timeout",
    ]);
  });

  it("never re-tightens the column and rewrites no row", async () => {
    // Checked against the STATEMENTS, not the raw file: the property is "no
    // row-mutating statement", and this migration's own comment explains why the
    // two production INSERT paths make the drop safe — a raw-text scan matches
    // that prose and fails on an explanation rather than on a defect.
    const statements = await readStatements();

    for (const statement of statements) {
      expect(statement).not.toContain("SET NOT NULL");
      expect(statement).not.toMatch(ROW_MUTATION_RE);
    }
  });

  it("hands the session back, so the 5s bound cannot leak into the rest of the deploy", async () => {
    const statements = await readStatements();

    // Asserted as the LAST statement specifically: a `RESET` that survives but is
    // reordered above the ALTER would leave the ALTER itself unbounded, which is
    // the hazard the pair exists to close.
    expect(statements.at(-1)).toBe("RESET lock_timeout");
  });
});

async function readMigrationSql(): Promise<string> {
  return await readFile(MIGRATION_PATH, "utf8");
}

async function readStatements(): Promise<string[]> {
  const sql = await readMigrationSql();
  return sql
    .replace(LINE_COMMENT_RE, "")
    .split(";")
    .map((statement) => statement.replace(WHITESPACE_RUN_RE, " ").trim())
    .filter((statement) => statement.length > 0);
}
