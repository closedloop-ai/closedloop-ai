import { randomUUID } from "node:crypto";
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
 * Focused behavior tests for the two enum migrations
 * (`packages/database/AGENTS.md`: every migration adding an enum value ships
 * one). Service-level tests mock `@repo/database` and so cannot see whether the
 * value actually reached the PostgreSQL type — these write the value through a
 * real column, which is the only thing that catches schema/SQL drift.
 */
describe.skipIf(!DATABASE_URL)("ISS-7209 / ISS-7210 enum migrations", () => {
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

  it("adds SESSION and BRANCH to CustomFieldEntityType without disturbing the existing members", async () => {
    const labels = await enumLabels(client, "CustomFieldEntityType");

    expect(labels).toEqual(
      expect.arrayContaining(["SESSION", "BRANCH", "PROJECT", "DOCUMENT"])
    );
  });

  it("adds DURATION to NumberFormat without disturbing the existing members", async () => {
    const labels = await enumLabels(client, "NumberFormat");

    expect(labels).toEqual(expect.arrayContaining(["DURATION", "NONE"]));
  });

  it("stores a DURATION field carrying SESSION and BRANCH values", async () => {
    const orgId = await seedOrganization(client);
    const fieldId = randomUUID();
    await client.query(
      `INSERT INTO custom_fields
         (id, organization_id, name, field_type, number_format, entity_types,
          created_at, updated_at)
       VALUES ($1, $2, $3, 'NUMBER'::"CustomFieldType",
               'DURATION'::"NumberFormat",
               ARRAY['SESSION','BRANCH']::"CustomFieldEntityType"[],
               now(), now())`,
      [fieldId, orgId, `iss7210-${fieldId}`]
    );

    for (const entityType of ["SESSION", "BRANCH"] as const) {
      await client.query(
        `INSERT INTO custom_field_values
           (id, custom_field_id, organization_id, entity_type, entity_id,
            number_value, multi_enum_value_ids, people_value_ids, updated_at)
         VALUES ($1, $2, $3, $4::"CustomFieldEntityType", $5, $6,
                 ARRAY[]::uuid[], ARRAY[]::uuid[], now())`,
        [randomUUID(), fieldId, orgId, entityType, randomUUID(), 3_600_000]
      );
    }

    const stored = await client.query<{
      entity_type: string;
      number_value: string;
    }>(
      `SELECT entity_type, number_value
       FROM custom_field_values
       WHERE custom_field_id = $1
       ORDER BY entity_type::text`,
      [fieldId]
    );

    // Milliseconds is the declared canonical unit, so the column must return
    // the span unchanged rather than a rounded or rescaled one.
    expect(stored.rows).toEqual([
      { entity_type: "BRANCH", number_value: 3_600_000 },
      { entity_type: "SESSION", number_value: 3_600_000 },
    ]);
  });
});

async function enumLabels(client: Client, typeName: string): Promise<string[]> {
  const result = await client.query<{ label: string }>(
    `SELECT e.enumlabel AS label
     FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = $1
     ORDER BY e.enumsortorder`,
    [typeName]
  );
  return result.rows.map((row) => row.label);
}

async function seedOrganization(client: Client): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, `iss7210-${id}`, `iss7210-${id}`, `iss7210-${id}`]
  );
  return id;
}
