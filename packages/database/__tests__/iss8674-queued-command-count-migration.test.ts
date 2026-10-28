import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8674 — the counter that bounds the queue-depth sampler's database work,
 * and the seek that makes the bounded read a constant.
 *
 * WHY THIS FILE EXISTS. Nothing else in the repo fails when this DDL is wrong,
 * and the two halves fail differently silently:
 *
 * - The TRIGGER is the entire drift guarantee. The behavioral proof lives in
 *   `apps/api/__tests__/integration/queued-command-count-drift.integration.test.ts`,
 *   which needs a real Postgres and so does not run in the unit tier — this
 *   file is what fails in the unit tier when the trigger's shape is changed.
 * - The INDEX changes only PLAN CHOICE, never results, so every functional test
 *   stays green if it is dropped, built on the wrong table, or has its key
 *   order reversed. The sampler would go back to sorting the whole target table
 *   on every tick and nothing would go red.
 *
 * The Prisma drift check compares migration SQL against `schema.prisma`, so a
 * matching pair of MISTAKES is green there too.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const COUNTER_MIGRATION = "20260901120000_iss8674_queued_command_count";
const BACKFILL_MIGRATION = "20260901120050_iss8674_queued_command_backfill";
const INDEX_MIGRATION = "20260901120100_iss8674_queued_depth_idx";
const SWEEP_COLUMN_MIGRATION = "20260901130000_iss8674_queued_depth_swept_at";
const SWEEP_INDEX_MIGRATION = "20260901130100_iss8674_queued_depth_sweep_idx";
const SWEEP_INDEX_NAME = "compute_targets_queued_depth_sweep_idx";

/**
 * Repeated as literals rather than derived, deliberately. These are PINS: a
 * rename has to change this file too, so it becomes a decision somebody makes
 * rather than one that rides along silently.
 */
const INDEX_NAME = "compute_targets_queued_depth_idx";
const TRIGGER_NAME = "desktop_commands_queued_count_sync";
const TRIGGER_FUNCTION = "sync_compute_target_queued_command_count";
const CHECK_NAME = "compute_targets_queued_command_count_check";

/**
 * Order is the whole point. `queued_command_count DESC` LEADS so the sampler's
 * deepest-first `ORDER BY … LIMIT` is served from the index with no sort step;
 * that is what makes its per-tick work a constant. `id` follows ascending so a
 * burst of freshly registered targets sorts to the tail the cap drops rather
 * than displacing the fleet already being sampled.
 */
const ORDERED_KEYS = ["queued_command_count DESC", "id"];

const WHITESPACE_G = /\s+/g;

/**
 * The migration's SQL with runs of whitespace collapsed, so an assertion can
 * name a multi-line statement as the single string it reads as. Exact text
 * rather than a pattern: a loose match would accept a statement that had been
 * rewritten around the fragment it happens to quote.
 */
function flatDdl(migrationName: string): string {
  return migrationDdl(migrationName).replace(WHITESPACE_G, " ");
}

