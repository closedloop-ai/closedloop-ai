import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8761 — the two unique indexes and two cascading foreign keys that ship
 * with the Pensero backfill's attempt ledger and cursor tables
 * (`packages/database/AGENTS.md` requires focused DDL coverage for every new
 * index, constraint, or foreign key).
 *
 * WHY NOTHING ELSE CATCHES THIS. The cron and ledger suites run against an
 * in-memory fake, so they cannot see a constraint name, a missing UNIQUE, or a
 * missing cascade. Prisma's drift check compares this migration against
 * `schema.prisma`, so a matching PAIR of mistakes is green there too. Both
 * objects are load-bearing at runtime and neither is observable from the
 * TypeScript side:
 *
 * - Each UNIQUE index IS what makes its write a single atomic upsert.
 *   `recordBackfillDayAttempt` upserts on `(organization_id, day)` and
 *   `writeBackfillCursors` on `organization_id`; without an arbiter the daily
 *   cron racing a slow predecessor writes two ledger rows for one org-day, and
 *   `attemptCount` then counts halves of the truth in two places.
 * - The cascades are what stop a deleted organization leaving a live backfill
 *   schedule behind — rows a later sweep would keep walking for a tenant that
 *   no longer exists.
 *
 * There is deliberately NO index over `(organization_id, day)` beyond the
 * unique one: it is a btree on exactly those columns in that order, so it
 * already serves both the ledger's point lookup and the recheck lane's
 * org-scoped ascending day scan. The exhaustiveness assertion below is what
 * keeps a redundant second index from being added back by habit.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260903010000_iss8761_pensero_backfill_schedule";
const DAYS_TABLE = "pensero_backfill_days";
const CURSORS_TABLE = "pensero_backfill_cursors";

/**
 * Repeated as literals rather than derived from the DDL. These are PINS: the
 * point is that renaming an index or key has to change this file too, so a
 * rename is a decision somebody makes rather than one that rides along
 * silently. Prisma generates these names from the schema attributes and
 * disagrees with the database if the SQL ever spells them differently.
 */
const DAYS_UNIQUE_INDEX = "pensero_backfill_days_organization_id_day_key";
const CURSORS_UNIQUE_INDEX = "pensero_backfill_cursors_organization_id_key";
const DAYS_FOREIGN_KEY = "pensero_backfill_days_organization_id_fkey";
const CURSORS_FOREIGN_KEY = "pensero_backfill_cursors_organization_id_fkey";
const SCOPE_COLUMN = "organization_id";
const DAY_COLUMN = "day";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);
const foreignKeys = () => parseForeignKeys(MIGRATION_NAME);

