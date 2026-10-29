import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-9665: what the search-projection priority repair is allowed to do.
 *
 * This file pins the SQL TEXT. Its sibling
 * `integration/iss9665-search-document-unset-priority-backfill.integration.test.ts`
 * executes the same shipped file against real Postgres and asserts the rows it
 * moves; the two are complementary and neither replaces the other. A text pin
 * catches the edit that quietly widens what the statement is willing to write,
 * which is the failure that matters most here: the write is irreversible and a
 * wrong predicate is discovered only after production rows already hold NULL.
 *
 * The negative pins are the point of the file. Each encodes a decision:
 *
 *  - widening `sd."priority" = 'MEDIUM'` to `IS NOT NULL` would absorb drift
 *    this migration has no evidence about. The fold it repairs was
 *    `artifact.priority ?? Priority.Medium`, so 'MEDIUM' is the only value it
 *    could ever have produced;
 *  - dropping the join to `artifacts` would clear every MEDIUM in the corpus,
 *    including the ones the artifact really holds;
 *  - dropping `a."priority" IS NULL` does the same thing one clause later;
 *  - assigning anything but `priority` — `updated_at` above all — would re-rank
 *    every repaired document in search results for a change no user made;
 *  - splitting selection from the write would reopen the READ COMMITTED window
 *    that let an uncounted row into the ceiling-bounded set (the ISS-8517
 *    review finding).
 *
 * Reads declarative migration.sql DDL only — never implementation source.
 */
const MIGRATION =
  "20260907140000_iss9665_search_document_unset_priority_backfill";

const WHITESPACE_G = /\s+/g;
const ROW_DESTRUCTION_RE = /\b(DELETE|TRUNCATE|INSERT)\b/i;
const SCHEMA_CHANGE_RE = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

/**
 * Every `SET` clause in the file, captured between `SET` and `FROM`.
 *
 * Captured as whole clauses rather than matched per-assignment: a
 * `/SET "col" =/g` scan sees only the FIRST target, because the second
 * assignment in `SET "a" = …, "b" = …` has no `SET` before it.
 */
const SET_CLAUSE_G = /SET\s+(.+?)\s+FROM\s/g;

/**
 * The repair, whole. Held as ONE constant rather than asserted clause by clause
 * because the safety argument is that these conjuncts appear TOGETHER: separate
 * `toContain` calls would still pass if a future edit split them across two
 * statements, which is precisely the split that reopens the READ COMMITTED
 * window. The `MATERIALIZED` candidate CTE and the data-modifying CTE that
 * writes it are ONE statement and therefore ONE snapshot.
 *
 * The UPDATE re-states `sd."priority" = 'MEDIUM'` against its own target on
 * purpose — READ COMMITTED re-evaluates that clause against a row a concurrent
 * writer has just changed, so a document that acquired a real priority between
 * snapshot and write keeps it.
 */
const REPAIR_STATEMENT =
  "WITH candidates AS MATERIALIZED ( " +
  'SELECT sd."id" ' +
  'FROM "search_document" AS sd ' +
  'JOIN "artifacts" AS a ' +
  'ON a."id" = sd."entity_id" ' +
  'AND a."organization_id" = sd."organization_id" ' +
  "WHERE sd.\"entity_type\" = 'document' " +
  "AND sd.\"priority\" = 'MEDIUM' " +
  'AND a."priority" IS NULL ' +
  "LIMIT max_inline_rows + 1 " +
  "), cleared AS ( " +
  'UPDATE "search_document" AS sd ' +
  'SET "priority" = NULL ' +
  "FROM candidates AS c " +
  'WHERE sd."id" = c."id" ' +
  "AND sd.\"priority\" = 'MEDIUM' " +
  'RETURNING sd."id" ' +
  ") " +
  "SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM cleared) " +
  "INTO stale_selected, stale_written;";

/**
 * The three conjuncts that decide which rows are repaired. They ship in three
 * places — the executable candidate CTE, the header's pre-deploy count, and the
 * header's drain — and move together by hand.
 */
