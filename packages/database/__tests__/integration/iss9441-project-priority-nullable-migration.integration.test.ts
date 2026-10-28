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

/**
 * ISS-9441: what the `projects.priority` relaxation actually DOES to real
 * Postgres, and — the half the ISS-9833 ruling turns on — what it leaves alone.
 *
 * Each case REVERTS the column to its pre-migration shape inside a transaction,
 * then executes the SHIPPED migration file verbatim. Two reasons that beats
 * reading the ambient migrated catalog. It runs the same on a database the
 * migration has not reached yet, and a transcription of the statement here
 * would keep passing after someone edited the migration, which is the one
 * regression this file exists to prevent.
 *
 * The revert is the rollback the migration's own header documents, so these
 * cases also prove that statement is executable rather than merely written
 * down. Everything runs inside a transaction that is rolled back, so neither
 * the relaxation nor the revert persists.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION = "20260918165325_iss9441_project_priority_nullable";

function shippedMigrationSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
}

describe.skipIf(!DATABASE_URL)(
  "ISS-9441 projects.priority nullable migration",
  () => {
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
      await revertToPreMigrationShape(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("drops the NOT NULL and the DEFAULT", async () => {
      expect(await readColumnShape(client)).toEqual({
        columnDefault: `'MEDIUM'::"Priority"`,
        isNullable: "NO",
      });

      await client.query(shippedMigrationSql());

      expect(await readColumnShape(client)).toEqual({
        columnDefault: null,
        isNullable: "YES",
      });
    });

    it("keeps every stored priority — the ruling's no-backfill half", async () => {
      // ISS-9833 keeps legacy values as they are. The MEDIUM row is the one a
      // 2026-02-24 migration may have written from NOT_SET and the one a human
      // may have chosen; they are indistinguishable, which is why neither is
      // rewritten. HIGH is here so a blanket `SET "priority" = 'MEDIUM'` added
      // to the migration fails this case rather than passing it.
      const seeded = await seedProjects(client, {
        high: "HIGH",
        medium: "MEDIUM",
      });

      await client.query(shippedMigrationSql());

      expect(await readPriority(client, seeded.medium)).toBe("MEDIUM");
      expect(await readPriority(client, seeded.high)).toBe("HIGH");
    });

    it("stores NULL for an insert that omits priority", async () => {
      await client.query(shippedMigrationSql());

      const inserted = await seedProject(client, undefined);

      expect(await readPriority(client, inserted)).toBeNull();
    });
  }
);

/**
 * The shape the column had before this migration, restored by the statement the
 * migration's header names as its rollback. The backfill runs first and in the
 * same transaction because `SET NOT NULL` validates every existing row.
 */
async function revertToPreMigrationShape(client: Client): Promise<void> {
  await client.query(
    `UPDATE "projects" SET "priority" = 'MEDIUM' WHERE "priority" IS NULL`
  );
  await client.query(
    `ALTER TABLE "projects" ALTER COLUMN "priority" SET DEFAULT 'MEDIUM',
                            ALTER COLUMN "priority" SET NOT NULL`
  );
}

async function readColumnShape(
  client: Client
): Promise<{ columnDefault: string | null; isNullable: string }> {
  // `prisma migrate status` compares the migrations directory to
  // `_prisma_migrations` and can report a clean history while the column is not
  // what the schema says, so nullability and default are read from the catalog.
  const result = await client.query<{
    column_default: string | null;
    is_nullable: string;
  }>(
    `SELECT "column_default", "is_nullable"
       FROM information_schema.columns
      WHERE "table_name" = 'projects' AND "column_name" = 'priority'`
  );
  return {
    columnDefault: result.rows[0].column_default,
    isNullable: result.rows[0].is_nullable,
  };
}

async function seedOrganizationAndUser(
  client: Client
): Promise<{ organizationId: string; userId: string }> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await client.query(
    `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "created_at", "updated_at")
     VALUES ($1, $2, 'iss9441', $3, now(), now())`,
    [organizationId, `org_${organizationId}`, `iss9441-${organizationId}`]
  );
  await client.query(
    `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "updated_at")
     VALUES ($1, $2, $3, $4, now())`,
    [userId, `user_${userId}`, organizationId, `iss9441-${userId}@example.test`]
  );
  return { organizationId, userId };
}

/**
 * `undefined` omits the column from the INSERT, which is the only way to observe
 * the DEFAULT; an explicit `null` would satisfy the assertion even with the
 * default still in place.
 */
async function seedProject(
  client: Client,
  priority: string | undefined
): Promise<string> {
  const { organizationId, userId } = await seedOrganizationAndUser(client);
  const projectId = randomUUID();
  if (priority === undefined) {
    await client.query(
      `INSERT INTO "projects" ("id", "organization_id", "name", "slug", "created_by_id", "updated_at")
       VALUES ($1, $2, 'iss9441', $3, $4, now())`,
      [projectId, organizationId, `iss9441-${projectId}`, userId]
    );
    return projectId;
  }
  await client.query(
    `INSERT INTO "projects" ("id", "organization_id", "name", "slug", "priority", "created_by_id", "updated_at")
     VALUES ($1, $2, 'iss9441', $3, $4::"Priority", $5, now())`,
    [projectId, organizationId, `iss9441-${projectId}`, priority, userId]
  );
  return projectId;
}

async function seedProjects(
  client: Client,
  priorities: { high: string; medium: string }
): Promise<{ high: string; medium: string }> {
  return {
    high: await seedProject(client, priorities.high),
    medium: await seedProject(client, priorities.medium),
  };
}

async function readPriority(
  client: Client,
  projectId: string
): Promise<string | null> {
  const result = await client.query<{ priority: string | null }>(
    'SELECT "priority" FROM "projects" WHERE "id" = $1',
    [projectId]
  );
  return result.rows[0].priority;
}
