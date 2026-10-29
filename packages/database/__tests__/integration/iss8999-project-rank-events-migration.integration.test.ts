/**
 * ISS-8999 — DDL coverage for
 * `20260903150000_iss8999_project_rank_events`.
 *
 * The service suites in `apps/api` exercise this table through Prisma, so they
 * see the unique key (a duplicate claim is refused) and nothing else. They would
 * stay green if the array column lost `NOT NULL`, if either index were dropped
 * or reordered into a form that cannot serve its lookup, or if the project
 * foreign key stopped cascading — none of those change a Prisma call's result on
 * the happy path, and the last one only shows up as orphan rows long after a
 * project is deleted.
 *
 * ASSERTED ON THE CATALOG, not on timing or on a seeded delete. `confdeltype`
 * IS the referential action Postgres executes and `attnotnull` IS the
 * constraint it enforces, so reading them tests the object rather than a
 * symptom of it — the same posture as
 * `iss8496-project-cascade-fk-indexes.integration.test.ts`. A catalog read also
 * fails for any route by which the object could be lost (dropped, renamed,
 * redefined by a later migration), which a grep over the committed SQL cannot.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

const TABLE = "project_rank_events";
const ARRAY_COLUMN = "ordered_artifact_ids";
const UNIQUE_INDEX =
  "project_rank_events_organization_id_project_id_idempotency__key";
const READ_INDEX = "project_rank_events_project_id_created_at_idx";
const PROJECT_FK = "project_rank_events_project_id_fkey";

/** Postgres' `pg_constraint.confdeltype` / `confupdtype` code for CASCADE. */
const CASCADE_ACTION = "c";

type ColumnRow = { notNull: boolean; udtName: string };
type IndexRow = { isUnique: boolean; columns: string[] };
type ForeignKeyRow = {
  referencedTable: string;
  columns: string[];
  onDelete: string;
  onUpdate: string;
};

describe.skipIf(!DATABASE_URL)("ISS-8999 project_rank_events DDL", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("requires the committed order on every row", async () => {
    // Prisma types `orderedArtifactIds` as a non-optional `String[]` but emits
    // array columns without the constraint, so without this the persisted
    // schema and the runtime contract disagree: a NULL would read back through
    // a `string[]` annotation and replay an empty order.
    const column = await readColumn(client, ARRAY_COLUMN);

    expect(column).toEqual<ColumnRow>({ notNull: true, udtName: "_uuid" });
  });

  it("keys the replay claim on organization, project, and idempotency key", async () => {
    // This index is not an optimization: it is the ON CONFLICT DO NOTHING
    // target that decides a single winner between concurrent claimants. A
    // narrower key would collide across organizations; a wider or non-unique
    // one would admit both.
    const index = await readIndex(client, UNIQUE_INDEX);

    expect(index).toEqual<IndexRow>({
      isUnique: true,
      columns: ["organization_id", "project_id", "idempotency_key"],
    });
  });

  it("serves the per-project event read newest-first", async () => {
    const index = await readIndex(client, READ_INDEX);

    expect(index).toEqual<IndexRow>({
      isUnique: false,
      columns: ["project_id", "created_at"],
    });
  });

  it("cascades event rows away with their project", async () => {
    // Without CASCADE the FK is RESTRICT by default, which turns every project
    // delete into an error once the project has ever been bulk-ranked.
    const foreignKey = await readForeignKey(client, PROJECT_FK);

    expect(foreignKey).toEqual<ForeignKeyRow>({
      referencedTable: "projects",
      columns: ["project_id"],
      onDelete: CASCADE_ACTION,
      onUpdate: CASCADE_ACTION,
    });
  });
});

async function readColumn(
  client: Client,
  columnName: string
): Promise<ColumnRow | null> {
  const result = await client.query<{ attnotnull: boolean; udt: string }>(
    `SELECT a.attnotnull, t.typname AS udt
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = $1::regclass
        AND a.attname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [TABLE, columnName]
  );
  const row = result.rows[0];
  return row ? { notNull: row.attnotnull, udtName: row.udt } : null;
}

async function readIndex(
  client: Client,
  indexName: string
): Promise<IndexRow | null> {
  const result = await client.query<{
    indisunique: boolean;
    columns: string[];
  }>(
    `SELECT i.indisunique,
            array_agg(a.attname::text ORDER BY k.ordinality) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1::regclass
        AND c.relname = $2
      GROUP BY i.indisunique`,
    [TABLE, indexName]
  );
  const row = result.rows[0];
  return row ? { isUnique: row.indisunique, columns: row.columns } : null;
}

async function readForeignKey(
  client: Client,
  constraintName: string
): Promise<ForeignKeyRow | null> {
  const result = await client.query<{
    referenced: string;
    columns: string[];
    confdeltype: string;
    confupdtype: string;
  }>(
    `SELECT confrelid::regclass::text AS referenced,
            (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
               JOIN pg_attribute a
                 ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
            con.confdeltype,
            con.confupdtype
       FROM pg_constraint con
      WHERE con.conrelid = $1::regclass
        AND con.conname = $2
        AND con.contype = 'f'`,
    [TABLE, constraintName]
  );
  const row = result.rows[0];
  return row
    ? {
        referencedTable: row.referenced,
        columns: row.columns,
        onDelete: row.confdeltype,
        onUpdate: row.confupdtype,
      }
    : null;
}
