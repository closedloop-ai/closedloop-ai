import { describe, expect, it } from "vitest";
import { migrationsToPrestampForPreview } from "../scripts/preview-heavy-migrations";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20261003195257_iss10994_activity_v1_action_cursor_actor";
const indexName = "artifact_activity_v1_action_cursor_actor_idx";

describe("ISS-10994 V1 activity edit cursor index", () => {
  it("covers the scoped action read, keyset order, and actor admission", () => {
    const index = indexNamed(migration, indexName);
    expect(index.table).toBe("artifact_activity_events");
    expect(index.keys).toEqual([
      "organization_id",
      "artifact_id",
      "action",
      "created_at DESC",
      "id DESC",
      "actor_type",
    ]);
    expect(index.method).toBe("btree");
    expect(index.predicate).toBeNull();
    expect(migrationDdl(migration).match(ANY_CREATE_INDEX_G)).toHaveLength(1);
  });

  it("builds without blocking receipt writes or accepting an invalid prior index", () => {
    const index = indexNamed(migration, indexName);
    expect(index.concurrently).toBe(true);
    expect(index.ifNotExists).toBe(false);
    expect(
      migrationDdl(migration).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
    expect(
      migrationsToPrestampForPreview("preview_iss10994", {
        freshSchema: true,
      })
    ).toContain(migration);
  });
});
