/**
 * ISS-8462 — behavioural coverage for the cloud migration
 * `20260828140000_iss8462_pull_request_detail_desktop_originated`, which adds
 * the durable origin column AND assigns it for pre-existing rows.
 *
 * Runs the committed SQL verbatim against a REAL Postgres. Only a real database
 * can prove what the migration claims, and it makes two claims of different
 * kinds.
 *
 * THE ROW CLAIM: the assignment reproduces the reconcile selector's old arm
 * membership exactly — every `desktop_sync` row, and nothing else. Checked
 * inside a transaction that is always rolled back.
 *
 * THE ATOMICITY CLAIM (whitlockk review on #6214): the schema change and the origin
 * assignment commit together, so a live reconciler cannot relabel a
 * `desktop_sync` row to `graphql` in between and be missed forever. Checked by
 * contention against a second connection, in a throwaway schema so nothing
 * global is touched. "The migration applied without error" proves neither.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
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

const COMMENT_LINE_RE = /^\s*--.*$/gm;
const TRANSACTION_CONTROL_RE = /^(BEGIN|COMMIT)$/i;

function migrationSql(directory: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      directory,
      "migration.sql"
    ),
    "utf8"
  );
}

/**
 * Split the file the way Prisma's applier does — ONE STATEMENT PER ROUND TRIP.
 * This is load-bearing, not a convenience. Postgres wraps a multi-statement
 * simple query in an implicit transaction, so handing the whole file to
 * `client.query` in one call would make ANY shape look atomic and the
 * contention test below could never fail. Measured 2026-08-29: a two-statement
 * Prisma migration whose second statement raises still leaves the first
 * committed, so Prisma adds no wrapper of its own and the file's explicit
 * BEGIN/COMMIT is the only thing holding these two statements together.
 */
