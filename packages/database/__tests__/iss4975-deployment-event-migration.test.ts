import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260803120000_iss4975_deployment_event_history";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const CREATE_TABLE_RE = /CREATE TABLE "deployment_events" \(([\s\S]*?)\n\);/;
const UNIQUE_INDEX_RE = /CREATE UNIQUE INDEX[^;]*"deployment_events"[^;]*;/g;
const ANY_INDEX_RE = /CREATE (?:UNIQUE )?INDEX[^;]*"deployment_events"[^;]*;/g;
const ORG_FK_RE =
  /ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_organization_id_fkey"[^;]*;/;

describe("ISS-4975 deployment-event history migration", () => {
  it("creates the history table with a primary key", async () => {
    const createTable = await readCreateTable();

    expect(createTable).toContain(
      'CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")'
    );
  });

  it.each([
    ['"organization_id" UUID NOT NULL'],
    ['"source" VARCHAR(32) NOT NULL'],
    ['"external_deployment_id" VARCHAR(200) NOT NULL'],
    ['"external_event_id" VARCHAR(200) NOT NULL'],
    ['"state" VARCHAR(32) NOT NULL'],
    ['"provider_state" VARCHAR(64) NOT NULL'],
    ['"occurred_at" TIMESTAMP(3) NOT NULL'],
  ])("declares %s so the dedupe/ordering key can never be null", async (definition) => {
    const createTable = await readCreateTable();

    expect(createTable).toContain(definition);
  });

  it.each([
    ['"environment_url" TEXT'],
    ['"sha" TEXT'],
    ['"project_id" UUID'],
    ['"repository_id" UUID'],
    ['"branch_artifact_id" UUID'],
    ['"deployment_created_at" TIMESTAMP(3)'],
  ])("keeps %s nullable", async (definition) => {
    const createTable = await readCreateTable();

    expect(createTable).toContain(`    ${definition},`);
  });

  it("keys the only unique index on the three non-nullable identity columns", async () => {
    const sql = await readMigration();
    const uniqueIndexes = sql.match(UNIQUE_INDEX_RE) ?? [];

    expect(uniqueIndexes).toHaveLength(1);
    expect(uniqueIndexes[0]).toContain(
      '"deployment_events"("organization_id", "source", "external_event_id")'
    );
    // A nullable column in the identity would let ON CONFLICT DO NOTHING through
    // and double-count deployments.
    for (const nullableColumn of [
      "environment_url",
      "sha",
      "branch_artifact",
    ]) {
      expect(uniqueIndexes[0]).not.toContain(nullableColumn);
    }
  });

  it("creates no read index, because this migration ships no reader", async () => {
    const indexes = (await readExecutableSql()).match(ANY_INDEX_RE) ?? [];

    // packages/database/AGENTS.md: an index needs a concrete CURRENT access
    // path. The dedupe unique index has one (the ingest ON CONFLICT target);
    // the DORA read indexes belong to the PR that adds the DORA queries, sized
    // to the predicates those queries actually filter and order on.
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toContain("CREATE UNIQUE INDEX");
  });

  it("cascades only the tenant foreign key and adds no others", async () => {
    const sql = await readMigration();
    const orgFk = ORG_FK_RE.exec(sql)?.[0];

    expect(orgFk).toBeDefined();
    expect(orgFk).toContain('REFERENCES "organizations"("id")');
    expect(orgFk).toContain("ON DELETE CASCADE");
    // History must survive deletion of the mutable records it describes, so no
    // artifact/project/repository FK may be introduced.
    expect(sql.match(/ADD CONSTRAINT/g) ?? []).toHaveLength(1);
  });

  it("is purely additive — it alters no pre-existing table", async () => {
    const statements = await readExecutableSql();

    expect(statements).not.toContain("DROP ");
    expect(statements).not.toContain('ALTER TABLE "artifacts"');
    expect(statements).not.toContain('ALTER TABLE "deployment_detail"');
  });
});

async function readMigration(): Promise<string> {
  return await readFile(MIGRATION_PATH, "utf8");
}

/**
 * The migration with its `--` comment lines removed, so a phrase quoted inside
 * the rationale header cannot satisfy an assertion about executable SQL.
 */
async function readExecutableSql(): Promise<string> {
  const sql = await readMigration();
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

async function readCreateTable(): Promise<string> {
  const sql = await readMigration();
  const statement = CREATE_TABLE_RE.exec(sql)?.[0];
  if (!statement) {
    throw new Error("ISS-4975 deployment_events CREATE TABLE is missing");
  }
  return statement;
}
