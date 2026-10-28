import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-9938 (PLN-2065 §5.2/§5.3): what the two status repairs are allowed to do.
 *
 * This file pins the SQL TEXT of both migrations, in the UNIT tier, and that
 * tier is the point: the sibling
 * `integration/iss9938-search-document-status-repair.integration.test.ts`
 * executes the shipped files against real Postgres, but it runs in
 * `database-integration-tests`, which is `continue-on-error: true` in
 * `pr-test.yml` — advisory, not a merge gate. Without this file two
 * irreversible data repairs would land with no blocking automated coverage.
 *
 * The pins encode decisions, each of which a plausible edit would undo:
 *
 *  - `IS DISTINCT FROM` narrowed to `<>` drops the rows projected before the
 *    status column existed, which hold NULL and are the same defect;
 *  - dropping the `organization_id` join term repairs one org's row from
 *    another org's source;
 *  - dropping `entity_type` lets a row keyed on an artifact id under a
 *    different corpus be stamped with that artifact's status;
 *  - assigning anything but `status` — `updated_at` above all — re-ranks every
 *    repaired row and moves it under the `since`/`until` and `updated:`
 *    predicates, for a change no user made (PLN-2065 §8);
 *  - splitting selection from the write reopens the READ COMMITTED window the
 *    single `MATERIALIZED` snapshot closes (the ISS-8517 review finding);
 *  - dropping the `seen_status` re-check overwrites a value the ISS-9938
 *    triggers wrote between snapshot and write with the older one;
 *  - dropping `lock_timeout` lets the repair wait indefinitely behind a row
 *    lock, wedging `migrate deploy` and every deploy queued behind it.
 *
 * The header's pre-deploy count and its drain are pinned against the same
 * conjuncts as the executable statement, because a header that drifts hands an
 * operator a query for a DIFFERENT population than the migration repairs — and
 * neither population was measured against production when this was authored,
 * so those two queries are all the operator has.
 *
 * Reads declarative migration.sql DDL only — never implementation source.
 */

const DOCUMENT_MIGRATION =
  "20260921151607_iss9938_search_document_document_status_repair";
const LOOP_MIGRATION =
  "20260921151657_iss9938_search_document_loop_status_repair";

const WHITESPACE_G = /\s+/g;
const ROW_DESTRUCTION_RE = /\b(DELETE|TRUNCATE|INSERT)\b/i;
const SCHEMA_CHANGE_RE = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

/**
 * Every `SET` clause in a file, captured between `SET` and `FROM`. Captured as
 * whole clauses rather than per-assignment: a `/SET "col" =/g` scan sees only
 * the FIRST target, because the second assignment in `SET "a" = …, "b" = …`
 * has no `SET` before it. Case-sensitive, so `set_config` is not a match.
 */
const SET_CLAUSE_G = /SET\s+(.+?)\s+FROM\s/g;

type RepairMigration = {
  corpus: string;
  migration: string;
  /**
   * The repair, whole. Held as ONE constant rather than asserted clause by
   * clause because the safety argument is that these parts appear TOGETHER:
   * separate `toContain` calls would still pass if an edit split them across
   * two statements, which is the split that reopens the snapshot window.
   */
  statement: string;
  /** The conjuncts that decide which rows are repaired. */
  conjuncts: string[];
  /**
   * Where the drain's region ends. Per file rather than shared: only the
   * document header follows its drain with prose, and a marker that is absent
   * must fail loudly rather than widen the region to the rest of the file.
   */
  drainEnd: string;
  sibling: string;
};

const REPAIRS: RepairMigration[] = [
  {
    corpus: "document",
    migration: DOCUMENT_MIGRATION,
    statement:
      "WITH candidates AS MATERIALIZED ( " +
      'SELECT sd."id", sd."status" AS seen_status, a."status" AS source_status ' +
      'FROM "search_document" AS sd ' +
      'JOIN "artifacts" AS a ' +
      'ON a."id" = sd."entity_id" ' +
      'AND a."organization_id" = sd."organization_id" ' +
      "WHERE sd.\"entity_type\" = 'document' " +
      'AND sd."status" IS DISTINCT FROM a."status" ' +
      "LIMIT max_inline_rows + 1 " +
      "), repaired AS ( " +
      'UPDATE "search_document" AS sd ' +
      'SET "status" = c."source_status" ' +
      "FROM candidates AS c " +
      'WHERE sd."id" = c."id" ' +
      'AND sd."status" IS NOT DISTINCT FROM c."seen_status" ' +
      'RETURNING sd."id" ' +
      ") " +
      "SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM repaired) " +
      "INTO stale_selected, stale_written;",
    conjuncts: [
      "sd.\"entity_type\" = 'document'",
      'sd."status" IS DISTINCT FROM a."status"',
      'a."organization_id" = sd."organization_id"',
    ],
    drainEnd: "Because this is idempotent",
    sibling: LOOP_MIGRATION,
  },
  {
    corpus: "loop",
    migration: LOOP_MIGRATION,
    statement:
      "WITH candidates AS MATERIALIZED ( " +
      'SELECT sd."id", sd."status" AS seen_status, l."status"::text AS source_status ' +
      'FROM "search_document" AS sd ' +
      'JOIN "loops" AS l ' +
      'ON l."id" = sd."entity_id" ' +
      'AND l."organization_id" = sd."organization_id" ' +
      "WHERE sd.\"entity_type\" = 'loop' " +
      'AND sd."status" IS DISTINCT FROM l."status"::text ' +
      "LIMIT max_inline_rows + 1 " +
      "), repaired AS ( " +
      'UPDATE "search_document" AS sd ' +
      'SET "status" = c."source_status" ' +
      "FROM candidates AS c " +
      'WHERE sd."id" = c."id" ' +
      'AND sd."status" IS NOT DISTINCT FROM c."seen_status" ' +
      'RETURNING sd."id" ' +
      ") " +
      "SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM repaired) " +
      "INTO stale_selected, stale_written;",
    conjuncts: [
      "sd.\"entity_type\" = 'loop'",
      'sd."status" IS DISTINCT FROM l."status"::text',
      'l."organization_id" = sd."organization_id"',
    ],
    drainEnd: "DO $iss9938_loop$",
    sibling: DOCUMENT_MIGRATION,
  },
];