function indexNamedOrThrow(name: string) {
  const found = indexes().find((index) => index.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

function foreignKeyNamedOrThrow(name: string) {
  const found = foreignKeys().find((key) => key.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no FOREIGN KEY constraint named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly these two indexes and nothing else", () => {
    // Two assertions, deliberately: the second proves the first is exhaustive.
    // A statement the strict head regex cannot read would be absent from the
    // scan, and a name-equality check alone would still pass.
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual([CURSORS_UNIQUE_INDEX, DAYS_UNIQUE_INDEX].sort());
    expect(
      migrationDdl(MIGRATION_NAME).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(2);
  });

  it("keys the ledger on (organization, day), in that column order", () => {
    const index = indexNamedOrThrow(DAYS_UNIQUE_INDEX);

    expect(index.table).toBe(DAYS_TABLE);
    // `toEqual` on the ORDERED array, not a contains-check. The order is what
    // makes this index serve the org-scoped ascending day scan the recheck lane
    // pages through; `(day, organization_id)` would satisfy a membership
    // assertion and leave that scan without an index.
    expect(index.keys).toEqual([SCOPE_COLUMN, DAY_COLUMN]);
  });

  it("keys the cursor table on the organization alone", () => {
    const index = indexNamedOrThrow(CURSORS_UNIQUE_INDEX);

    expect(index.table).toBe(CURSORS_TABLE);
    expect(index.keys).toEqual([SCOPE_COLUMN]);
  });

  it("makes both UNIQUE, which is what gives each upsert an ON CONFLICT arbiter", () => {
    // A plain index over the same columns produces a perfectly valid index,
    // passes every other assertion in this file, and lets two overlapping cron
    // runs write two ledger rows for one org-day and two cursor rows for one
    // org — after which every read picks one arbitrarily.
    expect(indexNamedOrThrow(DAYS_UNIQUE_INDEX).unique).toBe(true);
    expect(indexNamedOrThrow(CURSORS_UNIQUE_INDEX).unique).toBe(true);
  });

  it("builds both with IF NOT EXISTS, as the index-lock exception requires", () => {
    // Each build takes ACCESS EXCLUSIVE, which is only safe because the table is
    // created empty in this same migration; CONCURRENTLY cannot be mixed with
    // that DDL, which is the rationale the `index-lock-ok` markers and the
    // destructive-migration allowlist entries both carry. The exception is
    // granted on the IF NOT EXISTS spelling, so a retry is idempotent.
    for (const name of [DAYS_UNIQUE_INDEX, CURSORS_UNIQUE_INDEX]) {
      expect(indexNamedOrThrow(name).ifNotExists).toBe(true);
      expect(indexNamedOrThrow(name).concurrently).toBe(false);
    }
  });

  it("keeps both index names inside PostgreSQL's identifier limit", () => {
    // Read off the PARSED name, not the constant: a name past 63 chars is
    // truncated SILENTLY, and the truncated form is what Prisma's drift check
    // would then disagree with. Asserting the constant against itself would
    // only fail if someone edited the expectation.
    for (const name of [DAYS_UNIQUE_INDEX, CURSORS_UNIQUE_INDEX]) {
      expect(indexNamedOrThrow(name).name.length).toBeLessThanOrEqual(
        MAX_IDENTIFIER_LENGTH
      );
    }
  });
});

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds exactly two foreign keys, both to organizations", () => {
    expect(foreignKeys()).toHaveLength(2);

    const days = foreignKeyNamedOrThrow(DAYS_FOREIGN_KEY);
    expect(days.table).toBe(DAYS_TABLE);
    expect(days.columns).toBe(`"${SCOPE_COLUMN}"`);
    expect(days.referencedTable).toBe("organizations");
    expect(days.referencedColumns).toBe('"id"');

    const cursors = foreignKeyNamedOrThrow(CURSORS_FOREIGN_KEY);
    expect(cursors.table).toBe(CURSORS_TABLE);
    expect(cursors.columns).toBe(`"${SCOPE_COLUMN}"`);
    expect(cursors.referencedTable).toBe("organizations");
    expect(cursors.referencedColumns).toBe('"id"');
  });

  it("cascades both deletes so a removed org leaves no live backfill schedule", () => {
    // The default is NO ACTION, which would REJECT the organization delete
    // rather than leave an orphan — a different failure, equally wrong, and
    // invisible to every TypeScript test. RESTRICT and SET NULL are likewise
    // valid SQL that would pass the name-and-columns assertions above.
    expect(foreignKeyNamedOrThrow(DAYS_FOREIGN_KEY).actions).toContain(
      "ON DELETE CASCADE"
    );
    expect(foreignKeyNamedOrThrow(CURSORS_FOREIGN_KEY).actions).toContain(
      "ON DELETE CASCADE"
    );
  });

  it("keeps both foreign-key names inside PostgreSQL's identifier limit", () => {
    for (const name of [DAYS_FOREIGN_KEY, CURSORS_FOREIGN_KEY]) {
      expect(foreignKeyNamedOrThrow(name).name.length).toBeLessThanOrEqual(
        MAX_IDENTIFIER_LENGTH
      );
    }
  });
});
