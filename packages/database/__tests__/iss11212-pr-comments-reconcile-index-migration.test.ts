import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20261001185259_iss11212_pr_comments_reconcile_index";
const indexName = "pull_request_detail_pr_state_comments_reconciled_at_idx";

describe("pull request comment-reconcile due index", () => {
  it("orders open pull requests never reconciled first, then by their last comment reconcile", () => {
    const index = indexNamed(migration, indexName);
    expect(index.table).toBe("pull_request_detail");
    expect(index.keys).toEqual([
      "pr_state",
      "comments_reconciled_at NULLS FIRST",
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

const dueMigration = "20261002161501_iss11212_pr_comments_reconcile_due_index";
const dueIndexName = "pull_request_detail_comments_reconcile_due_idx";

describe("pull request comment-reconcile due-order index", () => {
  it("seeks open pull requests in the due scan's order: last attempt, last reconcile, id", () => {
    const index = indexNamed(dueMigration, dueIndexName);
    expect(index.table).toBe("pull_request_detail");
    expect(index.keys).toEqual([
      "pr_state",
      "comments_reconcile_attempted_at NULLS FIRST",
      "comments_reconciled_at NULLS FIRST",
      "id",
    ]);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBeNull();
    expect(migrationDdl(dueMigration).match(ANY_CREATE_INDEX_G)).toHaveLength(
      1
    );
  });

  it("builds concurrently without accepting an invalid prior index or a transaction wrapper", () => {
    const index = indexNamed(dueMigration, dueIndexName);
    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
    expect(
      migrationDdl(dueMigration).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});
