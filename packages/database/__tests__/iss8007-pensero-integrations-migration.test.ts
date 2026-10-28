import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8007 — the unique index and the cascading foreign key that ship with
 * `pensero_integrations` (#6030, whitlockk and codex P1;
 * `packages/database/AGENTS.md` requires focused DDL coverage for every new
 * index, constraint, or foreign key).
 *
 * WHY NOTHING ELSE CATCHES THIS. The service suite runs against an in-memory
 * fake, so it cannot see a constraint name, a missing UNIQUE, or a missing
 * cascade. Prisma's drift check compares this migration against
 * `schema.prisma`, so a matching pair of MISTAKES is green there too. Both
 * objects are load-bearing at runtime and neither is observable from the
 * TypeScript side:
 *
 * - The UNIQUE index IS what makes `setOrgCredential` a single atomic upsert.
 *   Without it `upsert({ where: { organizationId } })` has no arbiter, and two
 *   concurrent saves race into two credential rows for one org — after which
 *   every read picks one arbitrarily.
 * - The cascade is what stops a deleted organization leaving a live KMS-encrypted
 *   credential behind, which the PR chose over matching the Linear/Slack/Google
 *   integration models precisely because an orphaned secret is worse than
 *   divergence.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260826120000_iss8007_pensero_integrations";
const TABLE = "pensero_integrations";

/**
 * Repeated as a literal rather than derived from the DDL. This is a PIN: the
 * point is that renaming the index has to change this file too, so a rename is
 * a decision somebody makes rather than one that rides along silently. Prisma
 * generates this name from `@@unique([organizationId])` and disagrees with the
 * database if the SQL ever spells it differently.
 */
const UNIQUE_INDEX_NAME = "pensero_integrations_organization_id_key";
const FOREIGN_KEY_NAME = "pensero_integrations_organization_id_fkey";
const SCOPE_COLUMN = "organization_id";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);
const foreignKeys = () => parseForeignKeys(MIGRATION_NAME);

function uniqueIndex() {
  const found = indexes().find((index) => index.name === UNIQUE_INDEX_NAME);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${UNIQUE_INDEX_NAME}" was parsed from migration.sql`
    );
  }
  return found;
}

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Two assertions, deliberately: the second proves the first is exhaustive.
    // A statement the strict head regex cannot read would be absent from the
    // scan, and a name-equality check alone would still pass.
    expect(indexes().map((index) => index.name)).toEqual([UNIQUE_INDEX_NAME]);
    expect(
      migrationDdl(MIGRATION_NAME).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
  });

  it("indexes the org scope on the credential table", () => {
    const index = uniqueIndex();

    expect(index.table).toBe(TABLE);
    // `toEqual` on the ordered array rather than a contains-check: a composite
    // index that merely INCLUDES organization_id would not constrain one row
    // per org, and a membership assertion would accept it.
    expect(index.keys).toEqual([SCOPE_COLUMN]);
  });

  it("is UNIQUE, which is what gives the upsert an ON CONFLICT arbiter", () => {
    // A plain index over the same column produces a perfectly valid index,
    // passes every other assertion in this file, and lets two concurrent saves
    // create two credential rows for one organization.
    expect(uniqueIndex().unique).toBe(true);
  });

  it("is an IF NOT EXISTS build, as the index-lock exception requires", () => {
    // The build takes ACCESS EXCLUSIVE, which is only safe because the table is
    // created empty in this same migration; CONCURRENTLY cannot be mixed with
    // that DDL, which is the rationale the `index-lock-ok` marker and the
    // destructive-migration allowlist entry both carry. The exception is granted
    // on the IF NOT EXISTS spelling, so a retried migration is idempotent.
    expect(uniqueIndex().ifNotExists).toBe(true);
    expect(uniqueIndex().concurrently).toBe(false);
  });

  it("keeps the index name inside PostgreSQL's identifier limit", () => {
    // Read off the PARSED name, not the constant: a name past 63 chars is
    // truncated SILENTLY, and the truncated form is what Prisma's drift check
    // would then disagree with. Asserting the constant against itself would only
    // fail if someone edited the expectation.
    expect(uniqueIndex().name.length).toBeLessThanOrEqual(
      MAX_IDENTIFIER_LENGTH
    );
  });
});

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds exactly one foreign key, from the credential table to organizations", () => {
    expect(foreignKeys()).toHaveLength(1);

    const [parsed] = foreignKeys();
    expect(parsed.table).toBe(TABLE);
    expect(parsed.name).toBe(FOREIGN_KEY_NAME);
    expect(parsed.columns).toBe(`"${SCOPE_COLUMN}"`);
    expect(parsed.referencedTable).toBe("organizations");
    expect(parsed.referencedColumns).toBe('"id"');
  });

  it("cascades the delete so a removed org leaves no live encrypted credential", () => {
    // The default is NO ACTION, which would REJECT the organization delete
    // rather than leave an orphan — a different failure, equally wrong, and
    // invisible to every TypeScript test. RESTRICT and SET NULL are likewise
    // valid SQL that would pass the name-and-columns assertions above.
    expect(foreignKeys()[0]?.actions).toContain("ON DELETE CASCADE");
  });

  it("keeps the foreign-key name inside PostgreSQL's identifier limit", () => {
    expect(foreignKeys()[0]?.name.length).toBeLessThanOrEqual(
      MAX_IDENTIFIER_LENGTH
    );
  });
});
