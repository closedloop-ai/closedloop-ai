import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8463 — the indexes and foreign keys that ship with
 * `pull_request_verification_stamp_backfill` (`packages/database/AGENTS.md`:
 * "Every new migration that adds an index, constraint, enum value, or foreign
 * key must ship with a focused DDL or behavior test for that migration").
 *
 * WHY NOTHING ELSE CATCHES THIS (#6241 review). The backfill's own suites run
 * against a database where this migration has ALREADY been applied, so they see
 * the table and never the DDL that made it: an index dropped from the migration,
 * a key list reordered, or a cascade downgraded to the NO ACTION default would
 * leave every one of those tests green. Prisma's drift check compares this
 * migration against `schema.prisma`, so a matching pair of MISTAKES is green
 * there too. Two properties here are load-bearing and invisible from TypeScript:
 *
 * - `(run_id, reverted_at)` is the revert path's whole access pattern. The
 *   revert statement filters on both columns, and this capture table grows by
 *   one row per cleared stamp — an org-sized population — so without the index
 *   an undo is a full scan of every run ever captured.
 * - CASCADE on BOTH references. A capture row is a pre-image OF a
 *   `pull_request_detail` row: if the detail row is deleted the pre-image can
 *   never be written back to anything, and the default NO ACTION would instead
 *   make this audit table BLOCK the delete of the row it describes. Same for the
 *   organization — a tenant delete that trips over an internal capture table is
 *   an outage, not integrity.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME =
  "20260829174802_iss8463_pull_request_verification_stamp_backfill";
const TABLE = "pull_request_verification_stamp_backfill";

/**
 * Names repeated as literals rather than derived from the DDL. These are PINS:
 * renaming an index or constraint has to change this file too, so a rename is a
 * decision somebody makes rather than one that rides along silently. Prisma
 * generates them from the `map:` names in `schema.prisma` and disagrees with the
 * database if the SQL ever spells one differently.
 */
const RUN_INDEX = "pr_verification_stamp_backfill_run_idx";
const DETAIL_INDEX = "pr_verification_stamp_backfill_detail_idx";
const DETAIL_FK =
  "pull_request_verification_stamp_backfill_pull_request_deta_fkey";
const ORGANIZATION_FK =
  "pull_request_verification_stamp_backfill_organization_id_fkey";

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
    // An exhaustive comparison rather than a membership check: an extra index
    // nobody accounted for is a lock and a write cost that no review saw.
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual([DETAIL_INDEX, RUN_INDEX].sort());
  });

  it("indexes the revert path on run id AND the open/closed flag", () => {
    const index = indexNamed(RUN_INDEX);
    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered key list, not a contains-check. `run_id` alone
    // would still serve the lookup but not the `reverted_at IS NULL` filter that
    // is what makes a second revert of the same run a no-op instead of a
    // re-stamp; a membership assertion would accept the narrower index.
    expect(index.keys).toEqual(["run_id", "reverted_at"]);
  });

  it("indexes the detail id, which is how a row's capture is found", () => {
    const index = indexNamed(DETAIL_INDEX);
    expect(index.table).toBe(TABLE);
    expect(index.keys).toEqual(["pull_request_detail_id"]);
  });

  it("declares neither index UNIQUE", () => {
    // One detail row may legitimately be captured by more than one run — an
    // apply, a revert, and a second apply. A UNIQUE here would make the second
    // apply fail mid-statement and leave the population half-cleared.
    for (const index of indexes()) {
      expect(index.unique).toBe(false);
    }
  });

  it("builds every index IF NOT EXISTS, as the index-lock exception requires", () => {
    // These builds take ACCESS EXCLUSIVE, which is only safe because the table
    // is created empty in this same migration; CONCURRENTLY cannot be mixed
    // with that DDL. The allowlist exception is granted on the IF NOT EXISTS
    // spelling, so a retried migration is idempotent.
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
    ).toEqual([DETAIL_FK, ORGANIZATION_FK].sort());
  });

  it("cascades the detail delete so a pre-image cannot outlive its subject", () => {
    const detail = foreignKeyNamed(DETAIL_FK);
    expect(detail.table).toBe(TABLE);
    expect(detail.columns).toBe('"pull_request_detail_id"');
    expect(detail.referencedTable).toBe("pull_request_detail");
    expect(detail.referencedColumns).toBe('"id"');
    // The default NO ACTION would make this audit table BLOCK the delete of the
    // very row it describes; a pre-image with no row to restore to is not a
    // record, it is a dangling one.
    expect(detail.actions).toContain("ON DELETE CASCADE");
  });

  it("cascades an organization delete so no capture outlives its tenant", () => {
    const organization = foreignKeyNamed(ORGANIZATION_FK);
    expect(organization.table).toBe(TABLE);
    expect(organization.columns).toBe('"organization_id"');
    expect(organization.referencedTable).toBe("organizations");
    expect(organization.actions).toContain("ON DELETE CASCADE");
  });

  it("keeps every foreign-key name inside PostgreSQL's identifier limit", () => {
    // Prisma already truncated the detail constraint's generated name to fit;
    // reading the parsed name is what proves the SQL carries the truncated
    // spelling the database will store rather than the one it wanted.
    for (const key of foreignKeys()) {
      expect(key.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
  });
});
