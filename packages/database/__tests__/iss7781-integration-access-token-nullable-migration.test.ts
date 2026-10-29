import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME =
  "20260911180000_iss7781_integration_access_token_nullable";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

const LINE_COMMENT_RE = /^\s*--.*$/gm;
const WHITESPACE_RUN_RE = /\s+/g;
/**
 * Anything that would touch stored rows. This migration must be pure DDL: a
 * live OAuth credential is the thing in these columns, and clearing one here
 * would log users out of the integration before the write path had a chance to
 * re-encrypt the row.
 */
const ROW_MUTATION_RE = /\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i;

describe("ISS-7781 integration access-token nullable migration", () => {
  it("drops NOT NULL on both live integrations' plaintext token, and only that", async () => {
    // The encrypted-token migration could not converge while `access_token` was
    // NOT NULL: every connect and refresh had to re-populate it, so each
    // backfill run was undone by the next refresh. Widening the column is what
    // lets a successful encrypt CLEAR the plaintext instead.
    const statements = await readStatements();

    expect(statements).toEqual([
      'ALTER TABLE "linear_integrations" ALTER COLUMN "access_token" DROP NOT NULL',
      'ALTER TABLE "google_integrations" ALTER COLUMN "access_token" DROP NOT NULL',
    ]);
  });

  it("never re-tightens the constraint and never rewrites a stored row", async () => {
    // A later edit that re-added NOT NULL would make every encrypted-only row
    // unwritable; one that touched rows would be mutating live credentials
    // during a schema migration.
    const sql = await readMigrationSql();

    expect(sql).not.toContain("SET NOT NULL");
    expect(sql).not.toMatch(ROW_MUTATION_RE);
  });

  /**
   * The plaintext columns were, at this migration, the pre-migration read
   * fallback in `resolveIntegrationToken` (later removed), and rows that
   * predated the cutover held their only credential there. Dropping either
   * column is a separately approved later step, and doing it here would lock
   * those orgs out of the integration.
   */
  it("does not drop the legacy columns the reader still falls back to", async () => {
    const sql = await readMigrationSql();

    expect(sql).not.toContain("DROP COLUMN");
  });
});

async function readMigrationSql(): Promise<string> {
  return await readFile(MIGRATION_PATH, "utf8");
}

async function readStatements(): Promise<string[]> {
  const sql = await readMigrationSql();
  return sql
    .replace(LINE_COMMENT_RE, "")
    .split(";")
    .map((statement) => statement.replace(WHITESPACE_RUN_RE, " ").trim())
    .filter((statement) => statement.length > 0);
}
