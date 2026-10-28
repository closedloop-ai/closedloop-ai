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
 * ISS-7211 — the six facet indexes on `custom_field_values` that back
 * custom-field filtering in the document-list query path.
 *
 * The risk guarded here is a silent change of KEY LIST or ACCESS METHOD: an
 * index that still exists under the same name but no longer serves the predicate
 * reads as healthy everywhere else, because the query degrades to a scan instead
 * of failing. Assertions are scoped to ONE parsed statement each, so a clause
 * satisfied by a sibling index cannot stand in for the object under test.
 *
 * It also pins the two properties that make this migration SAFE TO APPLY, both
 * of which are invisible to every other check in the repo — the DDL is valid,
 * the drift check is green, and the indexes are identical either way. They are
 * pinned because this repo has already shipped the failures once: FEA-3638's
 * plain `CREATE INDEX` blocked writes and stalled the app and had to be
 * reverted, and its `DO $$ … $$` guard forced Prisma's whole-file transaction
 * wrap and failed every environment with SQLSTATE 25001.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME =
  "20260820150000_iss7211_custom_field_value_facet_indexes";

const ddl = () => migrationDdl(MIGRATION_NAME);
const allIndexes = () => parseIndexes(MIGRATION_NAME);
const namedIndex = (name: string) => indexNamed(MIGRATION_NAME, name);

/** Every facet the list query can issue, and the index that must serve it. */
const BTREE_FACET_INDEXES = [
  {
    name: "custom_field_values_custom_field_id_entity_type_text_value_idx",
    column: "text_value",
  },
  {
    name: "custom_field_values_custom_field_id_entity_type_number_valu_idx",
    column: "number_value",
  },
  {
    name: "custom_field_values_custom_field_id_entity_type_date_value_idx",
    column: "date_value",
  },
  {
    name: "custom_field_values_custom_field_id_entity_type_enum_value__idx",
    column: "enum_value_id",
  },
] as const;

const GIN_FACET_INDEXES = [
  {
    name: "custom_field_values_multi_enum_value_ids_idx",
    column: "multi_enum_value_ids",
  },
  {
    name: "custom_field_values_people_value_ids_idx",
    column: "people_value_ids",
  },
] as const;

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly the six facet indexes and nothing else", () => {
    // Counted with a deliberately looser pattern than the parser uses, so a
    // statement the strict parser cannot read cannot vanish from the count.
    expect(ddl().match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(6);
    expect(allIndexes()).toHaveLength(6);
  });

  it.each(BTREE_FACET_INDEXES)(
    "scopes the $column facet to one field with a btree prefix",
    ({ name, column }) => {
      const index = namedIndex(name);
      expect(index.table).toBe("custom_field_values");
      expect(index.method).toBe("btree");
      // Order matters: the equality-tested columns must lead, or the index
      // cannot be used to seek and the facet degrades back to a filtered scan.
      expect(index.keys).toEqual(["custom_field_id", "entity_type", column]);
    }
  );

  it.each(GIN_FACET_INDEXES)(
    "indexes $column with GIN so array overlap can be answered",
    ({ name, column }) => {
      const index = namedIndex(name);
      expect(index.table).toBe("custom_field_values");
      // A btree here would still be a valid index and would silently fail to
      // serve `hasSome` — the exact "healthy-looking but unused" regression.
      expect(index.method).toBe("gin");
      expect(index.keys).toEqual([column]);
    }
  );

  it("builds every index CONCURRENTLY, and fails closed on a retry", () => {
    const indexes = allIndexes();
    expect(indexes).not.toHaveLength(0);
    for (const index of indexes) {
      // A plain `CREATE INDEX` here still produces an identical index, passes
      // the drift check, and passes every other assertion in this file — it just
      // holds a SHARE lock on `custom_field_values` for the whole build and
      // blocks every custom-field write until it finishes. That is what got
      // FEA-3638's first attempt reverted, so it is asserted rather than trusted.
      expect(index.concurrently).toBe(true);
      // And CONCURRENTLY must NOT carry IF NOT EXISTS: a cancelled build leaves
      // an INVALID index of the same name, which IF NOT EXISTS would let a retry
      // skip over — marking the migration applied with a permanently unusable
      // index. Failing closed forces the operator drop-and-rebuild instead.
      expect(index.ifNotExists).toBe(false);
    }
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Prisma
    // splits a migration into per-statement queries UNLESS a statement carries
    // dollar-quoting or embedded semicolons, in which case it wraps the whole
    // file and every CONCURRENTLY statement fails with SQLSTATE 25001. FEA-3638
    // shipped exactly that and failed in CI and prod. Comments are stripped
    // first: the header legitimately DESCRIBES these constructs.
    expect(ddl().match(TRANSACTION_WRAP_TRIGGER_G)).toBeNull();
  });

  it("keeps every index name inside Postgres' identifier limit", () => {
    for (const index of allIndexes()) {
      // A name past 63 chars is truncated SILENTLY, so two long names can
      // collide and the second CREATE fails only when the migration deploys.
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
  });
});
