import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME =
  "20260902100000_iss7149_pr_materialization_retry_reason_vocabulary";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const BASELINE_MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  "20260818200348_iss5971_loop_pr_materialization_retry",
  "migration.sql"
);
// Deliberately `[^']*` rather than `[a-z_]+`: a value carrying a digit,
// uppercase char, or hyphen must still be COUNTED, or the length guard below
// would pass while the constraint accepted an undeclared reason.
const REASON_LITERAL_REGEX = /'([^']*)'/g;

/*
 * These cases read the migration FILE, so everything they prove is equally true
 * of a file that was never applied — and Prisma's differ ignores CHECK
 * constraints entirely, so a missing one produces no drift to catch it either.
 * The runtime halves of the evidence live elsewhere on purpose, and are named
 * here so the next reader does not conclude this file is the whole of it:
 *
 *  - Seed compatibility (packages/database/AGENTS.md requires it after every
 *    migration) is exercised by `scripts/seed/__tests__/integration/smoke.integration.test.ts`,
 *    which spawns the real `pnpm seed` and asserts exit 0. The
 *    `database-integration-tests` job runs it against an ephemeral `postgres:16`
 *    that `prisma migrate deploy` has already taken to migration head, so this
 *    constraint is in place when the seed runs. That lane is advisory
 *    (`continue-on-error`, ISS-6361) — its own check run reddens, the run
 *    conclusion does not.
 *  - That the constraint reached the server, still REFUSES a value outside the
 *    vocabulary, and did not narrow while widening is
 *    `integration/iss7149-pr-materialization-retry-reason-vocabulary.integration.test.ts`.
 *    Its refusal case is the only assertion in the repo that executes against
 *    the applied constraint, but it is NOT a merge gate: it runs from the same
 *    `vitest.config.integration.ts` include, in the same advisory
 *    `database-integration-tests` job as the seed smoke test above, so it
 *    reddens its own check run and never the run conclusion. Nothing that can
 *    block a merge observes the constraint on a server — the text-shape cases
 *    below are the whole blocking guard.
 *  - That the widened CHECK accepted every member of the TypeScript vocabulary
 *    named by `PrMaterializationRetryTerminalReason` was the round trip in
 *    `apps/api/__tests__/integration/pr-materialization-retry-realdb.test.ts`,
 *    which landed with the drain change one deploy AFTER this migration. ISS-12435
 *    later removed that vocabulary and its round trip with the Loops drain.
 */
describe(`${MIGRATION_NAME} migration contract`, () => {
  it("adds the two policy-refusal reasons without dropping an accepted one", async () => {
    const [sql, baselineSql] = await Promise.all([
      migrationSql(),
      readFile(BASELINE_MIGRATION_PATH, "utf8"),
    ]);
    const baselineReasons = reasonLiterals(baselineSql);
    const widenedReasons = reasonLiterals(sql);

    // Widening only: every reason the baseline CHECK accepted must survive, or
    // a stored row would start violating its own column constraint.
    for (const reason of baselineReasons) {
      expect(widenedReasons).toContain(reason);
    }
    expect(widenedReasons).toContain("provider_delay_out_of_policy");
    expect(widenedReasons).toContain("retry_horizon_exceeded");
    expect(widenedReasons).toHaveLength(baselineReasons.length + 2);
  });

  it("constrains the reason column of the retries table, not some other target", async () => {
    const statement = reasonConstraintStatement(await migrationSql());

    // Without these the literal set above could be asserted against a
    // constraint retargeted to another table, or one whose predicate was
    // inverted to reject exactly the vocabulary it is meant to accept.
    expect(statement).toContain('ALTER TABLE "pr_materialization_retries"');
    expect(statement).toContain('"reason" IS NULL OR "reason" IN (');
    expect(statement).not.toContain("NOT IN (");
  });

  it("swaps the constraint atomically under a bounded lock wait", async () => {
    const sql = await migrationSql();
    const beginIndex = sql.indexOf("BEGIN;");
    const setLocalIndex = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const dropIndex = sql.indexOf(
      'DROP CONSTRAINT IF EXISTS "pr_materialization_retries_reason_check"'
    );
    const addIndex = sql.indexOf(
      'ADD CONSTRAINT "pr_materialization_retries_reason_check"'
    );
    const commitIndex = sql.indexOf("COMMIT;");

    // `prisma migrate deploy` does not wrap a migration file in a transaction,
    // so without the explicit BEGIN/COMMIT the DROP would autocommit and leave
    // a window — and, if the ADD then failed, a permanent state — in which the
    // reason column accepts anything at all.
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(addIndex);
    expect(dropIndex).toBeGreaterThan(beginIndex);
    // The DROP must precede the ADD. Swapped, this file adds the widened
    // constraint and then drops it — the permanently unconstrained column the
    // paragraph above says this case guards — while every other assertion
    // here, and both cases above (which only read the ADD statement's
    // contents), stay green.
    expect(addIndex).toBeGreaterThan(dropIndex);
    // Ordering, not mere presence: `SET LOCAL` is a no-op OUTSIDE a transaction
    // block, so hoisting this line above BEGIN would silently drop the lock
    // bound and leave the swap free to queue forever behind a live drain claim
    // — with every other assertion here still green.
    expect(setLocalIndex).toBeGreaterThan(beginIndex);
    expect(setLocalIndex).toBeLessThan(dropIndex);
    expect(sql).not.toContain("RESET lock_timeout;");
    // Re-runnable: a prior attempt that already replaced the constraint must
    // not raise 42704 on the retry.
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "pr_materialization_retries_reason_check"'
    );
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}

/**
 * The full `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statement, so an
 * assertion can reach the target table and the predicate operator rather than
 * only the quoted values inside it.
 */
function reasonConstraintStatement(sql: string): string {
  const markerIndex = sql.indexOf(
    'ADD CONSTRAINT "pr_materialization_retries_reason_check"'
  );
  if (markerIndex < 0) {
    throw new Error("Missing pr_materialization_retries reason constraint");
  }
  const statementStart = sql.lastIndexOf("ALTER TABLE", markerIndex);
  const statementEnd = sql.indexOf(";", markerIndex);
  if (statementStart < 0 || statementEnd < 0) {
    throw new Error("Incomplete pr_materialization_retries reason constraint");
  }
  return sql.slice(statementStart, statementEnd + 1);
}

/** The quoted reason values inside the file's `reason` CHECK predicate. */
function reasonLiterals(sql: string): string[] {
  return [...reasonConstraintStatement(sql).matchAll(REASON_LITERAL_REGEX)].map(
    ([, literal]) => literal
  );
}
