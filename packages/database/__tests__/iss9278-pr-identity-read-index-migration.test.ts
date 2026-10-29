import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20260918175023_iss9278_pr_identity_read_index";
const indexName = "pull_request_detail_org_repo_name_number_idx";

describe("session PR identity read index", () => {
  it("covers adopted and repo-less PR identities with one nonpartial index", () => {
    const index = indexNamed(migration, indexName);
    expect(index.table).toBe("pull_request_detail");
    expect(index.keys).toEqual([
      "organization_id",
      "repository_full_name",
      "number",
    ]);
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
