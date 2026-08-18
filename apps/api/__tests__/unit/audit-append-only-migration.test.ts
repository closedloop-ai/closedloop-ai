/**
 * Migration-SQL contract guard for the audit ledger's append-only trigger
 * (FEA-3856). Prisma cannot express a trigger, so the append-only guard lives in
 * hand-edited migration SQL — and the tamper-evidence property depends entirely
 * on that trigger surviving. This asserts the specific DDL is present so a
 * regeneration or careless edit that drops it fails CI.
 *
 * This is a migration.sql DDL contract guard (reading the declarative migration
 * file), which AGENTS.md explicitly permits — unlike reading schema.prisma or
 * TypeScript source text. Behavior of the trigger is proven separately in the
 * real-Postgres integration suite (__tests__/integration/audit-ledger.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/migrations"
);

const migrationNamePattern = /_fea3856_add_audit_entries$/;
const raiseAppendOnlyPattern = /RAISE EXCEPTION 'audit_entries is append-only/;
const beforeUpdateDeleteTriggerPattern =
  /BEFORE UPDATE OR DELETE ON "audit_entries"[\s\S]*FOR EACH ROW/;
const raiseNoTruncatePattern =
  /RAISE EXCEPTION 'audit_entries is append-only: TRUNCATE is not permitted/;
const beforeTruncateTriggerPattern =
  /BEFORE TRUNCATE ON "audit_entries"[\s\S]*FOR EACH STATEMENT/;

function readAuditMigrationSql(): string {
  const migrationName = readdirSync(migrationsDir).find((entry) =>
    migrationNamePattern.test(entry)
  );
  if (!migrationName) {
    throw new Error("fea3856_add_audit_entries migration missing");
  }
  return readFileSync(
    path.join(migrationsDir, migrationName, "migration.sql"),
    "utf8"
  );
}

describe("audit_entries append-only migration", () => {
  const sql = readAuditMigrationSql();

  it("creates the audit_entries table with the (org, seq) primary key", () => {
    expect(sql).toContain('CREATE TABLE "audit_entries"');
    expect(sql).toContain(
      'CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("organization_id","seq")'
    );
  });

  it("defines the reject-mutation trigger function that RAISEs", () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "audit_entries_reject_mutation"()'
    );
    expect(sql).toMatch(raiseAppendOnlyPattern);
  });

  it("attaches a BEFORE UPDATE OR DELETE row-level trigger", () => {
    expect(sql).toContain('CREATE TRIGGER "audit_entries_append_only"');
    expect(sql).toMatch(beforeUpdateDeleteTriggerPattern);
    expect(sql).toContain('EXECUTE FUNCTION "audit_entries_reject_mutation"()');
  });

  it("defines a statement-level reject-truncate function that RAISEs", () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "audit_entries_reject_truncate"()'
    );
    expect(sql).toMatch(raiseNoTruncatePattern);
  });

  it("attaches a BEFORE TRUNCATE statement-level trigger", () => {
    expect(sql).toContain('CREATE TRIGGER "audit_entries_no_truncate"');
    expect(sql).toMatch(beforeTruncateTriggerPattern);
    expect(sql).toContain('EXECUTE FUNCTION "audit_entries_reject_truncate"()');
  });
});
