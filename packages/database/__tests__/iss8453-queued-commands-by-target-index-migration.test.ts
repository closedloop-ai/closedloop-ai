import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8453 — the partial index over the fleet-wide `status = 'queued'`
 * aggregate on `desktop_commands`.
 *
 * WHO SEEKS ON IT HAS CHANGED. ISS-8453 built this for the five-minute
 * queue-depth sampler (`countQueuedCommandsByTarget`,
 * apps/api/lib/desktop-command-dispatch-queries.ts), and the wording below
 * still calls that read "the sampler" because that is the query these key and
 * predicate choices were made for. ISS-8674 moved that GROUP BY onto
 * `ComputeTarget.queuedCommandCount`, but this index stayed on the per-tick
 * path: the same cron's drift detector (`reconcileQueuedCounters`) counts the
 * real queued rows of a bounded sample of targets every tick, and this index is
 * what makes each of those counts a seek. It also backs the counter's one-time
 * backfill and the one-statement repair documented in migration
 * 20260901120000_iss8674_queued_command_count. Every assertion here still
 * holds: the index is unchanged, and so is the shape of the query that reads
 * it.
 *
 * An index changes plan choice, never results, so no functional suite goes red
 * whether this migration builds the right index, the wrong one, or none.
 * `packages/database/AGENTS.md` requires focused DDL coverage per index
 * migration for exactly that reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260831160000_iss8453_queued_commands_by_target_idx";

/** Pinned as a literal so a rename is a decision, not a silent ride-along. */
const INDEX_NAME = "desktop_commands_queued_by_target_idx";

const TABLE = "desktop_commands";

/**
 * The sampler's GROUP BY key, and the only one. A composite leading on anything
 * else — the pre-existing (compute_target_id, status, created_at) is the live
 * example — cannot serve a predicate that supplies no target.
 */
const KEYS = ["compute_target_id"];

const ddl = () => migrationDdl(MIGRATION_NAME);

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(ddl().match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(1);
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(1);
  });

  it("indexes the sampler's group key on the command table", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);

    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered array, never a contains-check: a composite that
    // merely CONTAINS compute_target_id is what already exists and is what the
    // sampler cannot use.
    expect(index.keys).toEqual(KEYS);
    expect(index.method).toBe("btree");
  });

  it("stays PARTIAL on exactly the status the sampler counts", () => {
    const predicate = indexNamed(MIGRATION_NAME, INDEX_NAME).predicate;

    // Dropping the WHERE builds an index over every command row ever written —
    // desktop_commands has no retention sweep — which is the growth this shape
    // exists to avoid, and no other assertion here would notice: the name,
    // table, keys and method are all identical without it.
    expect(predicate).not.toBeNull();
    expect(predicate).toContain("status");
    // Bound to the enum the query filters on, not to a re-typed literal, so a
    // predicate the sampler no longer matches fails here rather than degrading
    // silently into a full scan every five minutes.
    expect(predicate).toContain(`'${DesktopCommandStatus.Queued}'`);
    // A terminal status in the predicate would make the index grow with history
    // rather than with the live backlog.
    for (const terminal of [
      DesktopCommandStatus.Done,
      DesktopCommandStatus.Failed,
      DesktopCommandStatus.Cancelled,
      DesktopCommandStatus.Expired,
    ]) {
      expect(predicate).not.toContain(`'${terminal}'`);
    }
  });

  it("builds CONCURRENTLY so the apply takes no write lock", () => {
    // A plain `CREATE INDEX` produces an IDENTICAL index and passes every other
    // assertion in this file. It just holds the table lock for the whole build,
    // blocking the command writes this sampler exists to observe.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).concurrently).toBe(true);
  });

  it("omits IF NOT EXISTS so a retry after a cancelled build fails closed", () => {
    // A cancelled CONCURRENTLY build leaves a same-named INVALID index that
    // Postgres ignores for planning; with IF NOT EXISTS the retry no-ops over it
    // and records the migration APPLIED over a permanently unusable index.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).ifNotExists).toBe(false);
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Prisma
    // splits a migration per statement UNLESS one carries dollar-quoting or
    // embedded semicolons, in which case it wraps the whole file and the build
    // fails with SQLSTATE 25001. Comments are stripped first — this migration's
    // header legitimately DESCRIBES those constructs while forbidding them.
    expect(ddl().match(TRANSACTION_WRAP_TRIGGER_G)).toBeNull();
  });

  it("keeps the index name inside Postgres' identifier limit", () => {
    // A name past 63 chars is truncated SILENTLY, and the truncated form is what
    // the Prisma drift check would then disagree with.
    expect(INDEX_NAME.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).name).toBe(INDEX_NAME);
  });
});
