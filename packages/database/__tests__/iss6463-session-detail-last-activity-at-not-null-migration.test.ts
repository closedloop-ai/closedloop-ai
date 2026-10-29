/**
 * ISS-6463 — coverage for `20260818120000_iss6463_session_detail_last_activity_at_not_null`.
 *
 * Two halves, because the migration has two statements and only one of them is
 * self-evident.
 *
 * The DDL half is a text assertion against the specific `ALTER` statement. The
 * BEHAVIOUR half is the one that matters: the backfill `UPDATE` is expected to
 * touch zero rows in every environment we know about (the production NULL count
 * was confirmed 0 before this shipped), so nothing else in the tree ever
 * executes it. It exists precisely for the environment we were wrong about, and
 * an unexercised statement is exactly the one that fails when it finally runs.
 *
 * To exercise it we must first put the column back the way the migration found
 * it. `DROP NOT NULL`, seed a NULL row, then run the committed SQL verbatim —
 * all inside a transaction that always rolls back, so the shared local database
 * is unchanged. Postgres DDL is transactional, so the dropped constraint is
 * restored by the rollback even when an assertion fails.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client as PgClient } from "pg";
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

const MIGRATION_NAME =
  "20260818120000_iss6463_session_detail_last_activity_at_not_null";

const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    MIGRATION_NAME,
    "migration.sql"
  ),
  "utf8"
);

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f6463-0000-7000-8000-000000000001";
const USER_ID = "019f6463-0000-7000-8000-000000000002";
const TARGET_ID = "019f6463-0000-7000-8000-000000000003";
const NULL_SESSION_ID = "019f6463-0000-7000-8000-000000000004";
const SET_SESSION_ID = "019f6463-0000-7000-8000-000000000005";

/**
 * `session_detail.last_activity_at` is `TIMESTAMP(3)` WITHOUT time zone, so the
 * driver would reinterpret a returned `Date` in the runner's local zone. Every
 * assertion below reads the column back through `to_char` and compares these
 * naive literals, which is timezone-independent and therefore stable in CI.
 */
const NAIVE_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS';

const SET_DEFAULT_RE = /SET DEFAULT/i;
const NULL_GUARD_RE = /WHERE "last_activity_at" IS NULL;/;
const BACKFILL_GREATEST_RE =
  /SET "last_activity_at" = GREATEST\("session_started_at", "last_activity_at"\)/;
const NOT_NULL_VIOLATION_RE = /null value in column "last_activity_at"/i;

/** The start instant of the row seeded with a NULL activity timestamp. */
const STARTED_AT = "2026-08-01T12:00:00.000";
/** A LATER activity instant, to prove the backfill cannot lower a set value. */
const ACTIVITY_AT = "2026-08-02T12:00:00.000";

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("constrains the column with a single targeted ALTER, and adds no DEFAULT", () => {
    const alter = MIGRATION_SQL.split("\n").filter((line) =>
      line.trimStart().startsWith("ALTER TABLE")
    );

    expect(alter).toEqual([
      'ALTER TABLE "session_detail" ALTER COLUMN "last_activity_at" SET NOT NULL;',
    ]);
    // No DEFAULT is deliberate: the writer names the value explicitly, and a
    // default would silently paper over a caller that forgot to.
    expect(MIGRATION_SQL).not.toMatch(SET_DEFAULT_RE);
  });

  it("guards the backfill on the NULL case so a re-run is a no-op", () => {
    expect(MIGRATION_SQL).toMatch(NULL_GUARD_RE);
    // GREATEST over the start time, so the floored value is the same instant
    // `persistSessionChildren`'s own GREATEST would have produced.
    expect(MIGRATION_SQL).toMatch(BACKFILL_GREATEST_RE);
  });
});

describe.skipIf(!DATABASE_URL)(
  `${MIGRATION_NAME} behaviour (real Postgres)`,
  () => {
    let client: PgClient;

    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    beforeEach(async () => {
      await client.query("BEGIN");
      // Put the column back in its pre-migration shape so the committed SQL has
      // something to do. Rolled back with everything else.
      await client.query(
        'ALTER TABLE "session_detail" ALTER COLUMN "last_activity_at" DROP NOT NULL'
      );
      // ISS-12585 dropped `user_id` after this migration; the fixture carries it.
      await client.query(
        'ALTER TABLE "session_detail" ADD COLUMN "user_id" uuid'
      );
      await seedFixture(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("floors a NULL activity timestamp at the session start", async () => {
      await client.query(MIGRATION_SQL);

      expect(await readActivityAt(client, NULL_SESSION_ID)).toBe(STARTED_AT);
    });

    it("leaves an already-set activity timestamp alone, even when it is later than the start", async () => {
      await client.query(MIGRATION_SQL);

      // The guard is what makes this true: without `WHERE ... IS NULL` the
      // GREATEST would still hold, but the statement would rewrite every row.
      expect(await readActivityAt(client, SET_SESSION_ID)).toBe(ACTIVITY_AT);
    });

    it("rejects a subsequent INSERT that omits the column", async () => {
      await client.query(MIGRATION_SQL);

      await expect(
        client.query(
          `INSERT INTO "session_detail" (
             artifact_id, compute_target_id, external_session_id,
             session_started_at, session_updated_at, updated_at
           ) VALUES ($1, $2, 'ext-iss6463-post', $3, $3, $3)`,
          ["019f6463-0000-7000-8000-000000000006", TARGET_ID, STARTED_AT]
        )
      ).rejects.toThrow(NOT_NULL_VIOLATION_RE);
    });
  }
);

async function readActivityAt(
  client: PgClient,
  artifactId: string
): Promise<string | undefined> {
  const { rows } = await client.query<{ lastActivityAt: string }>(
    `SELECT to_char("last_activity_at", '${NAIVE_FORMAT}') AS "lastActivityAt"
       FROM "session_detail" WHERE "artifact_id" = $1`,
    [artifactId]
  );
  return rows[0]?.lastActivityAt;
}

async function seedFixture(client: PgClient): Promise<void> {
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     VALUES ($1, 'org_iss6463', 'ISS-6463 org', 'iss-6463-org', $2)`,
    [ORG_ID, STARTED_AT]
  );
  await client.query(
    `INSERT INTO users (id, organization_id, clerk_id, email, role, active, updated_at)
     VALUES ($1, $2, 'clerk_iss6463', 'iss6463@example.com', 'ENGINEER', true, $3)`,
    [USER_ID, ORG_ID, STARTED_AT]
  );
  await client.query(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1, $2, $3, 'iss6463-machine', 'darwin', $4)`,
    [TARGET_ID, ORG_ID, USER_ID, STARTED_AT]
  );

  await seedSession(client, NULL_SESSION_ID, "ext-iss6463-null", null);
  await seedSession(client, SET_SESSION_ID, "ext-iss6463-set", ACTIVITY_AT);
}

async function seedSession(
  client: PgClient,
  artifactId: string,
  externalSessionId: string,
  lastActivityAt: string | null
): Promise<void> {
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     VALUES ($1, $2, 'SESSION', 'ISS-6463 session', 'active', $3)`,
    [artifactId, ORG_ID, STARTED_AT]
  );
  await client.query(
    `INSERT INTO "session_detail" (
       artifact_id, user_id, compute_target_id, external_session_id,
       session_started_at, session_updated_at, last_activity_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5, $6, $5)`,
    [
      artifactId,
      USER_ID,
      TARGET_ID,
      externalSessionId,
      STARTED_AT,
      lastActivityAt,
    ]
  );
}
