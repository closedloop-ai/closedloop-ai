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
 * The `session_detail.external_session_id` index that lets historical invocation
 * replay resolve a session captured on another machine.
 *
 * An index changes PLAN CHOICE only, never results, so nothing else in the repo
 * goes red when this DDL is wrong: the lookup's own tests pass against a
 * sequential scan, and the Prisma drift check compares the migration to
 * `schema.prisma`, so a matching pair of mistakes is green there too.
 * `packages/database/AGENTS.md` requires focused DDL coverage per index
 * migration for exactly that reason.
 */
const MIGRATION_NAME = "20261006150000_session_external_id_replay_index";
const INDEX_NAME = "session_detail_external_session_id_idx";

const ddl = () => migrationDdl(MIGRATION_NAME);

describe("historical invocation session lookup index", () => {
  it("indexes the external session ID independently of the original compute target", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);
    expect(index.table).toBe("session_detail");
    expect(index.keys).toEqual(["external_session_id"]);
    // The table's `@@unique([computeTargetId, externalSessionId])` leads with
    // `compute_target_id`, which the cross-machine lookup deliberately does not
    // constrain, so it cannot drive that read.
    expect(index.predicate).toBeNull();
  });

  it("builds concurrently, so session ingest keeps writing", () => {
    // `session_detail` is the hot session-ingest table. A plain CREATE INDEX
    // holds a write-blocking lock for the whole build and stalls desktop sync
    // and API writes at production size — the failure mode PRD-547 was opened
    // for after FEA-3638, and the reason every earlier index on this table
    // (20260730180000, 20260811130000, 20260914120000) went in concurrently.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).concurrently).toBe(true);
  });

  it("omits IF NOT EXISTS so a retry after a cancelled build fails closed", () => {
    // A cancelled or crashed CONCURRENTLY build leaves a same-named INVALID
    // index that Postgres ignores for planning. With IF NOT EXISTS the retry
    // would no-op over it and record the migration APPLIED while the index
    // stays permanently unusable — a green deploy with no index. Without the
    // clause the retry errors and an operator drops the remnant first.
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).ifNotExists).toBe(false);
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Prisma
    // splits a migration per statement UNLESS one carries dollar-quoting or
    // embedded semicolons, in which case it wraps the whole file and the build
    // fails with SQLSTATE 25001. Comments are stripped first — this migration's
    // header legitimately names every one of these constructs while telling the
    // next author not to add them.
    expect(ddl().match(TRANSACTION_WRAP_TRIGGER_G)).toBeNull();
  });

  it("carries exactly one statement, and the parser reads it", () => {
    // The looser scan guards the stricter parse: a statement the parse cannot
    // read must not be able to vanish from the count.
    expect(ddl().match(ANY_CREATE_INDEX_G)).toHaveLength(1);
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(1);
  });

  it("keeps the index name inside Postgres' identifier limit", () => {
    // A name past 63 chars is truncated SILENTLY, and the truncated form is
    // what Prisma's drift check would then disagree with.
    expect(INDEX_NAME.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    expect(indexNamed(MIGRATION_NAME, INDEX_NAME).name).toBe(INDEX_NAME);
  });
});