const REPAIR_CONJUNCTS = [
  "sd.\"entity_type\" = 'document'",
  "sd.\"priority\" = 'MEDIUM'",
  'a."priority" IS NULL',
];

/** The header's pre-deploy count and drain live in comments, so read raw. */
function rawMigrationSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
}

function normalized(): string {
  return migrationDdl(MIGRATION).replace(WHITESPACE_G, " ").trim();
}

/**
 * The slice of the header between two markers. Throws rather than returning an
 * empty string when either marker is absent, so a renamed header section fails
 * the assertion instead of vacuously satisfying every `toContain` against "".
 */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from === -1 || to === -1) {
    throw new Error(`${MIGRATION}: header section ${start}…${end} not found`);
  }
  return source.slice(from, to);
}

describe(`${MIGRATION} migration SQL`, () => {
  it("repairs with exactly the shipped single-snapshot statement", () => {
    expect(normalized()).toContain(REPAIR_STATEMENT);
  });

  it("assigns priority and nothing else", () => {
    // `updated_at` mirrors the SOURCE entity's updatedAt and is the search
    // ordering key. A `SET "priority" = NULL, "updated_at" = now()` would pass
    // a `toContain('SET "priority" = NULL')` check and silently re-rank every
    // repaired document.
    const clauses = [...normalized().matchAll(SET_CLAUSE_G)].map(
      (match) => match[1]
    );
    expect(clauses).toEqual(['"priority" = NULL']);
  });

  it("never destroys or restructures rows", () => {
    // This is a repair of existing rows. A DELETE of the stale rows would also
    // make `priority:none` answer correctly — by dropping the documents out of
    // search entirely.
    const ddl = migrationDdl(MIGRATION);
    expect(ROW_DESTRUCTION_RE.test(ddl)).toBe(false);
    expect(SCHEMA_CHANGE_RE.test(ddl)).toBe(false);
  });

  it("bounds the rows one transaction may lock, and aborts above it", () => {
    const ddl = normalized();
    expect(ddl).toContain("max_inline_rows CONSTANT bigint := 250000");
    // The comparison is against SELECTED, not WRITTEN: selected is what
    // describes how many rows the statement was willing to lock.
    expect(ddl).toContain("IF stale_selected > max_inline_rows THEN");
    expect(ddl).toContain("RAISE EXCEPTION");
  });

  it("puts the recovery steps in the RAISE MESSAGE, not only the HINT", () => {
    // `migrate-deploy-recovery.ts` parses P0001 output for the first LINE of
    // `Database error:` and prints it as `Invariant:`. Postgres carries HINT as
    // a separate field, so a hint-only remedy can be dropped before an operator
    // ever sees it.
    const raw = rawMigrationSql();
    const message = raw.slice(
      raw.indexOf("RAISE EXCEPTION"),
      raw.indexOf("USING HINT")
    );
    expect(message).toContain("prisma migrate resolve --rolled-back");
    expect(message).toContain(MIGRATION);
    expect(message).toContain("batched drain");
  });

  it("carries a pre-deploy count and a drain whose predicate matches the repair", () => {
    // The population was not measured against production when this was
    // authored, so the count query is the operator's only way to know whether
    // the ceiling will fire, and the drain is the only way past it. Both live
    // in comments, so `migrationDdl` cannot see them — and a header that drifts
    // from the statement hands an operator a query for a DIFFERENT population.
    // Scoped per region rather than counted across the file, so prose that
    // happens to quote a conjunct cannot satisfy or break the assertion.
    const header = rawMigrationSql().replace(WHITESPACE_G, " ");
    const countQuery = between(header, "SELECT count(*)", ";");
    const drain = between(header, String.raw`\set batch`, "This migration");

    expect(drain).toContain("FOR UPDATE OF sd SKIP LOCKED");
    // The drain writes the same value the statement does, no wider.
    expect(drain).toContain('SET "priority" = NULL');
    for (const conjunct of REPAIR_CONJUNCTS) {
      expect(countQuery).toContain(conjunct);
      expect(drain).toContain(conjunct);
      // And the executable statement itself, so all three genuinely agree.
      expect(normalized()).toContain(conjunct);
    }
  });
});