function migrationStatements(sql: string): string[] {
  return sql
    .replace(COMMENT_LINE_RE, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const MIGRATION_DIR =
  "20260828140000_iss8462_pull_request_detail_desktop_originated";
const MIGRATION_STATEMENTS = migrationStatements(migrationSql(MIGRATION_DIR));
/** The same statements minus transaction control, for the rolled-back harness. */
const MIGRATION_BODY_STATEMENTS = MIGRATION_STATEMENTS.filter(
  (statement) => !TRANSACTION_CONTROL_RE.test(statement)
);

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f8462-0000-7000-8000-000000000001";
const BRANCH_ARTIFACT_ID = "019f8462-0000-7000-8000-000000000002";
const PROBE_SCHEMA = "iss8462_migration_probe";
const CONTENDED_LOCK_TIMEOUT = "300ms";
/** Postgres `lock_not_available` — what a blocked writer reports on timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * The literals below are written out rather than imported from
 * `GitHubFetchMechanism`. The migration hard-codes `'desktop_sync'` in SQL, so a
 * fixture reading the same const would follow a rename straight past the
 * mismatch instead of failing on it.
 */
const DESKTOP_SYNC_ROW = { number: 1, mechanism: "desktop_sync" };
/** Already frozen by a completed reconcile — ISS-8463's population, not ours. */
const RECONCILED_ROW = { number: 2, mechanism: "graphql" };
const WEBHOOK_ROW = { number: 3, mechanism: "webhook" };
/** Pre-provenance legacy row: no mechanism recorded at all. */
const NULL_MECHANISM_ROW = { number: 4, mechanism: null };

describe.skipIf(!DATABASE_URL)(
  "ISS-8462 desktop-origin marker migration",
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
      await client.query(
        'ALTER TABLE "pull_request_detail" DROP COLUMN "desktop_originated"'
      );
      await seedFixture(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("adds the column closed, so a row nobody classified is not treated as desktop-originated", async () => {
      await applyStatements(client, MIGRATION_BODY_STATEMENTS.slice(0, 1));

      expect(await readOriginated(client, DESKTOP_SYNC_ROW.number)).toBe(false);
      expect(await readOriginated(client, WEBHOOK_ROW.number)).toBe(false);
    });

    it("marks exactly the rows the selector arm used to admit", async () => {
      await applyStatements(client, MIGRATION_BODY_STATEMENTS);

      expect(await readOriginated(client, DESKTOP_SYNC_ROW.number)).toBe(true);
    });

    // Each of these must stay false. An assignment that widened to any of them
    // would admit provider-owned rows to the tier-2 stub arm, which is the
    // widening ISS-8423's review already rejected once.
    it.each([
      ["a row a completed reconcile already froze (ISS-8463)", RECONCILED_ROW],
      ["a webhook-produced row", WEBHOOK_ROW],
      ["a legacy row with no recorded mechanism", NULL_MECHANISM_ROW],
    ])("leaves %s unmarked", async (_label, row) => {
      await applyStatements(client, MIGRATION_BODY_STATEMENTS);

      expect(await readOriginated(client, row.number)).toBe(false);
    });
  }
);

/**
 * whitlockk on #6214: "Once step 1 defaults legacy rows to false, the already-live
 * reconciler can write graphql before this UPDATE runs, then this predicate
 * misses the row permanently."
 *
 * The property that closes that gap is that no other session can write this
 * table between the two statements — i.e. the ACCESS EXCLUSIVE that `ADD COLUMN`
 * takes is still held when the origin assignment runs. That is observable only
 * as contention, so this drives two connections and asserts the second one is
 * locked out. It goes GREEN only for a single transactional migration: split
 * across two files (or two unwrapped statements) the ALTER commits on its own,
 * the lock drops, and the contending write succeeds.
 *
 * Runs against a throwaway schema holding a clone of the table, so the real
 * `pull_request_detail` is never dropped or locked and no concurrent suite can
 * see this. Everything is torn down in `finally`.
 */
describe.skipIf(!DATABASE_URL)("ISS-8462 marker migration atomicity", () => {
  it("holds the table against a concurrent reconcile write until the origin assignment commits", async () => {
    const migrator = new Client({ connectionString: DATABASE_URL });
    const reconciler = new Client({ connectionString: DATABASE_URL });
    await migrator.connect();
    await reconciler.connect();

    try {
      await createProbeSchema(migrator);
      await reconciler.query(`SET search_path = "${PROBE_SCHEMA}", public`);
      await reconciler.query(`SET lock_timeout = '${CONTENDED_LOCK_TIMEOUT}'`);

      // The reconciler's write succeeds while nothing holds the table, so the
      // rejection below is contention and not a broken fixture.
      const before = await reconciler.query(RELABEL_SQL);
      expect(before.rowCount).toBe(1);
      await reconciler.query(
        `UPDATE "pull_request_detail" SET "fetch_mechanism" = 'desktop_sync' WHERE "number" = ${DESKTOP_SYNC_ROW.number}`
      );

      // Everything the migration does except its final COMMIT.
      const uncommitted = MIGRATION_STATEMENTS.slice(
        0,
        MIGRATION_STATEMENTS.length - 1
      );
      await applyStatements(migrator, uncommitted);

      await expect(reconciler.query(RELABEL_SQL)).rejects.toMatchObject({
        code: LOCK_NOT_AVAILABLE,
      });

      await migrator.query("COMMIT");

      // And the row the blocked writer would have relabelled is marked, which is
      // the outcome the lock bought.
      const { rows } = await migrator.query<{ desktopOriginated: boolean }>(
        `SELECT "desktop_originated" AS "desktopOriginated"
         FROM "pull_request_detail" WHERE "number" = $1`,
        [DESKTOP_SYNC_ROW.number]
      );
      expect(rows[0]?.desktopOriginated).toBe(true);
    } finally {
      await migrator.query("ROLLBACK").catch(() => undefined);
      await migrator
        .query(`DROP SCHEMA IF EXISTS "${PROBE_SCHEMA}" CASCADE`)
        .catch(() => undefined);
      await migrator.end();
      await reconciler.end();
    }
  });
});

/** What the live reconciler does to a desktop row on a successful refresh. */
const RELABEL_SQL = `UPDATE "pull_request_detail"
   SET "fetch_mechanism" = 'graphql'
   WHERE "number" = ${DESKTOP_SYNC_ROW.number}`;

async function applyStatements(
  target: Client,
  statements: string[]
): Promise<void> {
  for (const statement of statements) {
    await target.query(statement);
  }
}

/**
 * A clone of `pull_request_detail` in its pre-migration shape, in a schema of
 * its own. `search_path` makes the migration's unqualified table name resolve
 * here, so the committed SQL runs verbatim without touching the real table.
 */
async function createProbeSchema(target: Client): Promise<void> {
  await target.query(`DROP SCHEMA IF EXISTS "${PROBE_SCHEMA}" CASCADE`);
  await target.query(`CREATE SCHEMA "${PROBE_SCHEMA}"`);
  await target.query(`SET search_path = "${PROBE_SCHEMA}", public`);
  await target.query(
    `CREATE TABLE "pull_request_detail"
       (LIKE public."pull_request_detail" INCLUDING DEFAULTS)`
  );
  await target.query(
    'ALTER TABLE "pull_request_detail" DROP COLUMN "desktop_originated"'
  );
  await target.query(
    `INSERT INTO "pull_request_detail"
       ("id", "organization_id", "branch_artifact_id", "repository_full_name", "number", "fetch_mechanism")
     VALUES (gen_random_uuid(), $1, $2, 'acme/widgets', $3, $4)`,
    [ORG_ID, BRANCH_ARTIFACT_ID, DESKTOP_SYNC_ROW.number, "desktop_sync"]
  );
}

async function readOriginated(
  client: Client,
  number: number
): Promise<boolean | null> {
  const { rows } = await client.query<{ desktopOriginated: boolean }>(
    `SELECT "desktop_originated" AS "desktopOriginated"
     FROM "pull_request_detail"
     WHERE "organization_id" = $1 AND "number" = $2`,
    [ORG_ID, number]
  );
  return rows[0]?.desktopOriginated ?? null;
}

async function seedFixture(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
     VALUES ($1, $2, 'ISS-8462 Org', $3, now())`,
    [ORG_ID, `org_${ORG_ID}`, `iss8462-${ORG_ID}`]
  );
  await client.query(
    `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
     VALUES ($1, $2, 'BRANCH', 'iss8462-branch', 'OPEN', now())`,
    [BRANCH_ARTIFACT_ID, ORG_ID]
  );

  for (const row of [
    DESKTOP_SYNC_ROW,
    RECONCILED_ROW,
    WEBHOOK_ROW,
    NULL_MECHANISM_ROW,
  ]) {
    await client.query(
      `INSERT INTO "pull_request_detail"
         ("organization_id", "branch_artifact_id", "repository_full_name", "number", "fetch_mechanism")
       VALUES ($1, $2, 'acme/widgets', $3, $4)`,
      [ORG_ID, BRANCH_ARTIFACT_ID, row.number, row.mechanism]
    );
  }
}
