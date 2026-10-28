/**
 * ISS-5981 (scope item 3) — behavioural coverage for the cloud data migration
 * `20260817120000_iss5981_backfill_waiting_session_status`.
 *
 * Runs the committed migration SQL verbatim against a REAL Postgres (the same
 * migrated database the CI `database-integration-tests` job provisions), inside
 * a transaction that is always rolled back, so the suite seeds its own fixture
 * and leaves nothing behind.
 *
 * Only a real database can prove what this migration actually claims. The
 * sibling text-scan suite (`../iss5981-waiting-session-status-migration.test.ts`)
 * asserts the SQL's SHAPE; it cannot execute a join, cannot notice a syntax
 * error that leaves the expected substrings intact, and cannot observe which
 * rows the predicate actually selects. Each of those is a claim the migration's
 * own comments make, so each is exercised here against seeded rows.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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

const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260817120000_iss5981_backfill_waiting_session_status",
    "migration.sql"
  ),
  "utf8"
);

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f5981-0000-7000-8000-000000000001";
const USER_ID = "019f5981-0000-7000-8000-000000000002";
const TARGET_ID = "019f5981-0000-7000-8000-000000000003";

/** `waiting`, no anchor, has a cloud activity clock. */
const ANCHORLESS_ID = "019f5981-0000-7000-8000-000000000010";
/** `waiting`, no anchor, and NO activity clock either — tier 3 is all it has. */
const NO_ACTIVITY_ID = "019f5981-0000-7000-8000-000000000011";
/** `waiting` and already anchored — the anchor must survive untouched. */
const ANCHORED_ID = "019f5981-0000-7000-8000-000000000012";
/**
 * `waiting` on a run that already ended, with NO recorded verdict — the
 * pre-ISS-4586 / older-desktop shape. A null flag means not-error, so this is
 * the row that proves the terminal arm does not treat "unknown" as a failure.
 */
const ENDED_ID = "019f5981-0000-7000-8000-000000000013";
/** A stored `active` row that is awaiting input — outside the population. */
const CONTROL_ACTIVE_ID = "019f5981-0000-7000-8000-000000000014";
/** A BRANCH artifact whose own free-form status is the same word. */
const BRANCH_ARTIFACT_ID = "019f5981-0000-7000-8000-000000000015";
/**
 * An ordinary live SESSION: `active`, not ended, no anchor. It shares the
 * anchorless-and-live shape of the two retained rows but not their status, so it
 * catches a predicate that keys off the session columns and forgets to ask what
 * the artifact actually stores.
 *
 * The row correlation itself is proved by the retained rows rather than here:
 * drop or repoint either `UPDATE ... FROM` join predicate and that statement
 * becomes a cross product in which every `waiting` SESSION matches as soon as
 * ANY `session_detail` row satisfies the column guards, which collapses exactly
 * the two rows this migration exists to leave alone.
 */
const BYSTANDER_ID = "019f5981-0000-7000-8000-000000000016";
/** `waiting` on a run that ended on an unrecovered error (`ends_with_error` true). */
const ENDED_ERROR_ID = "019f5981-0000-7000-8000-000000000017";
/** `waiting` on a run that ended cleanly (`ends_with_error` explicitly false). */
const ENDED_CLEAN_ID = "019f5981-0000-7000-8000-000000000018";

/*
 * Both columns are `timestamp WITHOUT time zone`, so every value here is read
 * back as TEXT rather than as a Date: `node-pg` resolves a naive timestamp
 * against the RUNNER's local zone, which made a correct migration look like a
 * five-hour drift on a machine that is not on UTC. Comparing the stored text is
 * what the migration actually promises — it copies a column, it does not
 * reinterpret one.
 */
const STARTED_AT = "2026-06-01 00:00:00";
const ACTIVITY_AT = "2026-06-02 00:00:00";
const EXISTING_ANCHOR_AT = "2026-06-01 06:00:00";
const ENDED_AT = "2026-06-03 00:00:00";

