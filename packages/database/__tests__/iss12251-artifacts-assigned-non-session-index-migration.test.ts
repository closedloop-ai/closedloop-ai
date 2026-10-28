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
 * ISS-12251 — the partial index the My Tasks anchor scan
 * (`assignedNonBranchAnchorsSql`) reads so it never visits an assigned
 * session. An index changes plan choice, never results, so no behavioural
 * suite goes red when this DDL is wrong.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION =
  "20261012120000_iss12251_artifacts_assigned_non_session_index";

/** A pin: also the `map:` in `schema.prisma`. */
const INDEX = "artifacts_org_assignee_created_id_non_session_idx";

/**
 * The anchor SQL filters `organization_id` and `assignee_id` by equality and
 * orders `created_at DESC, id DESC` under a LIMIT; only this exact order and
 * these exact directions let the scan emit rows already sorted.
 */
const ORDERED_KEYS = [
  "organization_id",
  "assignee_id",
  "created_at DESC",
  "id DESC",
];

/**
 * Postgres's normalized form, which is also the `raw(...)` in schema.prisma.
 * The anchor SQL inlines the same `'SESSION'::"ArtifactType"` literal so the
 * planner can prove it.
 */
const PREDICATE = `(type <> 'SESSION'::"ArtifactType")`;

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes artifacts in the anchor scan's equality-then-order key order", () => {
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
