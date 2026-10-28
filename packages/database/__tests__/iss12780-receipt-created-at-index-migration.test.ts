import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20261021040344_iss12780_receipt_created_at_index";
const indexName = "repository_default_observation_receipts_created_at_idx";

describe("repository-default observation receipt retention index", () => {
  it("covers the retention sweep's created_at predicate", () => {
    const index = indexNamed(migration, indexName);
    expect(index.table).toBe("repository_default_observation_receipts");
    expect(index.keys).toEqual(["created_at"]);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBeNull();
    expect(migrationDdl(migration).match(ANY_CREATE_INDEX_G)).toHaveLength(1);
  });

  it("builds concurrently without accepting an invalid prior index or a transaction wrapper", () => {
    const index = indexNamed(migration, indexName);
    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
    expect(
      migrationDdl(migration).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});
