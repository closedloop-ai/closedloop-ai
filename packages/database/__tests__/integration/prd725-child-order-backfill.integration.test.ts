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
const LATER_HIERARCHY_TRIGGERS = [
  ["artifacts", "artifacts_refresh_project_hierarchy_insert"],
  ["artifacts", "artifacts_refresh_project_hierarchy_update"],
  ["artifacts", "artifacts_refresh_project_hierarchy_delete"],
  ["artifact_links", "artifact_links_refresh_project_hierarchy_insert"],
  ["artifact_links", "artifact_links_refresh_project_hierarchy_update"],
  ["artifact_links", "artifact_links_refresh_project_hierarchy_delete"],
  ["artifact_links", "artifact_links_reject_produces_cycle"],
] as const;
const MIGRATIONS = [
  "20261021150100_iss12650_artifact_link_child_order",
  "20261021150300_prd725_link_order_metadata_backfill",
  "20261021150400_prd725_hierarchy_parent_metadata_backfill",
] as const;

describe.skipIf(!DATABASE_URL)("PRD-725 child-order backfill", () => {
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
    // The PRD-726 projection triggers (20261022022500) read the column this
    // case drops, and did not exist before the migrations under test.
    for (const [table, trigger] of LATER_HIERARCHY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    await client.query('DROP INDEX IF EXISTS "artifact_links_parent_rank_idx"');
    await client.query(
      'ALTER TABLE "artifact_links" DROP COLUMN IF EXISTS "sort_order"'
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("AC-006 seeds rank order from link creation without changing the prior child order", async () => {
    const fixture = await seedHierarchy(client);
    const before = await childIdsByCanonicalLink(client, fixture.parentId);

    await client.query(shippedMigrationSql());

    expect(await childIdsByCanonicalLink(client, fixture.parentId)).toEqual(
      before
    );
    expect(await childRanks(client, fixture.parentId)).toEqual([
      500, 1000, 9000,
    ]);
    expect(await childLinkRanks(client, fixture.parentId)).toEqual([
      0, 1000, 7000,
    ]);
  });

  it("preserves a main-shaped reparent through the canonical parent metadata", async () => {
    const fixture = await seedHierarchy(client);
    const reparent = await seedMainShapedReparent(client, fixture);

    await client.query(shippedMigrationSql());

    expect(await canonicalParentId(client, reparent.childId)).toBe(
      reparent.destinationParentId
    );
  });
});

function shippedMigrationSql(): string {
  return MIGRATIONS.map((migration) =>
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "prisma",
        "migrations",
        migration,
        "migration.sql"
      ),
      "utf8"
    )
  ).join("\n");
}

async function seedHierarchy(
  client: Client
): Promise<{ organizationId: string; parentId: string; projectId: string }> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const parentId = randomUUID();
  const firstChildId = randomUUID();
  const secondChildId = randomUUID();
  const thirdChildId = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, 'prd725', $3, now(), now())`,
    [organizationId, `org_${organizationId}`, `prd725-${organizationId}`]
  );
  await client.query(
    `INSERT INTO users (id, clerk_id, organization_id, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [userId, `user_${userId}`, organizationId, `${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, created_by_id, created_at, updated_at)
     VALUES ($1, $2, 'prd725', $3, $4, now(), now())`,
    [projectId, organizationId, `prd725-${projectId}`, userId]
  );
  await client.query(
    `INSERT INTO artifacts
       (id, organization_id, project_id, type, name, status, sort_order, created_at, updated_at)
     VALUES
       ($1, $2, $3, 'DOCUMENT', 'parent', 'DRAFT', 0, '2026-10-19T10:00:00Z', now()),
       ($4, $2, $3, 'DOCUMENT', 'first', 'DRAFT', 9000, '2026-10-19T10:01:00Z', now()),
       ($5, $2, $3, 'DOCUMENT', 'second', 'DRAFT', 1000, '2026-10-19T10:02:00Z', now()),
       ($6, $2, $3, 'BRANCH', 'third', 'ACTIVE', 500, '2026-10-19T10:03:00Z', now())`,
    [
      parentId,
      organizationId,
      projectId,
      firstChildId,
      secondChildId,
      thirdChildId,
    ]
  );
  await client.query(
    `INSERT INTO artifact_links
       (id, organization_id, source_id, target_id, link_type, metadata, created_at)
     VALUES
       ($1, $2, $3, $4, 'PRODUCES', '{"projectHierarchy":{"sortOrder":7000}}', '2026-10-19T11:03:00Z'),
       ($5, $2, $3, $6, 'PRODUCES', '{}', '2026-10-19T11:01:00Z'),
       ($7, $2, $3, $8, 'PRODUCES', '{}', '2026-10-19T11:02:00Z')`,
    [
      randomUUID(),
      organizationId,
      parentId,
      firstChildId,
      randomUUID(),
      secondChildId,
      randomUUID(),
      thirdChildId,
    ]
  );
  return { organizationId, parentId, projectId };
}