describe(`${INDEX_MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(INDEX_MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(INDEX_MIGRATION)).toHaveLength(1);
  });

  it("indexes compute_targets on descending depth, id-ascending as the tiebreak", () => {
    const index = indexNamed(INDEX_MIGRATION, INDEX_NAME);

    expect(index.table).toBe("compute_targets");
    // `toEqual` on the ordered array, never a contains-check: the same two
    // columns in the other order, or with DESC dropped, is a different index
    // that forces the sort this migration exists to remove.
    expect(index.keys).toEqual(ORDERED_KEYS);
  });

  // The predicate is what keeps this index the size of the targets currently
  // HOLDING a backlog — small and self-draining — instead of the size of every
  // target ever registered, a set that never drains because registration is
  // unquota'd. Dropping it silently reintroduces unbounded index growth.
  it("restricts the index to non-sentinel targets that hold a backlog", () => {
    expect(indexNamed(INDEX_MIGRATION, INDEX_NAME).predicate).toBe(
      "((is_cloud_sentinel = false) AND (queued_command_count > 0))"
    );
  });

  // A plain CREATE INDEX locks `compute_targets` for the whole build, blocking
  // the registration and heartbeat writes every desktop makes. `IF NOT EXISTS`
  // must stay absent so a failed concurrent build's INVALID leftover fails the
  // retry closed rather than recording the migration applied over an index
  // Postgres will never use.
  it("builds concurrently and does not tolerate a pre-existing index", () => {
    const index = indexNamed(INDEX_MIGRATION, INDEX_NAME);

    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
  });

  // The reason the column, constraint, trigger and backfill are a SEPARATE
  // migration. Prisma sends a multi-statement file as one implicit transaction,
  // and CONCURRENTLY inside a transaction block fails with SQLSTATE 25001 — so
  // merging the two migrations would break this one at deploy time, not here.
  it("carries nothing that would force Prisma's transaction wrap", () => {
    expect(
      migrationDdl(INDEX_MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});

describe(`${COUNTER_MIGRATION} migration DDL`, () => {
  const ddl = () => flatDdl(COUNTER_MIGRATION);

  // The counter is NOT NULL with a 0 default so a rendered 0 is always a
  // measurement: a target with no commands genuinely has a depth of 0, and the
  // backfill below gives every pre-existing target its true count. A nullable
  // column would make 0 and "never computed" the same value on the gauge.
  it("adds the counter as a NOT NULL integer defaulting to zero", () => {
    expect(ddl()).toContain(
      'ALTER TABLE "compute_targets" ADD COLUMN "queued_command_count" INTEGER NOT NULL DEFAULT 0;'
    );
  });

  // The CHECK and the backfill are NOT here, and that placement is the fix for
  // the lock whitlockk raised: everything in this file is a catalog change that
  // returns in milliseconds, so its ACCESS EXCLUSIVE locks on both tables are
  // released almost immediately. A data pass sharing the file would hold them
  // for its whole duration, because Prisma wraps the file in one transaction.
  it("carries no data pass and no constraint that a data pass must precede", () => {
    expect(ddl()).not.toContain("ADD CONSTRAINT");
    expect(ddl()).not.toContain(CHECK_NAME);
    expect(ddl()).not.toContain('UPDATE "compute_targets" AS target');
  });

  // The narrowing is load-bearing for the hot path: `ingestCommandEvent` writes
  // `last_sequence_acked` on every streamed event, by far the most frequent
  // update to this table, and `UPDATE OF` keeps those from reaching the
  // function at all. FOR EACH ROW, not FOR EACH STATEMENT:
  // `requeueUndeliveredCommands` and the seed reset both write many rows in one
  // statement, and a statement-level trigger would count each of those as one.
  it("fires per row on the three events that can change a depth, and no others", () => {
    expect(ddl()).toContain(
      `CREATE TRIGGER "${TRIGGER_NAME}" AFTER INSERT OR DELETE OR UPDATE OF "status", "compute_target_id" ON "desktop_commands" FOR EACH ROW EXECUTE FUNCTION "${TRIGGER_FUNCTION}"();`
    );
    // The lifecycle trigger specifically must be per ROW —
    // `requeueUndeliveredCommands` and the seed reset each write many rows in
    // one statement, and a statement-level version would count those as one.
    // The only FOR EACH STATEMENT here is the TRUNCATE trigger below, which is
    // statement-level because TRUNCATE has no rows to iterate.
    expect(ddl().match(/FOR EACH STATEMENT/g) ?? []).toHaveLength(1);
    expect(ddl()).toContain(
      `AFTER TRUNCATE ON "desktop_commands" FOR EACH STATEMENT`
    );
  });

  // Opposite-direction moves (A→B while B→A) would take the same two counter
  // rows in opposite orders and Postgres would abort one with 40P01, which no
  // command write path retries. The ordered lock is what makes the
  // acquisition sequence the same for every mover, whichever direction it
  // moves in.
  it("takes both counter rows in id order before a move writes either", () => {
    const flat = ddl();
    expect(flat).toContain(
      'PERFORM 1 FROM "compute_targets" WHERE "id" IN (OLD."compute_target_id", NEW."compute_target_id") ORDER BY "id" FOR NO KEY UPDATE;'
    );
    // Before BOTH of the move's writes, not after either — a lock taken once
    // the first counter is already written is the deadlock it should prevent.
    // Sliced rather than compared by index: the same increment/decrement text
    // also appears in the INSERT and DELETE branches above the lock, so a bare
    // indexOf would match those and pass regardless of the move branch.
    const afterLock = flat.slice(flat.indexOf("FOR NO KEY UPDATE"));
    expect(afterLock).toContain(
      '"queued_command_count" = "queued_command_count" - 1'
    );
    expect(afterLock).toContain(
      '"queued_command_count" = "queued_command_count" + 1'
    );
  });

  // The atomic form. A plpgsql read-into-a-variable then write-back is
  // semantically identical single-threaded and loses increments the moment two
  // dispatches race on one target — measured at 4 of 24 surviving when that
  // mutation was installed against the integration suite.
  it("adjusts the counter with a self-referencing update, never a read-then-write", () => {
    expect(ddl()).toContain(
      '"queued_command_count" = "queued_command_count" + 1'
    );
    expect(ddl()).toContain(
      '"queued_command_count" = "queued_command_count" - 1'
    );
    expect(ddl()).not.toContain('SELECT "queued_command_count" INTO');
  });

  // This file's statements are Prisma-inexpressible (trigger function and
  // trigger) and must stay in the transaction-wrapped migration. An index
  // built here would either take a table lock or fail with SQLSTATE 25001.
  // A row trigger never fires on TRUNCATE. Without a statement-level one, a
  // `TRUNCATE desktop_commands` freezes every counter at its last value — a
  // phantom backlog on the whole fleet at once, which the CHECK cannot catch
  // because it only refuses negatives.
  it("resets every counter on TRUNCATE, which a row trigger cannot see", () => {
    expect(ddl()).toContain(
      `CREATE TRIGGER "desktop_commands_queued_count_truncate" AFTER TRUNCATE ON "desktop_commands" FOR EACH STATEMENT EXECUTE FUNCTION "reset_compute_target_queued_command_counts"();`
    );
    expect(ddl()).toContain(
      'UPDATE "compute_targets" SET "queued_command_count" = 0 WHERE "queued_command_count" <> 0;'
    );
  });

  it("creates no index, leaving the concurrent build to its own migration", () => {
    expect(ddl().match(ANY_CREATE_INDEX_G)).toBeNull();
  });
});

describe(`${BACKFILL_MIGRATION} migration DDL`, () => {
  const ddl = () => flatDdl(BACKFILL_MIGRATION);

  // The ABSOLUTE form is load-bearing, and is why this is not the join over
  // targets-that-have-a-backlog it started as. The counter migration's trigger
  // is already live when this runs, so a target's counter carries deltas over
  // a base of zero for however long the gap between the two migrations was: a
  // target whose whole backlog drained in that gap has no queued row left to
  // join against and would keep its wrong (possibly negative) value. Correlating
  // from `compute_targets` instead visits every target, which is also what
  // makes this statement usable verbatim as the documented manual repair in
  // the counter migration's header.
  it("repairs every target from the rows, not only those still holding a backlog", () => {
    expect(ddl()).toContain(
      'UPDATE "compute_targets" AS target SET "queued_command_count" = backlog."queued_count" FROM ( SELECT ct."id", (SELECT count(*)::int FROM "desktop_commands" dc WHERE dc."compute_target_id" = ct."id" AND dc."status" = \'queued\') AS "queued_count" FROM "compute_targets" ct ) AS backlog WHERE target."id" = backlog."id" AND target."queued_command_count" IS DISTINCT FROM backlog."queued_count";'
    );
  });

  // An under-count is the one drift a wrong trigger could persist silently, and
  // it renders as a backlog that has already drained. Refuse it at the column
  // so the write fails loudly instead.
  it("refuses a negative depth at the column", () => {
    expect(ddl()).toContain(
      `ADD CONSTRAINT "${CHECK_NAME}" CHECK ("queued_command_count" >= 0);`
    );
  });

  // Order within the file, not just presence. Between the counter migration and
  // this one the counter is a delta from zero, so a target draining a
  // pre-existing backlog in that gap reaches a negative value legitimately. A
  // constraint added before the repair would reject that write — a 23514 on a
  // live command path during the deploy — instead of the repair simply
  // correcting it first.
  it("repairs before it constrains", () => {
    const flat = ddl();
    expect(flat.indexOf('UPDATE "compute_targets" AS target')).toBeLessThan(
      flat.indexOf("ADD CONSTRAINT")
    );
  });
});

describe(`${SWEEP_COLUMN_MIGRATION} migration DDL`, () => {
  const ddl = () => flatDdl(SWEEP_COLUMN_MIGRATION);

  // NOT NULL defaulting to the epoch, and both halves matter. "Never swept"
  // has to sort FIRST so a freshly registered target is gauged on the next
  // tick; Postgres sorts NULLs LAST in an ascending btree, and neither
  // NULLS FIRST nor an expression index is declarable in PSL. Making the
  // column nullable would bury every new target behind the whole fleet while
  // the sweep still looked like it worked.
  it("adds the rotation key as NOT NULL defaulting to the epoch", () => {
    expect(ddl()).toContain(
      `ALTER TABLE "compute_targets" ADD COLUMN "queued_depth_swept_at" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00';`
    );
  });

  it("creates no index, leaving the concurrent build to its own migration", () => {
    expect(ddl().match(ANY_CREATE_INDEX_G)).toBeNull();
  });
});

