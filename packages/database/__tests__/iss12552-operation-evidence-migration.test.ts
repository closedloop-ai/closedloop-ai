import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  migrationDdl,
  type ParsedIndexStatement,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-12552: the operation evidence a session synced and the
 * snapshot that records its digest. An index changes plan choice, never
 * results, so the reconcile suites stay green on a missing or reordered index;
 * this file pins each index on its own statement. Reads declarative
 * migration.sql only.
 */
const MIGRATION = "20261023030101_iss12552_operation_evidence";
const EVIDENCE = "agent_session_operation_evidence";
const SNAPSHOT = "agent_session_operation_evidence_snapshots";

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
  it("creates exactly six indexes", () => {
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(6);
    expect(scanCreateIndexStatements(MIGRATION)).toHaveLength(6);
  });

  it("keeps one row per claim of a session", () => {
    const index = statementNamed("agent_session_operation_evidence_claim_key");

    expect(index.table).toBe(EVIDENCE);
    expect(index.unique).toBe(true);
    expect(index.keys).toEqual(["agent_session_id", "claim_key"]);
    expect(index.predicate).toBeNull();
  });

  it("binds a receipt to at most one claim, and leaves unbound claims free", () => {
    const index = statementNamed(
      "agent_session_operation_evidence_receipt_key"
    );

    expect(index.table).toBe(EVIDENCE);
    expect(index.unique).toBe(true);
    expect(index.keys).toEqual(["receipt_id"]);
    expect(index.predicate).toBe("(receipt_id IS NOT NULL)");
  });

  it("seeks the claim a new receipt binds, by org then call id or fingerprint", () => {
    for (const [name, column] of [
      ["agent_session_operation_evidence_call_id_idx", "provider_call_id"],
      [
        "agent_session_operation_evidence_fingerprint_idx",
        "request_fingerprint",
      ],
      ["agent_session_operation_evidence_target_idx", "target_artifact_id"],
    ] as const) {
      const index = statementNamed(name);

      expect(index.table).toBe(EVIDENCE);
      expect(index.unique).toBe(false);
      expect(index.keys).toEqual(["organization_id", column]);
      expect(index.predicate).toBeNull();
    }
  });

  it("indexes the snapshot by organization for the backfill", () => {
    const index = statementNamed(
      "agent_session_operation_evidence_snapshot_org_idx"
    );

    expect(index.table).toBe(SNAPSHOT);
    expect(index.keys).toEqual(["organization_id"]);
  });

  it("removes both with the session", () => {
    const foreignKeys = parseForeignKeys(MIGRATION);

    for (const table of [EVIDENCE, SNAPSHOT]) {
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          table,
          columns: '"agent_session_id"',
          referencedTable: "session_detail",
          referencedColumns: '"artifact_id"',
          actions: expect.stringContaining("ON DELETE CASCADE"),
        })
      );
    }
  });
});
