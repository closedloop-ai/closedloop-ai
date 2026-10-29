import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type PrismaClient, withDb } from "@repo/database";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireFixtureDatabaseUrl } from "@/__tests__/utils/fixture-db";
import { loadBranchPushLocAtoms } from "./branch-push-loc-read";

const schema = `push_loc_plan_${randomUUID().replaceAll("-", "")}`;
const organizationId = randomUUID();
const indexName = "branch_activity_atoms_source_created_idx";
const SEEK_PREDICATE =
  /Index Cond:.*organization_id.*branch_artifact_id.*source/;
const GLOBAL_SORT = /Sort Key:.*created_at DESC.*source_event_id DESC/;
const databaseGlobals = globalThis as unknown as {
  prisma: PrismaClient | null;
  pool: pg.Pool | null;
};
const previousGlobals = {
  prisma: databaseGlobals.prisma,
  pool: databaseGlobals.pool,
};
let control: pg.Client;
let pool: pg.Pool;

function branchId(index: number): string {
  const hex = createHash("md5").update(`branch-${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Real Prisma/pg emission, not a handwritten equivalent of the read. The
 * isolated table carries the selected columns and production migration index;
 * it does not model foreign keys or test full-schema migration compatibility.
 * No planner switch forces an index and no machine-dependent timing is gated.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "push LOC emitted-query plan",
  () => {
    beforeAll(async () => {
      // The isolated schema, its table and its statistics are the FIXTURE's:
      // creating a schema and ANALYZEing a table is owner work the ISS-5978
      // role split took off the runtime role. `pool` below — the connection the
      // read under test actually emits on — stays on DATABASE_URL.
      control = new pg.Client({
        connectionString: requireFixtureDatabaseUrl(
          "the push-LOC plan fixture schema"
        ),
      });
      await control.connect();
      await control.query(`CREATE SCHEMA "${schema}"`);
      // `pool` below reads this schema as the RUNTIME role, through the PGSCHEMA
      // stub at the end of this block. `CREATE SCHEMA` grants USAGE to nobody
      // but its owner, and ALTER DEFAULT PRIVILEGES cannot carry schema USAGE at
      // all — it covers tables, sequences, functions and types — so under the
      // ISS-5978 split the read could not resolve the table, let alone select
      // from it. Granted to PUBLIC because the fixture does not know the runtime
      // role's name, and this schema is the test's own: `afterAll` DROPs it.
      await control.query(`GRANT USAGE ON SCHEMA "${schema}" TO PUBLIC`);
      await control.query(`SET search_path TO "${schema}"`);
      await control.query(`CREATE TABLE branch_activity_atoms (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL, branch_artifact_id uuid NOT NULL,
      source varchar(128) NOT NULL, source_event_id varchar(512) NOT NULL,
      created_at timestamp(3) NOT NULL, occurred_at timestamp(3) NOT NULL,
      compatibility_alias_for_source_event_id varchar(512),
      before_sha varchar(64), after_sha varchar(64),
      lines_added integer, lines_removed integer
    )`);
      // Same reason as the schema USAGE above: the table is the migrator's, and
      // the read under test arrives on the runtime role.
      await control.query("GRANT SELECT ON branch_activity_atoms TO PUBLIC");
      // 1,000 branches, 300 pushes each: two requested branches are selective,
      // whereas the normal 200-ID chunk covers 20% of this synthetic table.
      await control.query(
        `INSERT INTO branch_activity_atoms
      SELECT md5('id-' || n)::uuid, $1::uuid, md5('branch-' || (n % 1000))::uuid, 'push_loc',
        'delivery-' || n, '2026-09-01'::timestamp + n * interval '1 second',
        '2026-09-01'::timestamp + n * interval '1 second',
        NULL, repeat('a',40), repeat('b',40), 4, 1
      FROM generate_series(1,300000) n`,
        [organizationId]
      );
      await control.query(
        readFileSync(
          new URL(
            "../../../../packages/database/prisma/migrations/20260918053500_iss10009_branch_activity_push_loc_read_index/migration.sql",
            import.meta.url
          ),
          "utf8"
        )
      );
      await control.query("ANALYZE branch_activity_atoms");
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      });
      databaseGlobals.pool = pool;
      databaseGlobals.prisma = null;
      vi.stubEnv("PGSCHEMA", schema);
    });

    afterAll(async () => {
      if (pool) {
        await databaseGlobals.prisma?.$disconnect();
        databaseGlobals.prisma = previousGlobals.prisma;
        databaseGlobals.pool = previousGlobals.pool;
      }
      vi.unstubAllEnvs();
      await pool?.end();
      if (control) {
        await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await control.end();
      }
    });

    async function explainRead(ids: string[]) {
      const client = await pool.connect();
      const querySpy = vi.spyOn(client, "query");
      client.release();
      try {
        const evidence = await withDb((db) =>
          loadBranchPushLocAtoms(db, organizationId, ids)
        );
        const calls = querySpy.mock.calls as unknown as [pg.QueryConfig][];
        const query = calls[0]?.[0];
        if (
          calls.length !== 1 ||
          !query?.text?.includes('"branch_activity_atoms"')
        ) {
          throw new Error(
            "Expected exactly one emitted branch-activity SQL read"
          );
        }
        const result = await control.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${query.text}`,
          query.values
        );
        const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        return { evidence, plan };
      } finally {
        querySpy.mockRestore();
      }
    }

    it("seeks a selective multi-ID cohort but still sorts its global order", async () => {
      const { evidence, plan } = await explainRead([branchId(1), branchId(2)]);
      expect(plan).toContain(indexName);
      expect(plan).toContain("Limit");
      expect(plan).toMatch(SEEK_PREDICATE);
      expect(plan).toMatch(GLOBAL_SORT);
      expect(evidence.byBranchId.get(branchId(1))).toHaveLength(300);
      expect(evidence.byBranchId.get(branchId(2))).toHaveLength(300);
      expect(evidence.truncatedBranchIds.size).toBe(0);
    });

    it("bounds a 200-ID cohort without claiming its plan is always indexed", async () => {
      const ids = Array.from({ length: 200 }, (_, index) => branchId(index));
      const { evidence, plan } = await explainRead(ids);
      // A broad cohort may choose a sequential scan. Require the real global
      // ordering and transport result, not one machine's cost-based scan choice.
      expect(plan).toContain("Limit");
      expect(plan).toMatch(GLOBAL_SORT);
      expect([...evidence.byBranchId.values()].flat()).toHaveLength(20_000);
      expect(evidence.truncatedBranchIds).toEqual(new Set(ids));
    });
  }
);