describe(`${SWEEP_INDEX_MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    expect(
      migrationDdl(SWEEP_INDEX_MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(SWEEP_INDEX_MIGRATION)).toHaveLength(1);
  });

  // Key order is the whole point: the rotation key LEADS so
  // `ORDER BY queued_depth_swept_at, id LIMIT n` is served from the index with
  // no sort. Leading on `id` instead is the primary-key ordering this migration
  // exists to replace, and it would restore the permanent omission while every
  // behavioral test stayed green — an index changes plan choice, never results.
  it("indexes compute_targets on the rotation key, id second", () => {
    const index = indexNamed(SWEEP_INDEX_MIGRATION, SWEEP_INDEX_NAME);

    expect(index.table).toBe("compute_targets");
    expect(index.keys).toEqual(["queued_depth_swept_at", "id"]);
  });

  // Scoped to the same fleet every other read here uses. Without the predicate
  // the index also carries sentinels, which the sweep never returns.
  it("restricts the rotation to the non-sentinel fleet", () => {
    expect(indexNamed(SWEEP_INDEX_MIGRATION, SWEEP_INDEX_NAME).predicate).toBe(
      "(is_cloud_sentinel = false)"
    );
  });

  it("builds concurrently and does not tolerate a pre-existing index", () => {
    const index = indexNamed(SWEEP_INDEX_MIGRATION, SWEEP_INDEX_NAME);

    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
  });

  it("carries nothing that would force Prisma's transaction wrap", () => {
    expect(
      migrationDdl(SWEEP_INDEX_MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});