async function seedMainShapedReparent(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedHierarchy>>
): Promise<{ childId: string; destinationParentId: string }> {
  const destinationParentId = randomUUID();
  const childId = randomUUID();
  await client.query(
    `INSERT INTO artifacts
       (id, organization_id, project_id, type, name, status, sort_order, created_at, updated_at)
     VALUES
       ($1, $2, $3, 'DOCUMENT', 'destination', 'DRAFT', 0, '2026-10-19T10:04:00Z', now()),
       ($4, $2, $3, 'DOCUMENT', 'moved-child', 'DRAFT', 0, '2026-10-19T10:05:00Z', now())`,
    [destinationParentId, fixture.organizationId, fixture.projectId, childId]
  );
  await client.query(
    `INSERT INTO artifact_links
       (id, organization_id, source_id, target_id, link_type, metadata, created_at)
     VALUES
       ($1, $2, $3, $4, 'PRODUCES', '{"projectHierarchy":{"excluded":true}}', '2026-10-19T11:04:00Z'),
       ($5, $2, $6, $4, 'PRODUCES', '{"projectHierarchy":{"preferred":true}}', '2026-10-19T11:05:00Z')`,
    [
      randomUUID(),
      fixture.organizationId,
      fixture.parentId,
      childId,
      randomUUID(),
      destinationParentId,
    ]
  );
  return { childId, destinationParentId };
}

async function canonicalParentId(
  client: Client,
  childId: string
): Promise<string | undefined> {
  const result = await client.query<{ source_id: string }>(
    `SELECT link.source_id
       FROM artifact_links link
      WHERE link.target_id = $1
        AND link.link_type = 'PRODUCES'
        AND COALESCE((link.metadata #>> '{hierarchy,suppressed}')::boolean, false) = false
      ORDER BY
        COALESCE((link.metadata #>> '{hierarchy,canonical}')::boolean, false) DESC,
        link.created_at,
        link.id
      LIMIT 1`,
    [childId]
  );
  return result.rows[0]?.source_id;
}

async function childIdsByCanonicalLink(
  client: Client,
  parentId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT child.id
       FROM artifact_links link
       JOIN artifacts child ON child.id = link.target_id
      WHERE link.source_id = $1 AND link.link_type = 'PRODUCES'
      ORDER BY link.created_at, link.id, child.id`,
    [parentId]
  );
  return result.rows.map(({ id }) => id);
}

async function _childIdsByRank(
  client: Client,
  parentId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT child.id
       FROM artifact_links link
       JOIN artifacts child ON child.id = link.target_id
      WHERE link.source_id = $1 AND link.link_type = 'PRODUCES'
      ORDER BY child.sort_order, child.id`,
    [parentId]
  );
  return result.rows.map(({ id }) => id);
}

async function childRanks(client: Client, parentId: string): Promise<number[]> {
  const result = await client.query<{ sort_order: number }>(
    `SELECT child.sort_order
       FROM artifact_links link
       JOIN artifacts child ON child.id = link.target_id
      WHERE link.source_id = $1 AND link.link_type = 'PRODUCES'
      ORDER BY child.sort_order, child.id`,
    [parentId]
  );
  return result.rows.map(({ sort_order }) => sort_order);
}

async function childLinkRanks(
  client: Client,
  parentId: string
): Promise<number[]> {
  const result = await client.query<{ sort_order: number }>(
    `SELECT link.sort_order
       FROM artifact_links link
      WHERE link.source_id = $1 AND link.link_type = 'PRODUCES'
      ORDER BY link.sort_order, link.target_id`,
    [parentId]
  );
  return result.rows.map(({ sort_order }) => sort_order);
}
