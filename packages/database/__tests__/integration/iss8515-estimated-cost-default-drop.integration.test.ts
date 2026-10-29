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
import {
  type SessionDetailSeed,
  seedSessionDetailParents,
} from "../test-helpers/session-detail-seed";

/**
 * ISS-8515: what the DROP DEFAULT actually DOES, against real Postgres.
 *
 * Every other test for this ticket mocks the Prisma client in-process, and the
 * ISS-7813 migration test says why that is not enough in as many words: "Nothing
 * in `apps/api` catches that: every persist test mocks the Prisma client
 * in-process and never reaches Postgres." The sibling statement-pinning test
 * (`iss8515-...-drop-default-migration.test.ts`) only parses SQL text, which
 * proves the migration SAYS the right thing, not that the column BEHAVES that way.
 *
 * So this file asserts the two behaviours the whole change rests on:
 *
 *  1. An INSERT that OMITS `estimated_cost` now stores NULL, not 0. That is
 *     exactly what a not-yet-deployed API instance does during the rollout window,
 *     so this is the deploy-skew argument EXERCISED rather than asserted.
 *  2. An explicit `0` still stores 0. Dropping a default must not make a genuine
 *     measured zero unrepresentable — `sessionHasNumericCost` exists to tell a
 *     real $0 from an unknown, and both must remain writable.
 *
 * Every case runs inside a transaction that is rolled back, so nothing persists.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  "ISS-8515 session_detail.estimated_cost after DROP DEFAULT",
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
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("no longer declares a default for the column", async () => {
      const { rows } = await client.query<{
        column_default: string | null;
        is_nullable: string;
      }>(
        `SELECT column_default, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'session_detail' AND column_name = 'estimated_cost'`
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].column_default).toBeNull();
      // Nullability is UNCHANGED by this migration — it has been nullable since
      // ISS-7813, and re-tightening it would break every explicit null write.
      expect(rows[0].is_nullable).toBe("YES");
    });

    it("stores NULL for an insert that omits the column, and 0 when one is named", async () => {
      const seed = await seedSessionDetailParents(client, "iss8515");

      const omitted = await insertSessionDetail(client, seed, {
        namedCost: null,
      });
      const explicitZero = await insertSessionDetail(client, seed, {
        namedCost: 0,
      });

      // The rollout-window shape: an old instance omits the key.
      expect(omitted).toBeNull();
      // And a measured $0 is still expressible, which is the whole point of
      // keeping null and 0 distinguishable.
      expect(explicitZero).toBe("0.000000");
    });
  }
);

/** Insert one session_detail row, naming the cost or omitting it entirely. */
async function insertSessionDetail(
  client: Client,
  seed: SessionDetailSeed,
  options: { namedCost: number | null }
): Promise<string | null> {
  const artifactId = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_at, updated_at)
     VALUES ($1, $2, 'SESSION', 'iss8515', 'active', now(), now())`,
    [artifactId, seed.organizationId]
  );

  const columns = [
    "artifact_id",
    "compute_target_id",
    "external_session_id",
    "session_started_at",
    "session_updated_at",
    "last_activity_at",
    "updated_at",
  ];
  const values: unknown[] = [
    artifactId,
    seed.computeTargetId,
    `ext-${artifactId}`,
  ];
  let sql = `INSERT INTO session_detail (${columns.join(", ")}${
    options.namedCost === null ? "" : ", estimated_cost"
  }) VALUES ($1, $2, $3, now(), now(), now(), now()${
    options.namedCost === null ? "" : ", $4"
  })`;
  if (options.namedCost !== null) {
    values.push(options.namedCost);
    sql = sql.replace("$4", `$${values.length}`);
  }
  await client.query(sql, values);

  const { rows } = await client.query<{ estimated_cost: string | null }>(
    "SELECT estimated_cost FROM session_detail WHERE artifact_id = $1",
    [artifactId]
  );
  return rows[0].estimated_cost;
}
