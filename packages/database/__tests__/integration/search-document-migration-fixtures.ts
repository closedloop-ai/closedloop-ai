import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { Client } from "pg";
import type { ArtifactType } from "../../generated/enums";
import { LoopCommand } from "../../generated/enums";

/**
 * Fixtures shared by the `search_document` one-time-repair integration suites
 * (ISS-9665, ISS-9938), which all execute a SHIPPED migration file against real
 * Postgres rather than a transcription of it.
 *
 * The harness half is what makes that possible: reading the file off disk and
 * handing it to the server verbatim means a copy of the statement inside a test
 * would keep passing after someone edited the migration, which is the one
 * regression those suites exist to prevent.
 */

/**
 * The shipped ceiling and the declaration it lives on. Named here so a
 * guard-abort case can lower it with ONE substitution off the shipped bytes
 * rather than transcribing a predicate. Every repair migration in this family
 * declares the constant identically.
 */
export const CEILING_DECLARATION = "max_inline_rows CONSTANT bigint";
export const SHIPPED_CEILING = "250000";
/** Small enough to seed past, large enough that `+ 1` is not the only margin. */
export const TEST_CEILING = 2;

/** `updated_at` mirrors the source's own timestamp, so the fixture pins it. */
export const PROJECTED_UPDATED_AT = "2026-01-01T00:00:00Z";

export type ProjectionRow = {
  status: string | null;
  updatedAt: Date;
  ctid: string;
};

export function shippedMigrationSql(migration: string): string {
  return readFileSync(
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
  );
}

/**
 * The shipped file with only the ceiling constant replaced. Everything else —
 * the candidate CTE, the write, the re-check, the RAISE — is shipped text.
 * Seeding 250,001 real rows to cross the real ceiling would take minutes and
 * prove the same thing.
 */
export function migrationWithCeiling(
  migration: string,
  ceiling: number
): string {
  const shipped = shippedMigrationSql(migration);
  const lowered = shipped.replace(
    `${CEILING_DECLARATION} := ${SHIPPED_CEILING}`,
    `${CEILING_DECLARATION} := ${ceiling}`
  );
  // A substitution that silently matched nothing would make the caller assert
  // the ordinary success path while claiming to test the abort.
  if (lowered === shipped) {
    throw new Error(`${migration}: ceiling declaration not found to lower`);
  }
  return lowered;
}

export async function seedOrganization(client: Client): Promise<string> {
  const organizationId = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [
      organizationId,
      `clerk_${organizationId}`,
      "search-document-migration-test",
      `search-document-migration-test-${organizationId}`,
    ]
  );
  return organizationId;
}

export async function seedUser(
  client: Client,
  organizationId: string
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `INSERT INTO users (id, organization_id, clerk_id, email, first_name, last_name, role, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Test', 'User', 'ENGINEER', true, now(), now())`,
    [
      userId,
      organizationId,
      `user_${userId}`,
      `search-document-migration-test+${userId}@example.com`,
    ]
  );
  return userId;
}

export async function seedArtifact(
  client: Client,
  organizationId: string,
  values: { type: ArtifactType; status: string }
): Promise<string> {
  const artifactId = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_at, updated_at)
     VALUES ($1, $2, $3::"ArtifactType", $4, $5, now(), now())`,
    [
      artifactId,
      organizationId,
      values.type,
      `search-document-migration-test-${artifactId}`,
      values.status,
    ]
  );
  return artifactId;
}

/** `userId` is optional so a caller can put two loops under the same user. */
export async function seedLoop(
  client: Client,
  organizationId: string,
  values: { status: string; userId?: string }
): Promise<string> {
  const loopId = randomUUID();
  const userId = values.userId ?? (await seedUser(client, organizationId));
  await client.query(
    `INSERT INTO loops (id, organization_id, user_id, status, command, created_at, updated_at)
     VALUES ($1, $2, $3, $4::"LoopStatus", $5::"LoopCommand", now(), now())`,
    [loopId, organizationId, userId, values.status, LoopCommand.EXECUTE]
  );
  return loopId;
}

export async function seedProjectionRow(
  client: Client,
  organizationId: string,
  row: {
    entityType: SearchEntityType;
    entityId: string;
    status: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO search_document
       (id, organization_id, entity_type, entity_id, title, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      organizationId,
      row.entityType,
      row.entityId,
      `search-document-migration-test-${id}`,
      row.status,
      PROJECTED_UPDATED_AT,
    ]
  );
  return id;
}

export async function readProjection(
  client: Client,
  id: string
): Promise<ProjectionRow> {
  const result = await client.query<{
    status: string | null;
    updated_at: Date;
    ctid: string;
  }>(
    'SELECT "status", "updated_at", ctid::text AS "ctid" FROM "search_document" WHERE "id" = $1',
    [id]
  );
  const row = result.rows[0];
  return { status: row.status, updatedAt: row.updated_at, ctid: row.ctid };
}

export async function readProjectedStatus(
  client: Client,
  id: string
): Promise<string | null> {
  return (await readProjection(client, id)).status;
}

export async function deleteOrganization(
  client: Client,
  organizationId: string
): Promise<void> {
  for (const table of [
    "search_document",
    "loops",
    "artifacts",
    "users",
    "organizations",
  ]) {
    const column = table === "organizations" ? "id" : "organization_id";
    await client.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [
      organizationId,
    ]);
  }
}
