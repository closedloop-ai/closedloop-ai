import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * ISS-7209: `custom_field_settings` and `custom_field_values` address their
 * subject as (`entity_type`, `entity_id`), so no foreign key and no
 * ON DELETE CASCADE can reach them when the artifact goes away. The reaping
 * trigger is the only thing standing between an artifact delete and rows that
 * outlive their subject on a reusable uuid.
 */
describe.skipIf(!DATABASE_URL)("ISS-7209 custom-field orphan cleanup", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("installs the statement-level reaping trigger on artifacts", async () => {
    const trigger = await client.query<{
      tgname: string;
      is_statement: boolean;
    }>(`
        SELECT tgname, (tgtype & 1) = 0 AS is_statement
        FROM pg_trigger
        WHERE tgname = 'artifacts_reap_custom_field_rows'
          AND NOT tgisinternal
      `);
    // Statement-level, not FOR EACH ROW: the retention sweeps delete in bulk.
    expect(trigger.rows).toEqual([
      { tgname: "artifacts_reap_custom_field_rows", is_statement: true },
    ]);
  });

  it("reaps SESSION and BRANCH rows when the artifact is deleted, and spares PROJECT", async () => {
    const orgId = await seedOrganization(client);
    const sessionArtifactId = await seedArtifact(client, orgId);
    const branchArtifactId = await seedArtifact(client, orgId);
    const customFieldId = await seedCustomField(client, orgId);
    // PROJECT does not address `artifacts.id`, so it is the control: a row
    // whose entity_id happens to be absent from `artifacts` must survive.
    const projectId = randomUUID();

    for (const [entityType, entityId] of [
      ["SESSION", sessionArtifactId],
      ["BRANCH", branchArtifactId],
      ["PROJECT", projectId],
    ] as const) {
      await seedCustomFieldRows(client, {
        customFieldId,
        orgId,
        entityType,
        entityId,
      });
    }

    // One bulk DELETE, the shape the retention sweeps use.
    await client.query("DELETE FROM artifacts WHERE id = ANY($1::uuid[])", [
      [sessionArtifactId, branchArtifactId],
    ]);

    const values = await client.query<{ entity_type: string }>(
      "SELECT entity_type FROM custom_field_values WHERE custom_field_id = $1",
      [customFieldId]
    );
    const settings = await client.query<{ entity_type: string }>(
      "SELECT entity_type FROM custom_field_settings WHERE custom_field_id = $1",
      [customFieldId]
    );

    expect(values.rows.map((row) => row.entity_type)).toEqual(["PROJECT"]);
    expect(settings.rows.map((row) => row.entity_type)).toEqual(["PROJECT"]);
  });

  /**
   * The trigger only reaps rows an artifact DELETE passes through it, so it can
   * do nothing about the orphans that deletions BEFORE it existed already left
   * behind. Clearing those is the migration's two backfill DELETEs, and they are
   * destructive and irreversible — the case above proves the ongoing trigger
   * against a database where the migration has already run, and would stay green
   * if the backfill were deleted from the file entirely.
   *
   * So this one seeds an orphan the trigger provably cannot have touched (no
   * artifact is ever deleted here; the rows are born pointing at a uuid that was
   * never in `artifacts`), re-applies the migration inside the test transaction,
   * and asserts the orphan is gone. Re-applying is safe and is what the shipped
   * file does on a fresh database: `CREATE OR REPLACE FUNCTION` plus
   * `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, and the DELETEs are
   * idempotent. The `afterEach` ROLLBACK undoes the DDL with everything else.
   */
  it("clears pre-existing orphans when migration 20260820140000 is applied", async () => {
    const orgId = await seedOrganization(client);
    const customFieldId = await seedCustomField(client, orgId);
    // Never inserted into `artifacts` — this is what a row left behind by a
    // deletion that predates the trigger looks like.
    const vanishedArtifactId = randomUUID();
    const projectId = randomUUID();

    for (const [entityType, entityId] of [
      ["DOCUMENT", vanishedArtifactId],
      ["SESSION", vanishedArtifactId],
      ["BRANCH", vanishedArtifactId],
      // PROJECT ids live in `projects`, never in `artifacts`, so a PROJECT row
      // is an orphan by the backfill's own predicate if its entity-type filter
      // is dropped. It is the control that catches an over-broad DELETE.
      ["PROJECT", projectId],
    ] as const) {
      await seedCustomFieldRows(client, {
        customFieldId,
        orgId,
        entityType,
        entityId,
      });
    }

    await client.query(readOrphanCleanupMigrationSql());

    const values = await client.query<{ entity_type: string }>(
      "SELECT entity_type FROM custom_field_values WHERE custom_field_id = $1",
      [customFieldId]
    );
    const settings = await client.query<{ entity_type: string }>(
      "SELECT entity_type FROM custom_field_settings WHERE custom_field_id = $1",
      [customFieldId]
    );

    // All three artifact-backed orphans reaped, the PROJECT control untouched.
    expect(values.rows.map((row) => row.entity_type)).toEqual(["PROJECT"]);
    expect(settings.rows.map((row) => row.entity_type)).toEqual(["PROJECT"]);
  });
});

/** The shipped ISS-7209 migration, read from the file the deploy applies. */
function readOrphanCleanupMigrationSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      "20260820140000_iss7209_custom_field_artifact_orphan_cleanup",
      "migration.sql"
    ),
    "utf8"
  );
}

async function seedCustomFieldRows(
  client: Client,
  row: {
    customFieldId: string;
    orgId: string;
    entityType: string;
    entityId: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO custom_field_values
         (id, custom_field_id, organization_id, entity_type, entity_id,
          multi_enum_value_ids, people_value_ids, updated_at)
       VALUES ($1, $2, $3, $4::"CustomFieldEntityType", $5,
               ARRAY[]::uuid[], ARRAY[]::uuid[], now())`,
    [randomUUID(), row.customFieldId, row.orgId, row.entityType, row.entityId]
  );
  await client.query(
    `INSERT INTO custom_field_settings
         (id, custom_field_id, organization_id, entity_type, entity_id)
       VALUES ($1, $2, $3, $4::"CustomFieldEntityType", $5)`,
    [randomUUID(), row.customFieldId, row.orgId, row.entityType, row.entityId]
  );
}

async function seedOrganization(client: Client): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, `iss7209-${id}`, `iss7209-${id}`, `iss7209-${id}`]
  );
  return id;
}

async function seedArtifact(client: Client, orgId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_at, updated_at)
     VALUES ($1, $2, 'SESSION'::"ArtifactType", $3, 'active', now(), now())`,
    [id, orgId, `iss7209-${id}`]
  );
  return id;
}

async function seedCustomField(client: Client, orgId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO custom_fields
       (id, organization_id, name, field_type, created_by_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'NUMBER'::"CustomFieldType", NULL, now(), now())`,
    [id, orgId, `iss7209-${id}`]
  );
  return id;
}
