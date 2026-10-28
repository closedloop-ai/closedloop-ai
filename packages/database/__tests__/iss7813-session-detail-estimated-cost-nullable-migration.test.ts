import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ISS-7813: this migration WIDENS `session_detail.estimated_cost` and does
 * nothing else. The `DEFAULT 0` staying is the safety property, and it was
 * previously protected by a comment alone.
 *
 * Dropping the default here would be a silent production defect rather than a
 * failing test: `resolveTokenRollupColumns`
 * (`apps/api/app/agent-sessions/service/field-regression-guards.ts`) returns `{}`
 * for a payload with no per-model token rows, so the create arm of
 * `sessionDetail.upsert` OMITS the column and leans on the schema default. Take
 * the default away and that documented omission starts writing NULL on every new
 * session with no token rows — from a path nobody changed, needing no new Desktop
 * build — and a code-only rollback stops being safe, because the pre-ISS-7813
 * bundle's `branch-cost-evidence.ts` has its own local `numberFromDecimal` with no
 * null branch and throws on `null.toString()`.
 *
 * Nothing in `apps/api` catches that: every persist test mocks the Prisma client
 * in-process and never reaches Postgres.
 *
 * SCOPE, stated so this file is not trusted further than it goes. It pins THIS
 * migration against a later edit. It cannot stop a FUTURE migration from adding
 * its own `DROP DEFAULT` — that is deliberate work, and it belongs with teaching
 * the create arm to write NULL on purpose rather than by omission.
 *
 * That work is DONE: ISS-8515 taught both production create arms to name the
 * column explicitly and then dropped the default in
 * `20260903000000_iss8515_session_detail_estimated_cost_drop_default`, whose own
 * test pins it. The precondition this docstring described is met, so the sentence
 * above is history rather than a pending caveat. What has NOT changed is this
 * file's assertion: THIS migration must still never drop the default.
 */
const MIGRATION_NAME =
  "20260823120000_iss7813_session_detail_estimated_cost_nullable";
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
const DROP_DEFAULT_RE = /DROP\s+DEFAULT/i;

describe("ISS-7813 session_detail.estimated_cost nullable migration", () => {
  it("drops NOT NULL on the stored cost, and only that", async () => {
    const statements = await readStatements();

    expect(statements).toEqual([
      'ALTER TABLE "session_detail" ALTER COLUMN "estimated_cost" DROP NOT NULL',
    ]);
  });

  it("keeps the DEFAULT, never re-tightens the column, and rewrites no row", async () => {
    const sql = await readMigrationSql();

    // The load-bearing one: see the file docstring for what a DROP DEFAULT here
    // would set off.
    expect(sql).not.toMatch(DROP_DEFAULT_RE);
    expect(sql).not.toContain("SET NOT NULL");
    expect(sql).not.toMatch(ROW_MUTATION_RE);
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
