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
 * ISS-7476 (PLN-1775 M3 ride-along) — the partial index that bounds the
 * bootstrap cron's CROSS-ORG due-row read
 * (`selectOrgIdsWithDueObservedRepositories`,
 * apps/api/lib/github/observed-repository-discovery.ts).
 *
 * An index changes plan choice, never results, so the discovery suite stays
 * green whether this migration builds the right index, the wrong one, or none.
 * `packages/database/AGENTS.md` requires focused DDL coverage per index
 * migration for that reason. This one is also the first index in the repo
 * GENERATED from a `@@index(..., where: raw(...))` declaration, so its shape is
 * the proof that the ISS-7476 flag change produces the intended SQL.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME =
  "20260826211706_iss7476_observed_repository_due_rotation_index";

/** Pinned as a literal so a rename is a decision, not a silent ride-along. */
const INDEX_NAME = "github_observed_repository_due_rotation_idx";

const TABLE = "github_observed_repository";

/**
 * `last_verification_attempt_at` LEADS because the read orders by it; `id`
 * breaks ties deterministically so the cron's paging cannot revisit or skip an
 * org. The M0 index is (organization_id, verification_state,
 * next_verification_at) — org-leading, and therefore useless to a read that
 * never names an organization.
 */
const ORDERED_KEYS = ["last_verification_attempt_at", "id"];

/**
 * The non-terminal states, verbatim from the SSOT const
 * `GitHubObservedRepositoryVerificationState`
 * (apps/api/lib/github/observed-repository-store.ts — an app module this package
 * cannot import). `verified` is deliberately absent: it is where rows END, so
 * covering it would make the index grow with the table instead of with the
 * backlog. Adding a fourth state means deciding whether it is terminal, and
 * this assertion is what forces that decision to be made here.
 */
const PARTIAL_STATES = ["pending", "denied"];

const ddl = () => migrationDdl(MIGRATION_NAME);

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(ddl().match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(1);
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(1);
  });

  it("indexes the due-row read on the right table, attempt-time leading", () => {
    const index = indexNamed(MIGRATION_NAME, INDEX_NAME);

    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered array, never a contains-check: (id,
    // last_verification_attempt_at) holds the same two columns and serves the
    // ordering not at all.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what answers the ORDER BY. A hash index would pass a
    // name-and-columns check and serve neither the range nor the sort.
    expect(index.method).toBe("btree");
  });

  it("stays PARTIAL on exactly the non-terminal states", () => {
    const predicate = indexNamed(MIGRATION_NAME, INDEX_NAME).predicate;

    // Dropping the WHERE builds an index over every observation row ever
    // verified, which is the growth this shape exists to avoid, and no other
    // assertion here would notice: the name, table, keys and method are all
    // identical without it.
    expect(predicate).not.toBeNull();
    for (const state of PARTIAL_STATES) {
      expect(predicate).toContain(`'${state}'`);
    }
    // The terminal state must NOT be covered.
    expect(predicate).not.toContain("'verified'");
    expect(predicate).toContain("verification_state");
  });

  it("builds CONCURRENTLY so the apply takes no write lock", () => {
    // A plain `CREATE INDEX` produces an IDENTICAL index and passes every other
    // assertion in this file. It just holds ACCESS EXCLUSIVE on
    // github_observed_repository for the whole build, stalling the session-sync
    // batches that write it.
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