type StatusRow = {
  id: string;
  status: string;
  awaitingInputSince: string | null;
  updatedAt: string;
};

describe.skipIf(!DATABASE_URL)(
  "ISS-5981 stored-`waiting` backfill migration",
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
      await seedFixture(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("retains the spelling on EXACTLY the rows whose awaiting-input bit it cannot preserve any other way", async () => {
      await client.query(MIGRATION_SQL);

      expect(await readStoredWaitingSessionIds(client)).toEqual([
        ANCHORLESS_ID,
        NO_ACTIVITY_ID,
      ]);
    });

    /*
     * The two rows the #5202 review turned on. `last_activity_at` says when the
     * session was last ALIVE and `session_started_at` says when it BEGAN;
     * neither says when it ASKED for input, which is what the elapsed-waiting
     * display renders `awaiting_input_since` as. Synthesizing one from either
     * presents a proxy as an exact measurement — and on NO_ACTIVITY_ID, whose
     * only candidate is its own start instant, it would claim the run had been
     * blocked for the session's entire lifetime. The root AGENTS.md rule is that
     * a null is the valid representation of an unknown internal value and is
     * preferred to a fabricated one; keeping the word is better still, because
     * it preserves the one bit the row does know without asserting a second one
     * it does not.
     */
    it.each([
      ["with a cloud activity clock", ANCHORLESS_ID],
      ["with no activity clock at all", NO_ACTIVITY_ID],
    ])(
      "keeps the waiting bit on an anchorless live row %s without inventing when it started",
      async (_label, artifactId) => {
        await client.query(MIGRATION_SQL);

        const row = await readRow(client, artifactId);
        expect(row.status).toBe("waiting");
        expect(row.awaitingInputSince).toBeNull();
      }
    );

    it("collapses a live row whose anchor already carries the bit, and preserves the moment it first asked", async () => {
      await client.query(MIGRATION_SQL);

      const row = await readRow(client, ANCHORED_ID);
      expect(row.status).toBe(SESSION_STATUS.ACTIVE);
      expect(row.awaitingInputSince).toBe(EXISTING_ANCHOR_AT);
    });

    it("leaves a live unanchored session that never stored the spelling exactly as it found it", async () => {
      const before = await readRow(client, BYSTANDER_ID);

      await client.query(MIGRATION_SQL);

      expect(await readRow(client, BYSTANDER_ID)).toEqual(before);
    });

    it("leaves an already-ended row unanchored rather than claiming it is blocked on a human", async () => {
      await client.query(MIGRATION_SQL);

      expect((await readRow(client, ENDED_ID)).awaitingInputSince).toBeNull();
    });

    /*
     * The #5202 review thread PRRT_kwDOQ4gDpM6ZtKbj. Writing `active` onto a run
     * that is known to be over splits the row across three shipped readers:
     * `projectDisplayedSessionStatus` badges it Active (or Stale),
     * `deriveAgentSessionFallbackState` calls the same row Completed, and
     * `resolveSessionDurationWindow` classifies `active` as Running, so it
     * ignores the row's real end time and measures the duration to `now()`
     * forever. The verdict comes from the row's own `ends_with_error`, matching
     * the stale-session reaper's `endsWithError ? ERROR : INACTIVE`.
     */
    it.each([
      ["an unrecovered error", ENDED_ERROR_ID, SESSION_STATUS.ERROR],
      ["a clean finish", ENDED_CLEAN_ID, SESSION_STATUS.INACTIVE],
      ["no recorded verdict at all", ENDED_ID, SESSION_STATUS.INACTIVE],
    ])(
      "lands an ended row on the terminal value its own evidence supports — %s",
      async (_label, artifactId, expected) => {
        await client.query(MIGRATION_SQL);

        expect((await readRow(client, artifactId)).status).toBe(expected);
      }
    );

    it("never leaves an ended row claiming to be running", async () => {
      await client.query(MIGRATION_SQL);

      for (const artifactId of [ENDED_ID, ENDED_ERROR_ID, ENDED_CLEAN_ID]) {
        expect((await readRow(client, artifactId)).status).not.toBe(
          SESSION_STATUS.ACTIVE
        );
      }
    });

    it("touches no row outside the population", async () => {
      const before = await readRow(client, CONTROL_ACTIVE_ID);

      await client.query(MIGRATION_SQL);

      expect(await readRow(client, CONTROL_ACTIVE_ID)).toEqual(before);
    });

    it("leaves another artifact subtype carrying the same free-form word alone", async () => {
      await client.query(MIGRATION_SQL);

      const branch = await readArtifactStatus(client, BRANCH_ARTIFACT_ID);
      expect(branch).toBe("waiting");
    });

    it("does not float a row it DID rewrite to the top of the recently-updated views", async () => {
      const before = await readRow(client, ANCHORED_ID);

      await client.query(MIGRATION_SQL);

      const after = await readRow(client, ANCHORED_ID);
      expect(after.status).not.toBe(before.status);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it("is re-runnable: a second application changes nothing the first produced", async () => {
      await client.query(MIGRATION_SQL);
      const afterFirst = await readAllRows(client);

      await client.query(MIGRATION_SQL);

      expect(await readAllRows(client)).toEqual(afterFirst);
    });
  }
);

const SESSION_IDS = [
  ANCHORLESS_ID,
  NO_ACTIVITY_ID,
  ANCHORED_ID,
  ENDED_ID,
  CONTROL_ACTIVE_ID,
  BYSTANDER_ID,
  ENDED_ERROR_ID,
  ENDED_CLEAN_ID,
];

/**
 * Every SESSION artifact still storing the display-only spelling, restricted to
 * this fixture's own rows so a stray row elsewhere in the database cannot make
 * the retained-population assertion pass or fail for the wrong reason.
 */
async function readStoredWaitingSessionIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT "id" FROM "artifacts"
      WHERE "type" = 'SESSION' AND "status" = $1 AND "id" = ANY($2::uuid[])
      ORDER BY "id"`,
    ["waiting", [...SESSION_IDS]]
  );
  return result.rows.map((row) => row.id);
}

async function readArtifactStatus(
  client: Client,
  artifactId: string
): Promise<string> {
  const result = await client.query<{ status: string }>(
    `SELECT "status" FROM "artifacts" WHERE "id" = $1`,
    [artifactId]
  );
  return result.rows[0].status;
}

async function readRow(client: Client, artifactId: string): Promise<StatusRow> {
  const [row] = await readRows(client, [artifactId]);
  return row;
}

function readAllRows(client: Client): Promise<StatusRow[]> {
  return readRows(client, SESSION_IDS);
}

async function readRows(
  client: Client,
  artifactIds: readonly string[]
): Promise<StatusRow[]> {
  const result = await client.query<{
    id: string;
    status: string;
    awaiting_input_since: string | null;
    updated_at: string;
  }>(
    `SELECT a."id", a."status", sd."awaiting_input_since"::text AS awaiting_input_since,
            a."updated_at"::text AS updated_at
       FROM "artifacts" AS a
       JOIN "session_detail" AS sd ON sd."artifact_id" = a."id"
      WHERE a."id" = ANY($1::uuid[])
      ORDER BY a."id"`,
    [[...artifactIds]]
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    awaitingInputSince: row.awaiting_input_since,
    updatedAt: row.updated_at,
  }));
}

async function seedFixture(client: Client): Promise<void> {
  /*
   * ISS-6463 made `last_activity_at` NOT NULL in a LATER migration than this
   * one, so a fully-migrated schema is newer than any this migration actually
   * ran against. NO_ACTIVITY_ID exists to be a row with no activity clock at
   * all, which is the whole point of the retention case below — restore the
   * historical nullability rather than inventing a clock for it. The caller
   * wraps every test in a transaction it rolls back, so this never escapes.
   */
  await client.query(
    `ALTER TABLE "session_detail" ALTER COLUMN "last_activity_at" DROP NOT NULL`
  );
  // ISS-12585 dropped `user_id` later still; the fixture rows carry it.
  await client.query(`ALTER TABLE "session_detail" ADD COLUMN "user_id" uuid`);
  await client.query(
    `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
     VALUES ($1, $2, 'ISS-5981 Org', $3, now())`,
    [ORG_ID, `org_${ORG_ID}`, `iss5981-${ORG_ID}`]
  );
  await client.query(
    `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "updated_at")
     VALUES ($1, $2, $3, 'iss5981@example.test', now())`,
    [USER_ID, `user_${USER_ID}`, ORG_ID]
  );
  await client.query(
    `INSERT INTO "compute_targets"
       ("id", "organization_id", "user_id", "machine_name", "platform", "updated_at")
     VALUES ($1, $2, $3, 'iss5981-machine', 'darwin', now())`,
    [TARGET_ID, ORG_ID, USER_ID]
  );
  await client.query(
    `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
     VALUES
       ($1, $8, 'SESSION', 'anchorless',  $6, $10),
       ($2, $8, 'SESSION', 'no-activity', $6, $10),
       ($3, $8, 'SESSION', 'anchored',    $6, $10),
       ($4, $8, 'SESSION', 'ended',       $6, $10),
       ($5, $8, 'SESSION', 'control',     $7, $10),
       ($11, $8, 'SESSION', 'bystander',  $7, $10),
       ($12, $8, 'SESSION', 'ended-error', $6, $10),
       ($13, $8, 'SESSION', 'ended-clean', $6, $10),
       ($9, $8, 'BRANCH',  'branch',      $6, $10)`,
    [
      ANCHORLESS_ID,
      NO_ACTIVITY_ID,
      ANCHORED_ID,
      ENDED_ID,
      CONTROL_ACTIVE_ID,
      "waiting",
      SESSION_STATUS.ACTIVE,
      ORG_ID,
      BRANCH_ARTIFACT_ID,
      STARTED_AT,
      BYSTANDER_ID,
      ENDED_ERROR_ID,
      ENDED_CLEAN_ID,
    ]
  );
  await client.query(
    `INSERT INTO "session_detail"
       ("artifact_id", "compute_target_id", "external_session_id", "user_id",
        "session_started_at", "session_updated_at", "last_activity_at",
        "awaiting_input_since", "session_ended_at", "ends_with_error", "updated_at")
     VALUES
       ($1, $11, 'ext-anchorless',   $12, $6, $6, $7,   NULL, NULL, NULL,  now()),
       ($2, $11, 'ext-no-activity',  $12, $6, $6, NULL, NULL, NULL, NULL,  now()),
       ($3, $11, 'ext-anchored',     $12, $6, $6, $7,   $8,   NULL, NULL,  now()),
       ($4, $11, 'ext-ended',        $12, $6, $6, $7,   NULL, $9,   NULL,  now()),
       ($5, $11, 'ext-control',      $12, $6, $6, $7,   $10,  NULL, NULL,  now()),
       ($13, $11, 'ext-bystander',   $12, $6, $6, $7,   NULL, NULL, NULL,  now()),
       ($14, $11, 'ext-ended-error', $12, $6, $6, $7,   NULL, $9,   TRUE,  now()),
       ($15, $11, 'ext-ended-clean', $12, $6, $6, $7,   NULL, $9,   FALSE, now())`,
    [
      ANCHORLESS_ID,
      NO_ACTIVITY_ID,
      ANCHORED_ID,
      ENDED_ID,
      CONTROL_ACTIVE_ID,
      STARTED_AT,
      ACTIVITY_AT,
      EXISTING_ANCHOR_AT,
      ENDED_AT,
      EXISTING_ANCHOR_AT,
      TARGET_ID,
      USER_ID,
      BYSTANDER_ID,
      ENDED_ERROR_ID,
      ENDED_CLEAN_ID,
    ]
  );
}
