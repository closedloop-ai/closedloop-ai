import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const columnMigration =
  "20261023030105_iss12552_operation_evidence_contested_receipt";
const indexMigration =
  "20261023030106_iss12552_operation_evidence_contested_receipt_index";
const indexName = "agent_session_operation_evidence_contested_receipt_idx";

describe("operation evidence contested receipt (ISS-12552)", () => {
  it("adds the column and no index in the column migration", () => {
    expect(migrationDdl(columnMigration).match(ANY_CREATE_INDEX_G)).toBeNull();
  });

  it("indexes only the claims that contest a receipt", () => {
    const index = indexNamed(indexMigration, indexName);
    expect(index.table).toBe("agent_session_operation_evidence");
    expect(index.keys).toEqual(["contested_receipt_id"]);
    expect(index.predicate).toBe("(contested_receipt_id IS NOT NULL)");
    expect(migrationDdl(indexMigration).match(ANY_CREATE_INDEX_G)).toHaveLength(
      1
    );
  });

  it("builds concurrently without accepting an invalid prior index or a transaction wrapper", () => {
    const index = indexNamed(indexMigration, indexName);
    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
    expect(
      migrationDdl(indexMigration).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});
