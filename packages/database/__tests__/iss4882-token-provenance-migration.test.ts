import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260802170000_iss4882_cloud_token_event_provenance";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const TOKEN_EVENT_ALTER_RE =
  /ALTER TABLE "agent_session_token_events"([\s\S]*?);/;

describe("ISS-4882 cloud token provenance migration", () => {
  it("makes estimated cost nullable without rewriting legacy values", async () => {
    const statement = await readTokenEventAlter();

    expect(statement).toContain('ALTER COLUMN "estimated_cost" DROP DEFAULT');
    expect(statement).toContain('ALTER COLUMN "estimated_cost" DROP NOT NULL');
    expect(statement).not.toContain("UPDATE ");
  });

  it.each([
    ['"source_identity" JSONB'],
    ['"cost_completeness" TEXT'],
    ['"cost_completeness_reason" TEXT'],
    ['"subscription_equivalent_cost" DECIMAL(14,6)'],
    ['"api_estimated_cost" DECIMAL(14,6)'],
  ])("adds nullable column %s", async (definition) => {
    const statement = await readTokenEventAlter();

    expect(statement).toContain(`ADD COLUMN ${definition}`);
    expect(definition).not.toContain("NOT NULL");
  });
});

async function readTokenEventAlter(): Promise<string> {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  const statement = TOKEN_EVENT_ALTER_RE.exec(sql)?.[0];
  if (!statement) {
    throw new Error("ISS-4882 token-event ALTER TABLE statement is missing");
  }
  return statement;
}
