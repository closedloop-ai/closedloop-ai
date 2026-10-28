import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME =
  "20260818150000_iss6983_github_connection_token_nullable";
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
 * Anything that would touch stored rows. This migration must be pure DDL:
 * every existing cipher stays exactly as it is.
 */
const ROW_MUTATION_RE = /\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i;

describe("ISS-6983 github_user_connections token-nullable migration", () => {
  it("drops NOT NULL on the stored access token, and only that", async () => {
    // PLN-1742 M1 turns the row into a token-less REGISTRY entry when the
    // credential lives in Clerk, so the cipher column has to admit null.
    const statements = await readStatements();

    expect(statements).toEqual([
      'ALTER TABLE "github_user_connections" ALTER COLUMN "access_token_encrypted" DROP NOT NULL',
    ]);
  });

  it("never re-adds the constraint and never rewrites a stored row", async () => {
    // A later edit that re-tightened the column would strand every registry
    // row the Clerk lane wrote; one that touched rows would be rewriting
    // encrypted credentials during a schema migration.
    const sql = await readMigrationSql();

    expect(sql).not.toContain("SET NOT NULL");
    expect(sql).not.toMatch(ROW_MUTATION_RE);
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
