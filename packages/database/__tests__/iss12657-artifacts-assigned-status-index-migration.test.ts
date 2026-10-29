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
 * ISS-12657 — the partial index the My Tasks anchor scan reads when a STATUS
 * facet is active (`resolveTreeAnchors` → `anchorStatusSql`). An index changes
 * plan choice, never results, so neither the facet suite nor the heavy-migration
 * preview goes red when this DDL is wrong: both stay green on a reordered key
 * list or a dropped `WHERE`.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20261021020000_iss12657_artifacts_assigned_status_index";

/** A pin: also the `map:` in `schema.prisma`. */
const INDEX = "artifacts_org_assignee_status_created_id_idx";

/**
 * `status` sits between the equality columns and the ordering keys. Ahead of
 * `organization_id`/`assignee_id` it would lose the tenant scope; behind
 * `created_at` it would narrow nothing, because a btree cannot seek on a key the
 * ordering keys already consumed.
 */
const ORDERED_KEYS = [
  "organization_id",
  "assignee_id",
  "status",
  "created_at DESC",
  "id DESC",
];

/**
 * Postgres's normalized form, which is also the `raw(...)` in schema.prisma.
 * The anchor SQL inlines the same `'SESSION'::"ArtifactType"` literal so the
 * planner can prove it; a bound parameter would not.
 */
const PREDICATE = `(type <> 'SESSION'::"ArtifactType")`;

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes artifacts with the status facet ahead of the ordering keys", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("artifacts");
    expect(index.keys).toEqual(ORDERED_KEYS);
    expect(index.method).toBe("btree");
  });

  it("is partial on exactly the session exclusion", () => {
    expect(indexNamed(MIGRATION, INDEX).predicate).toBe(PREDICATE);
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // artifacts takes every session ingest write; a plain build blocks them.
    expect(index.concurrently).toBe(true);
    // A retry over an INVALID remnant of a cancelled build must fail closed.
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
