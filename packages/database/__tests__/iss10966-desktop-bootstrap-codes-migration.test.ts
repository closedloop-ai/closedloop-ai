import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-10966 (PLN-2095 Slice 1) — the indexes that ship with
 * `desktop_bootstrap_codes`, per `packages/database/AGENTS.md`'s requirement of
 * focused DDL coverage for every new index or constraint.
 *
 * WHY NOTHING ELSE CATCHES THIS. Prisma's drift check compares this migration
 * against `schema.prisma`, so a matching pair of MISTAKES is green there, and
 * the generated client's types carry neither a constraint name nor a
 * uniqueness guarantee. Three properties are load-bearing at runtime and
 * invisible from TypeScript:
 *
 * - UNIQUE on `code_hash` is what makes a bootstrap code SINGLE-USE at the
 *   storage layer rather than only in service code. The redeem (Slice 3) claims
 *   a row with an `updateMany` on `{ id, redeemedAt: null }`; the mint's
 *   uniqueness is a separate guarantee, and without this constraint two mints
 *   that collide on a hash both persist and both redeem. This assertion is the
 *   reason "a second row with the same code_hash is rejected" is true, and it
 *   is asserted against the parsed statement rather than the file.
 * - The index on `expires_at` is the access path for the mint's opportunistic
 *   eviction sweep. Absent it, that sweep is a sequential scan on every mint.
 * - Both build plain rather than CONCURRENTLY, which is only safe because the
 *   table is created empty in this same migration. The `check-destructive-
 *   migrations` gate grants that on the `IF NOT EXISTS` spelling, so a retried
 *   migration stays idempotent.
 *
 * This table deliberately has NO foreign key: there is no internal `user` or
 * `organization` row to reference at mint time. That absence is asserted, not
 * assumed — a later change adding an ownership FK here would re-introduce the
 * very precondition the separate table exists to avoid.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260925195455_iss10966_desktop_bootstrap_codes";
const TABLE = "desktop_bootstrap_codes";

/**
 * Names repeated as literals rather than derived from the DDL. These are PINS:
 * Prisma generates them from the unmapped `@unique`/`@@index` in
 * `schema.prisma` and disagrees with the database if the SQL ever spells one
 * differently, so a rename has to change this file too.
 */
const SINGLE_USE_CODE_KEY = "desktop_bootstrap_codes_code_hash_key";
const EXPIRY_SWEEP_INDEX = "desktop_bootstrap_codes_expires_at_idx";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);

function indexNamed(name: string) {
  const found = indexes().find((index) => index.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

describe(`${MIGRATION_NAME} table DDL`, () => {
  it("carries clerk_user_id as its only identity, with no internal ownership columns", () => {
    const table = migrationDdl(MIGRATION_NAME)
      .split(";")
      .find((sql) => sql.includes(`CREATE TABLE "${TABLE}"`));
    expect(table).toBeDefined();
    expect(table).toContain('"clerk_user_id" TEXT NOT NULL');
    // The whole reason this is a separate table: neither column has a value at
    // mint time, and adding either would make the row unwritable for the
    // orgless principal it exists to serve.
    expect(table).not.toContain('"user_id"');
    expect(table).not.toContain('"organization_id"');
    // `redeemed_at` must stay NULLable — it IS the unredeemed marker the
    // single-use claim selects on. A NOT NULL default would make every fresh
    // code read as already spent.
    expect(table).toContain('"redeemed_at" TIMESTAMP(3),');
    expect(table).toContain(`CONSTRAINT "${TABLE}_pkey" PRIMARY KEY ("id")`);
  });

  it("adds no foreign key, because there is no internal row to reference yet", () => {
    expect(parseForeignKeys(MIGRATION_NAME)).toEqual([]);
    // `parseForeignKeys` only recognises the `ALTER TABLE ... ADD CONSTRAINT`
    // form, so on its own it says nothing about an INLINE `REFERENCES` inside
    // the CREATE TABLE — which is the form Prisma emits and the one that would
    // actually make this row unwritable for an orgless principal. Assert the
    // absence on the table statement too, or the sentence above outruns what is
    // pinned.
    const table = migrationDdl(MIGRATION_NAME)
      .split(";")
      .find((sql) => sql.includes(`CREATE TABLE "${TABLE}"`));
    expect(table).toBeDefined();
    expect(table).not.toContain("REFERENCES");
  });
});

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the two indexes this table declares", () => {
    // Exhaustive rather than a membership check: an extra index nobody
    // accounted for is a lock and a write cost that no review saw.
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual([EXPIRY_SWEEP_INDEX, SINGLE_USE_CODE_KEY].sort());
  });

  it("makes code_hash UNIQUE, which is what makes a code single-use in storage", () => {
    const index = indexNamed(SINGLE_USE_CODE_KEY);
    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered key list, not a contains-check: a composite that
    // merely INCLUDES code_hash does not constrain one row per hash.
    expect(index.keys).toEqual(["code_hash"]);
    expect(index.unique).toBe(true);
    // A partial index would scope single-use to a subset of rows — for example
    // only the unredeemed ones, which is precisely the set a replay attacks.
    expect(index.predicate).toBeNull();
  });

  it("indexes expires_at, the access path the mint's eviction sweep uses", () => {
    const index = indexNamed(EXPIRY_SWEEP_INDEX);
    expect(index.table).toBe(TABLE);
    expect(index.keys).toEqual(["expires_at"]);
    // Not unique: many codes legitimately share an expiry instant.
    expect(index.unique).toBe(false);
    expect(index.predicate).toBeNull();
  });

  it("builds every index IF NOT EXISTS, as the index-lock exception requires", () => {
    // These builds take ACCESS EXCLUSIVE, which is only safe because the table
    // is created empty in this same migration; CONCURRENTLY cannot be mixed
    // with that DDL. The exception is granted on the IF NOT EXISTS spelling, so
    // a retried migration is idempotent.
    for (const index of indexes()) {
      expect(index.ifNotExists).toBe(true);
      expect(index.concurrently).toBe(false);
    }
  });

  it("keeps every index name inside PostgreSQL's identifier limit", () => {
    // Read off the PARSED name, not the constant: a name past 63 chars is
    // truncated SILENTLY, and the truncated form is what Prisma's drift check
    // would then disagree with.
    for (const index of indexes()) {
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
  });
});
