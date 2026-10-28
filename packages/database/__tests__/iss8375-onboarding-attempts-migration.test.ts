import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8375 — the indexes and foreign keys that ship with `onboarding_attempts`
 * (`packages/database/AGENTS.md` requires focused DDL coverage for every new
 * index, constraint, or foreign key).
 *
 * WHY NOTHING ELSE CATCHES THIS. Prisma's drift check compares this migration
 * against `schema.prisma`, so a matching pair of MISTAKES is green there, and
 * the generated client's types carry neither a constraint name nor a delete
 * action. Two properties here are load-bearing at runtime and invisible from
 * TypeScript:
 *
 * - UNIQUE on `(user_id, organization_id)` is what makes the compare-and-swap
 *   real. The transition path is an `updateMany` selecting that pair plus
 *   `revision`; without the constraint a second row for the same pair can
 *   exist, the CAS updates both, and two concurrent runs each believe they won.
 * - CASCADE on both references keeps an onboarding run from outliving the user
 *   or the tenant it describes. The default (NO ACTION) would instead BLOCK a
 *   user or organization delete once a run existed.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260902144605_iss8375_onboarding_attempts";
const TABLE = "onboarding_attempts";

/**
 * Names repeated as literals rather than derived from the DDL. These are PINS:
 * Prisma generates them from the unmapped `@@unique`/`@@index` in
 * `schema.prisma` and disagrees with the database if the SQL ever spells one
 * differently, so a rename has to change this file too.
 */
const RUN_IDENTITY_KEY = "onboarding_attempts_user_id_organization_id_key";
const ORGANIZATION_INDEX = "onboarding_attempts_organization_id_idx";
const USER_FOREIGN_KEY = "onboarding_attempts_user_id_fkey";
const ORGANIZATION_FOREIGN_KEY = "onboarding_attempts_organization_id_fkey";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);
const foreignKeys = () => parseForeignKeys(MIGRATION_NAME);

function indexNamed(name: string) {
  const found = indexes().find((index) => index.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

function foreignKeyNamed(name: string) {
  const found = foreignKeys().find((key) => key.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no foreign key named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the two indexes this table declares", () => {
    // Exhaustive rather than a membership check: an extra index nobody
    // accounted for is a lock and a write cost that no review saw.
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual([ORGANIZATION_INDEX, RUN_IDENTITY_KEY].sort());
  });

  it("makes (user_id, organization_id) the UNIQUE compare-and-swap identity", () => {
    const index = indexNamed(RUN_IDENTITY_KEY);
    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered key list, not a contains-check: a composite that
    // merely INCLUDES both columns does not constrain one run per user per org,
    // and a membership assertion would accept it.
    expect(index.keys).toEqual(["user_id", "organization_id"]);
    // Without UNIQUE the revision `updateMany` can match more than one row and
    // two concurrent transitions both read as accepted.
    expect(index.unique).toBe(true);
    // A partial index would scope the guarantee to a subset of runs; this one
    // must hold over every row.
    expect(index.predicate).toBeNull();
  });

  it("indexes organization_id, which the unique above cannot seek on", () => {
    // Cascade support for the organization foreign key: the unique leads with
    // user_id, so an organization delete would otherwise scan the table.
    const index = indexNamed(ORGANIZATION_INDEX);
    expect(index.table).toBe(TABLE);
    expect(index.keys).toEqual(["organization_id"]);
    expect(index.unique).toBe(false);
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

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds exactly the two foreign keys this table declares", () => {
    expect(
      foreignKeys()
        .map((key) => key.name)
        .sort()
    ).toEqual([ORGANIZATION_FOREIGN_KEY, USER_FOREIGN_KEY].sort());
  });

  it("cascades a user delete so no run outlives the person it describes", () => {
    const key = foreignKeyNamed(USER_FOREIGN_KEY);
    expect(key.table).toBe(TABLE);
    expect(key.referencedTable).toBe("users");
    expect(key.columns).toBe('"user_id"');
    // NO ACTION here would block deleting a user who ever started onboarding.
    expect(key.actions).toContain("ON DELETE CASCADE");
  });

  it("cascades an organization delete so no run outlives its tenant", () => {
    const key = foreignKeyNamed(ORGANIZATION_FOREIGN_KEY);
    expect(key.table).toBe(TABLE);
    expect(key.referencedTable).toBe("organizations");
    expect(key.columns).toBe('"organization_id"');
    expect(key.actions).toContain("ON DELETE CASCADE");
  });
});
