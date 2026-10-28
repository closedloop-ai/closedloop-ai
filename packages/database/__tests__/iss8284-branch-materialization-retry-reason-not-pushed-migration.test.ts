import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME =
  "20260917153000_iss8284_branch_materialization_retry_reason_not_pushed";
const BASELINE_MIGRATION_NAME =
  "20260825170000_iss8001_branch_materialization_retry";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONSTRAINT = "branch_materialization_retries_reason_check";
const ADDED_REASON = "not_pushed";
// Deliberately `[^']*` rather than `[a-z_]+`: a value carrying a digit,
// uppercase char, or hyphen must still be COUNTED, or the length guard below
// would pass while the constraint accepted an undeclared reason.
const REASON_LITERAL_REGEX = /'([^']*)'/g;

/*
 * ISS-8284. These cases read the migration FILE, so everything they prove is
 * equally true of a file that was never applied — and Prisma's differ ignores
 * CHECK constraints entirely, so a missing one produces no drift to catch it
 * either. The runtime vocabulary this widening aligns with
 * (`BranchMaterializationRetryTerminalReason`) lives in `apps/api`, which this
 * package cannot import, so the literal is spelled out here.
 */
describe(`${MIGRATION_NAME} migration contract`, () => {
  it("adds not_pushed without dropping a reason the baseline accepted", async () => {
    const [sql, baselineSql] = await Promise.all([
      migrationSql(),
      readFile(migrationPath(BASELINE_MIGRATION_NAME), "utf8"),
    ]);
    const baselineReasons = reasonLiterals(baselineSql);
    const widenedReasons = reasonLiterals(sql);

    // Widening only: every reason the baseline CHECK accepted must survive, or
    // a stored row would start violating its own column constraint.
    for (const reason of baselineReasons) {
      expect(widenedReasons).toContain(reason);
    }
    expect(widenedReasons).toContain(ADDED_REASON);
    expect(widenedReasons).toHaveLength(baselineReasons.length + 1);
  });

  it("constrains the reason column of the retries table, not some other target", async () => {
    const statement = reasonConstraintStatement(await migrationSql());

    // Without these the literal set above could be asserted against a
    // constraint retargeted to another table, or one whose predicate was
    // inverted to reject exactly the vocabulary it is meant to accept.
    expect(statement).toContain('ALTER TABLE "branch_materialization_retries"');
    expect(statement).toContain('"reason" IS NULL OR "reason" IN (');
    expect(statement).not.toContain("NOT IN (");
  });

  it("swaps the constraint atomically under a bounded lock wait", async () => {
    const sql = await migrationSql();
    const beginIndex = sql.indexOf("BEGIN;");
    const setLocalIndex = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const dropIndex = sql.indexOf(`DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
    const addIndex = sql.indexOf(`ADD CONSTRAINT "${CONSTRAINT}"`);
    const commitIndex = sql.indexOf("COMMIT;");

    // `prisma migrate deploy` does not wrap a migration file in a transaction,
    // so without the explicit BEGIN/COMMIT the DROP would autocommit and leave
    // a window — and, if the ADD then failed, a permanent state — in which the
    // reason column accepts anything at all.
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(addIndex);
    expect(dropIndex).toBeGreaterThan(beginIndex);
    // The DROP must precede the ADD. Swapped, this file adds the widened
    // constraint and then drops it, while every other assertion here stays green.
    expect(addIndex).toBeGreaterThan(dropIndex);
    // Ordering, not mere presence: `SET LOCAL` is a no-op OUTSIDE a transaction
    // block, so hoisting this line above BEGIN would silently drop the lock
    // bound and leave the swap free to queue forever behind a live drain claim.
    expect(setLocalIndex).toBeGreaterThan(beginIndex);
    expect(setLocalIndex).toBeLessThan(dropIndex);
  });
});

function migrationPath(name: string): string {
  return path.join(
    TEST_DIR,
    "..",
    "prisma",
    "migrations",
    name,
    "migration.sql"
  );
}

function migrationSql(): Promise<string> {
  return readFile(migrationPath(MIGRATION_NAME), "utf8");
}

/**
 * The full `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statement, so an
 * assertion can reach the target table and the predicate operator rather than
 * only the quoted values inside it.
 */
function reasonConstraintStatement(sql: string): string {
  const markerIndex = sql.indexOf(`ADD CONSTRAINT "${CONSTRAINT}"`);
  if (markerIndex < 0) {
    throw new Error(`Missing ${CONSTRAINT} constraint`);
  }
  const statementStart = sql.lastIndexOf("ALTER TABLE", markerIndex);
  const statementEnd = sql.indexOf(";", markerIndex);
  if (statementStart < 0 || statementEnd < 0) {
    throw new Error(`Incomplete ${CONSTRAINT} constraint`);
  }
  return sql.slice(statementStart, statementEnd + 1);
}

/** The quoted reason values inside the file's `reason` CHECK predicate. */
function reasonLiterals(sql: string): string[] {
  return [...reasonConstraintStatement(sql).matchAll(REASON_LITERAL_REGEX)].map(
    ([, literal]) => literal
  );
}
