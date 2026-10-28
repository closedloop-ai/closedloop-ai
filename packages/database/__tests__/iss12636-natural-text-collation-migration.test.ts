import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIST_QUERY_TEXT_COLLATION,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import { describe, expect, it } from "vitest";

/**
 * ISS-12636 — the ICU collation that `ListQueryTextOrdering.Natural` names.
 *
 * UNMANAGED by Prisma: its datamodel cannot declare a collation, so the differ
 * ignores the object in BOTH directions — a `migrate dev --create-only` against
 * a database holding it comes back empty, and so does one against a database
 * missing it. Nothing else in the repo would notice if this statement were
 * dropped or had its provider, locale or determinism quietly changed.
 *
 * The name exists in three places that nothing links: this migration, the
 * `LIST_QUERY_TEXT_COLLATION` entry the query interpolates through
 * `Prisma.raw`, and the slug `ORDER BY` itself. This test is the link — it
 * asserts the migration against the CONSTANT rather than against a literal, so
 * renaming one without the other fails here rather than at runtime, where a
 * missing collation is a 42704 on a user-facing board read.
 *
 * Its live counterpart is the `has the natural collation the slug key names`
 * case in `apps/api/__tests__/integration/assigned-tree-root-sort-parity.test.ts`,
 * which reads `pg_collation` on a real database.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20261021160000_iss12636_natural_text_collation";
const MIGRATION_SQL_PATH = join(
  import.meta.dirname,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

const LINE_COMMENT_G = /--[^\n]*/g;
const WHITESPACE_G = /\s+/g;
/** The one statement under test, captured so every assertion is scoped to it. */
const CREATE_COLLATION =
  /CREATE\s+COLLATION\s+(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(([^)]*)\)/i;
const CREATE_COLLATION_G = /CREATE\s+COLLATION/gi;
const ICU_PROVIDER = /provider\s*=\s*icu/i;
const NUMERIC_LOCALE = /locale\s*=\s*'en-u-kn-true'/i;
const DETERMINISTIC = /deterministic\s*=\s*true/i;

function normalizedSql(): string {
  return readFileSync(MIGRATION_SQL_PATH, "utf8")
    .replace(LINE_COMMENT_G, " ")
    .replace(WHITESPACE_G, " ")
    .trim();
}

describe(`${MIGRATION_NAME} (ISS-12636)`, () => {
  it("creates exactly one collation, named by the shared ruling", () => {
    const sql = normalizedSql();
    const match = CREATE_COLLATION.exec(sql);

    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(
      LIST_QUERY_TEXT_COLLATION[ListQueryTextOrdering.Natural]
    );
    // One statement: a second CREATE COLLATION would put a name this test does
    // not check into the same migration.
    expect(sql.match(CREATE_COLLATION_G)).toHaveLength(1);
  });

  it("builds it on ICU with the numeric tailoring, deterministically", () => {
    const body = CREATE_COLLATION.exec(normalizedSql())?.[3] ?? "";

    // `provider = icu` is what makes the keyword locale legal at all; libc
    // would take the cluster's default and rank a third way.
    expect(body).toMatch(ICU_PROVIDER);
    // `kn` is ICU's numeric-ordering keyword — the whole point of the class.
    expect(body).toMatch(NUMERIC_LOCALE);
    expect(body).toMatch(DETERMINISTIC);
  });
});
