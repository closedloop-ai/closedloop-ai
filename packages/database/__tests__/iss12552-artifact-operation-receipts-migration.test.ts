import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  migrationDdl,
  type ParsedIndexStatement,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-12552: the receipt table that ties an API-key write to the transcript
 * call that made it. An index changes plan choice, never results, so the
 * reconcile suites stay green on a missing or reordered index; this file pins
 * each index on its own statement. Reads declarative migration.sql only.
 */
const MIGRATION = "20261023030100_iss12552_artifact_operation_receipts";
const TABLE = "artifact_operation_receipts";

function statementNamed(name: string): ParsedIndexStatement {
  const match = scanCreateIndexStatements(MIGRATION).find(
    (statement) => statement.name === name
  );
  if (!match) {
    throw new Error(`${MIGRATION} has no index named ${name}`);
  }
  return match;
}

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly three indexes", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(3);
    expect(scanCreateIndexStatements(MIGRATION)).toHaveLength(3);
  });

  it("seeks a claim's receipt by org, owner, then harness call id", () => {
    const index = statementNamed("artifact_operation_receipts_call_id_idx");

    expect(index.table).toBe(TABLE);
    // Org and owner lead, so a call id lifted from another tenant or user can
    // never reach that receipt through this seek.
    expect(index.keys).toEqual([
      "organization_id",
      "principal_user_id",
      "client_call_id",
    ]);
    expect(index.unique).toBe(false);
    expect(index.predicate).toBeNull();
  });

  it("seeks the fingerprint fallback inside a time window", () => {
    const index = statementNamed("artifact_operation_receipts_fingerprint_idx");

    expect(index.table).toBe(TABLE);
    expect(index.keys).toEqual([
      "organization_id",
      "principal_user_id",
      "request_fingerprint",
      "requested_at",
    ]);
    expect(index.unique).toBe(false);
    expect(index.predicate).toBeNull();
  });

  it("keeps one rejected receipt per owner and call id", () => {
    const index = statementNamed(
      "artifact_operation_receipts_rejected_call_key"
    );

    expect(index.table).toBe(TABLE);
    expect(index.unique).toBe(true);
    expect(index.keys).toEqual([
      "organization_id",
      "principal_user_id",
      "client_call_id",
    ]);
    // Only rejected rows that carry a call id are deduplicated; committed and
    // no-op receipts for the same call are never blocked by this key.
    expect(index.predicate).toBe(
      "((outcome = 'rejected'::text) AND (client_call_id IS NOT NULL))"
    );
  });
});
