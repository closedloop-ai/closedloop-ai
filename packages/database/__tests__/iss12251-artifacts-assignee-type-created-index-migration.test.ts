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
 * ISS-12251 — the index the My Tasks list (`GET /documents?assigneeId=`) reads
 * once every session carries its Owner as `assignee_id`. An index changes plan
 * choice, never results, so no behavioural suite goes red when this DDL is
 * wrong.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION =
  "20261012170100_iss12251_artifacts_assignee_type_created_index";

/** A pin: also the `map:` in `schema.prisma`. */
const INDEX = "artifacts_org_assignee_type_created_id_idx";

/**
 * The list filters `organization_id`, `assignee_id` and `type` by equality and
 * orders `created_at DESC, id DESC` under a LIMIT; `type` among the equality
 * keys is what keeps a bind-parameter type from scanning the user's sessions.
 */
const ORDERED_KEYS = [
  "organization_id",
  "assignee_id",
  "type",
  "created_at DESC",
  "id DESC",
];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes artifacts in the list's equality-then-order key order, unconditionally", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("artifacts");
    expect(index.keys).toEqual(ORDERED_KEYS);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
  });

  it("keeps the file to bare statements Prisma will not wrap in a transaction", () => {
    expect(
      migrationDdl(MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("names an index Postgres will not silently truncate", () => {
    expect(INDEX.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