for (const repair of REPAIRS) {
  describe(`${repair.migration} migration SQL`, () => {
    it("repairs with exactly the shipped single-snapshot statement", () => {
      expect(normalized(repair.migration)).toContain(repair.statement);
    });

    it("assigns status and nothing else", () => {
      const clauses = [
        ...normalized(repair.migration).matchAll(SET_CLAUSE_G),
      ].map((match) => match[1]);
      expect(clauses).toEqual(['"status" = c."source_status"']);
    });

    it("never destroys or restructures rows", () => {
      const ddl = migrationDdl(repair.migration);
      expect(ROW_DESTRUCTION_RE.test(ddl)).toBe(false);
      expect(SCHEMA_CHANGE_RE.test(ddl)).toBe(false);
    });

    it("bounds the rows one transaction may lock, and aborts above it", () => {
      const ddl = normalized(repair.migration);
      expect(ddl).toContain("max_inline_rows CONSTANT bigint := 250000");
      // Against SELECTED, not WRITTEN: selected is what describes how many rows
      // the statement was willing to lock.
      expect(ddl).toContain("IF stale_selected > max_inline_rows THEN");
      expect(ddl).toContain("RAISE EXCEPTION");
    });

    it("bounds how long it will wait for a row lock", () => {
      // Postgres defaults lock_timeout to 0. Without this the repair waits
      // indefinitely behind an open status write or the manual backfill, and a
      // parked `migrate deploy` holds withMigrationSerializeLock while it does.
      expect(normalized(repair.migration)).toContain(
        "PERFORM set_config('lock_timeout', '5s', true);"
      );
    });

    it("puts the recovery steps in the RAISE MESSAGE, not only the HINT", () => {
      // `migrate-deploy-recovery.ts` parses P0001 output for the first LINE of
      // `Database error:`. Postgres carries HINT as a separate field, so a
      // hint-only remedy can be dropped before an operator sees it.
      const raw = rawMigrationSql(repair.migration);
      const message = raw.slice(
        raw.indexOf("RAISE EXCEPTION"),
        raw.indexOf("USING HINT")
      );
      expect(message).toContain("prisma migrate resolve --rolled-back");
      expect(message).toContain(repair.migration);
      expect(message).toContain("batched drain");
      // The message names its OWN migration to resolve; naming the sibling
      // would send the operator at a migration that did commit.
      expect(message).not.toContain(repair.sibling);
    });

    it("carries a pre-deploy count and a drain whose predicate matches the repair", () => {
      // Neither population was measured against production, so the count query
      // is the operator's only way to know whether the ceiling will fire, and
      // the drain is the only way past it. Both live in comments, so
      // `migrationDdl` cannot see them — and a header that drifts from the
      // statement hands an operator a query for a DIFFERENT population.
      const header = rawMigrationSql(repair.migration).replace(
        WHITESPACE_G,
        " "
      );
      const countQuery = between(
        repair.migration,
        header,
        "SELECT count(*)",
        ";"
      );
      const drain = between(
        repair.migration,
        header,
        String.raw`\set batch`,
        repair.drainEnd
      );

      expect(drain).toContain("FOR UPDATE OF sd SKIP LOCKED");
      // The drain writes the same value the statement does, no wider, and keeps
      // the same re-check.
      expect(drain).toContain('SET "status" = stale."source_status"');
      expect(drain).toContain(
        'AND sd."status" IS NOT DISTINCT FROM stale."seen_status"'
      );
      for (const conjunct of repair.conjuncts) {
        expect(countQuery).toContain(conjunct);
        expect(drain).toContain(conjunct);
        // And the executable statement itself, so all three genuinely agree.
        expect(normalized(repair.migration)).toContain(conjunct);
      }
    });
  });
}

/** The header's pre-deploy count and drain live in comments, so read raw. */
function rawMigrationSql(migration: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      migration,
      "migration.sql"
    ),
    "utf8"
  );
}

function normalized(migration: string): string {
  return migrationDdl(migration).replace(WHITESPACE_G, " ").trim();
}

/**
 * The slice of a header between two markers. Throws rather than returning an
 * empty string when either marker is absent, so a renamed header section fails
 * the assertion instead of vacuously satisfying every `toContain` against "".
 */
function between(
  migration: string,
  source: string,
  start: string,
  end: string
): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from === -1 || to === -1) {
    throw new Error(`${migration}: header section ${start}…${end} not found`);
  }
  return source.slice(from, to);
}
