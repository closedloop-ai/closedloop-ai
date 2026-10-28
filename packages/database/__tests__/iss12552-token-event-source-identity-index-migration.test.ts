import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20261023030103_iss12552_token_event_source_identity_index";
const indexName = "agent_session_token_events_source_identity_idx";

describe("token event source identity index (ISS-12552)", () => {
  it("hashes the stored source identity, the allocation's jsonb equality lookup", () => {
    const index = indexNamed(migration, indexName);
    expect(index.table).toBe("agent_session_token_events");
    expect(index.keys).toEqual(["source_identity"]);
    expect(index.method).toBe("hash");
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
