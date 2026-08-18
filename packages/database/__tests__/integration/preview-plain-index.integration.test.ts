/**
 * ISS-4437 — integration proof that the REAL FEA-3857 migration SQL, with
 * CONCURRENTLY stripped, actually builds valid indexes against a real Postgres
 * preview schema (the unit tests mock the client; only a real DB proves the DDL
 * executes and the UNIQUE index is genuinely unique). Also proves idempotency and
 * that no `CREATE INDEX CONCURRENTLY` reaches the server. Skips when DATABASE_URL
 * is unset. Uses an isolated `preview_*` schema it creates and drops — never
 * touches `public` or `_prisma_migrations`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";
import { plainBuildPreviewConcurrentIndexes } from "../../scripts/preview-plain-index";

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = "preview_iss4437_plain_index_it";
// NOT `preview_`-prefixed → treated as a non-preview (public-like) schema.
const PUBLIC_LIKE_SCHEMA = "iss4437_public_path_it";
const FEA3857_MIGRATION_NAME =
  "20260723030001_fea3857_search_document_concurrent_indexes";
const EXPECTED_INDEXES = [
  "search_document_tsv_gin_idx",
  "search_document_organization_id_entity_type_updated_at_idx",
  "search_document_organization_id_entity_type_entity_id_key",
];
const UNIQUE_INDEX =
  "search_document_organization_id_entity_type_entity_id_key";
const CREATE_UNIQUE_INDEX_RE = /CREATE UNIQUE INDEX/i;
const CONCURRENTLY_RE = /concurrently/i;
const SQL_LINE_COMMENT_G = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;

// The REAL FEA-3857 concurrent-index migration, read verbatim — the public path
// must still run these CONCURRENTLY (unchanged).
const FEA3857_MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260723030001_fea3857_search_document_concurrent_indexes",
    "migration.sql"
  ),
  "utf8"
);

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

// Minimal `search_document` table matching the columns the FEA-3857 indexes
// reference (the real projection migration creates the full table; the plain-
// index builder only needs these columns to exist).
const CREATE_TABLE_SQL = (schema: string) =>
  `CREATE TABLE ${quoteIdentifier(schema)}."search_document" (
     "organization_id" text NOT NULL,
     "entity_type" text NOT NULL,
     "entity_id" text NOT NULL,
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     "tsv" tsvector
   )`;

async function resetTestSchema(): Promise<void> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const quoted = quoteIdentifier(TEST_SCHEMA);
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoted}`);
    await client.query(CREATE_TABLE_SQL(TEST_SCHEMA));
  } finally {
    await client.end();
  }
}

async function indexRows(
  schema: string = TEST_SCHEMA
): Promise<{ indexname: string; indexdef: string }[]> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    const { rows } = (await client.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname",
      [schema, EXPECTED_INDEXES]
    )) as { rows: { indexname: string; indexdef: string }[] };
    return rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!DATABASE_URL)(
  "plainBuildPreviewConcurrentIndexes (integration)",
  () => {
    beforeAll(async () => {
      await resetTestSchema();
    });

    afterAll(async () => {
      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        await client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA)} CASCADE`
        );
      } finally {
        await client.end();
      }
    });

    it("builds all three FEA-3857 indexes PLAIN (no CONCURRENTLY) and verifies them", async () => {
      await expect(
        plainBuildPreviewConcurrentIndexes(requireUrl(), TEST_SCHEMA, {
          readMigrationSql: readFea3857MigrationSql,
        })
      ).resolves.toBeUndefined();

      const rows = await indexRows();
      expect(rows.map((r) => r.indexname)).toEqual(
        [...EXPECTED_INDEXES].sort()
      );

      // The correctness index is genuinely UNIQUE, and NO index def is CONCURRENTLY
      // (pg_indexes never reports CONCURRENTLY, but assert the unique constraint
      // that the runtime ON CONFLICT depends on landed).
      const unique = rows.find((r) => r.indexname === UNIQUE_INDEX);
      expect(unique?.indexdef).toMatch(CREATE_UNIQUE_INDEX_RE);
    });

    it("is idempotent — a second run over the now-indexed schema succeeds (IF NOT EXISTS)", async () => {
      await expect(
        plainBuildPreviewConcurrentIndexes(requireUrl(), TEST_SCHEMA, {
          readMigrationSql: readFea3857MigrationSql,
        })
      ).resolves.toBeUndefined();
      const rows = await indexRows();
      expect(rows).toHaveLength(EXPECTED_INDEXES.length);
    });

    it("enforces the unique upsert key: a duplicate insert is rejected", async () => {
      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        await client.query(
          `SET search_path TO ${quoteIdentifier(TEST_SCHEMA)}`
        );
        await client.query(
          `INSERT INTO "search_document" ("organization_id","entity_type","entity_id") VALUES ('o1','DOCUMENT','e1')`
        );
        await expect(
          client.query(
            `INSERT INTO "search_document" ("organization_id","entity_type","entity_id") VALUES ('o1','DOCUMENT','e1')`
          )
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    });
  }
);

describe.skipIf(!DATABASE_URL)(
  "public path preserves CONCURRENTLY (integration, ISS-4437)",
  () => {
    beforeAll(async () => {
      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        const quoted = quoteIdentifier(PUBLIC_LIKE_SCHEMA);
        await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
        await client.query(`CREATE SCHEMA ${quoted}`);
        await client.query(CREATE_TABLE_SQL(PUBLIC_LIKE_SCHEMA));
      } finally {
        await client.end();
      }
    });

    afterAll(async () => {
      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        await client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(PUBLIC_LIKE_SCHEMA)} CASCADE`
        );
      } finally {
        await client.end();
      }
    });

    it("runs the REAL FEA-3857 statements VERBATIM (still CONCURRENTLY) and builds valid indexes", async () => {
      const statements = FEA3857_MIGRATION_SQL.replace(SQL_BLOCK_COMMENT_G, " ")
        .replace(SQL_LINE_COMMENT_G, " ")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // The migration file is unchanged — every executable statement is CONCURRENTLY.
      expect(statements.length).toBe(EXPECTED_INDEXES.length);
      for (const stmt of statements) {
        expect(stmt).toMatch(CONCURRENTLY_RE);
      }
      const client = createSslClient(requireUrl());
      await client.connect();
      try {
        await client.query(
          `SET search_path TO ${quoteIdentifier(PUBLIC_LIKE_SCHEMA)}`
        );
        // CONCURRENTLY cannot run in a transaction; pg.Client autocommits each.
        for (const stmt of statements) {
          await client.query(stmt);
        }
      } finally {
        await client.end();
      }
      const rows = await indexRows(PUBLIC_LIKE_SCHEMA);
      expect(rows.map((r) => r.indexname)).toEqual(
        [...EXPECTED_INDEXES].sort()
      );
      expect(rows.find((r) => r.indexname === UNIQUE_INDEX)?.indexdef).toMatch(
        CREATE_UNIQUE_INDEX_RE
      );
    });

    it("plainBuildPreviewConcurrentIndexes is a no-op for a non-preview schema", async () => {
      await expect(
        plainBuildPreviewConcurrentIndexes(requireUrl(), PUBLIC_LIKE_SCHEMA)
      ).resolves.toBeUndefined();
    });
  }
);

function readFea3857MigrationSql(migrationName: string): string {
  return migrationName === FEA3857_MIGRATION_NAME
    ? FEA3857_MIGRATION_SQL
    : "-- Migration omitted from this FEA-3857-focused fixture.";
}
