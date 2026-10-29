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
 * ISS-12775 — the covering index the Branches list Collaborator identity reads
 * live comments through. An index changes plan choice, never results, so no
 * behavioural suite goes red when this DDL is wrong.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20261021040000_iss12775_comments_thread_live_cover_index";

/** A pin: also the `map:` in `schema.prisma`. */
const INDEX = "comments_thread_live_cover_idx";

/**
 * The PR-comment read probes `thread_id` then `id`; the branch, session and
 * direct reads probe `thread_id`. `created_at` and `author_id` are the columns
 * they read beyond those, so all four stay index-only.
 */
const ORDERED_KEYS = ["thread_id", "id", "created_at", "author_id"];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("covers live comments in probe-then-payload key order", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("comments");
    expect(index.keys).toEqual(ORDERED_KEYS);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBe('"deleted_at" IS NULL');
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
