/**
 * ISS-5991 — behavioural coverage for the cloud data migration
 * `20260817155624_iss5991_user_onboarding_checklist_dismissed_at`.
 *
 * Runs the committed migration SQL verbatim against a REAL Postgres (the same
 * migrated database the CI `database-integration-tests` job provisions), inside
 * a transaction that is always rolled back. The column already exists on a
 * migrated database, so the transaction drops it first and then replays the
 * whole file — ADD COLUMN and backfill together, exactly as a deploy runs it.
 *
 * Only a real database can prove what this migration claims. The backfill casts
 * a JSON string through `timestamptz AT TIME ZONE 'UTC'` behind a
 * `jsonb_typeof` + shape guard, and every one of those three parts is a claim
 * about rows: which ones are selected, what instant is written, and — the point
 * of the guard — that a malformed blob is SKIPPED rather than aborting the
 * migration, since Prisma runs the file in one transaction and a failed cast
 * would block the deploy.
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

const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260817155624_iss5991_user_onboarding_checklist_dismissed_at",
    "migration.sql"
  ),
  "utf8"
);

const DATABASE_URL = process.env.DATABASE_URL;

/** Dismissed org-wide before the cutover; both members must carry the value. */
const DISMISSED_ORG_ID = "019f5991-0000-7000-8000-000000000001";
const DISMISSED_USER_A = "019f5991-0000-7000-8000-000000000002";
const DISMISSED_USER_B = "019f5991-0000-7000-8000-000000000003";
/** Hand-edited blob holding a string that is not a timestamp at all. */
const MALFORMED_ORG_ID = "019f5991-0000-7000-8000-000000000004";
const MALFORMED_USER = "019f5991-0000-7000-8000-000000000005";
/** Blob holding a non-string JSON value under the same key. */
const NON_STRING_ORG_ID = "019f5991-0000-7000-8000-000000000006";
const NON_STRING_USER = "019f5991-0000-7000-8000-000000000007";
/**
 * A date-only prefix. The first cut of this guard anchored the regex at the `T`
 * and nothing after it, so this value passed the guard and then failed the cast
 * — aborting the whole migration, the one outcome the guard exists to prevent.
 */
const PREFIX_ONLY_ORG_ID = "019f5991-0000-7000-8000-000000000008";
const PREFIX_ONLY_USER = "019f5991-0000-7000-8000-000000000009";
/**
 * A calendar-impossible date in a perfectly ISO-shaped string. No regex short of
 * one encoding the calendar rejects this, and Postgres refuses to cast it — so
 * it is the value that proves the skip is done by the exception block rather
 * than by shape matching.
 */
const IMPOSSIBLE_ORG_ID = "019f5991-0000-7000-8000-00000000000c";
const IMPOSSIBLE_USER = "019f5991-0000-7000-8000-00000000000d";
/** Never dismissed: no `onboarding` key at all. */
const UNTOUCHED_ORG_ID = "019f5991-0000-7000-8000-00000000000a";
const UNTOUCHED_USER = "019f5991-0000-7000-8000-00000000000b";

const DISMISSED_AT_ISO = "2026-02-03T04:05:06.789Z";
/**
 * The column is `timestamp(3) WITHOUT time zone`, so the stored value is read
 * back as TEXT rather than as a Date: `node-pg` would resolve a naive timestamp
 * against the RUNNER's local zone and make a correct UTC conversion look like an
 * hours-wide drift on a machine that is not on UTC. Comparing the stored text is
 * what `AT TIME ZONE 'UTC'` actually promises.
 */
const DISMISSED_AT_STORED = "2026-02-03 04:05:06.789";

describe.skipIf(!DATABASE_URL)(
  "ISS-5991 per-user onboarding dismissal backfill migration",
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
        'ALTER TABLE "users" DROP COLUMN "onboarding_checklist_dismissed_at"'
      );
      await seedFixture(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("carries an org-wide dismissal onto every member at the instant it was recorded", async () => {
      await client.query(MIGRATION_SQL);

      expect(await readDismissedAt(client, DISMISSED_USER_A)).toBe(
        DISMISSED_AT_STORED
      );
      expect(await readDismissedAt(client, DISMISSED_USER_B)).toBe(
        DISMISSED_AT_STORED
      );
    });

    // Each case is a value that must be SKIPPED. If the guard lets one through,
    // the cast raises inside the migration's single transaction and the whole
    // deploy fails — so a green run here is also the proof that the migration
    // completed at all.
    it.each([
      ["a string that is not a timestamp", MALFORMED_USER],
      ["a non-string JSON value", NON_STRING_USER],
      ["a date-only prefix with no time part", PREFIX_ONLY_USER],
      ["an ISO-shaped but calendar-impossible date", IMPOSSIBLE_USER],
      ["no onboarding state at all", UNTOUCHED_USER],
    ])(
      "skips %s rather than aborting the migration",
      async (_label, userId) => {
        await client.query(MIGRATION_SQL);

        expect(await readDismissedAt(client, userId)).toBeNull();
      }
    );

    it("leaves the legacy org-level value in place for a version-skewed reader", async () => {
      await client.query(MIGRATION_SQL);

      const { rows } = await client.query<{ dismissedAt: string | null }>(
        `SELECT "settings" -> 'onboarding' ->> 'checklistDismissedAt' AS "dismissedAt"
         FROM "organizations" WHERE "id" = $1`,
        [DISMISSED_ORG_ID]
      );
      expect(rows[0]?.dismissedAt).toBe(DISMISSED_AT_ISO);
    });
  }
);

async function readDismissedAt(
  client: Client,
  userId: string
): Promise<string | null> {
  const { rows } = await client.query<{ dismissedAt: string | null }>(
    `SELECT to_char("onboarding_checklist_dismissed_at", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dismissedAt"
     FROM "users" WHERE "id" = $1`,
    [userId]
  );
  return rows[0]?.dismissedAt ?? null;
}

async function seedFixture(client: Client): Promise<void> {
  const orgs: ReadonlyArray<readonly [string, string]> = [
    [
      DISMISSED_ORG_ID,
      JSON.stringify({
        onboarding: {
          wizardCompletedAt: "2026-01-02T03:04:05.000Z",
          checklistDismissedAt: DISMISSED_AT_ISO,
        },
      }),
    ],
    [
      MALFORMED_ORG_ID,
      JSON.stringify({
        onboarding: { checklistDismissedAt: "not-a-timestamp" },
      }),
    ],
    [
      NON_STRING_ORG_ID,
      JSON.stringify({ onboarding: { checklistDismissedAt: 1_770_000_000 } }),
    ],
    [
      PREFIX_ONLY_ORG_ID,
      JSON.stringify({ onboarding: { checklistDismissedAt: "2026-02-03T" } }),
    ],
    [
      IMPOSSIBLE_ORG_ID,
      JSON.stringify({
        onboarding: { checklistDismissedAt: "2026-02-31T00:00:00.000Z" },
      }),
    ],
    [UNTOUCHED_ORG_ID, JSON.stringify({})],
  ];

  for (const [orgId, settings] of orgs) {
    await client.query(
      `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "settings", "updated_at")
       VALUES ($1, $2, 'ISS-5991 Org', $3, $4::jsonb, now())`,
      [orgId, `org_${orgId}`, `iss5991-${orgId}`, settings]
    );
  }

  const users: ReadonlyArray<readonly [string, string]> = [
    [DISMISSED_USER_A, DISMISSED_ORG_ID],
    [DISMISSED_USER_B, DISMISSED_ORG_ID],
    [MALFORMED_USER, MALFORMED_ORG_ID],
    [NON_STRING_USER, NON_STRING_ORG_ID],
    [PREFIX_ONLY_USER, PREFIX_ONLY_ORG_ID],
    [IMPOSSIBLE_USER, IMPOSSIBLE_ORG_ID],
    [UNTOUCHED_USER, UNTOUCHED_ORG_ID],
  ];

  for (const [userId, orgId] of users) {
    // `(organization_id, email)` is unique and the dismissed org holds two
    // members, so the address is derived from the id rather than shared.
    await client.query(
      `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "updated_at")
       VALUES ($1, $2, $3, $4, now())`,
      [userId, `user_${userId}`, orgId, `${userId}@iss5991.invalid`]
    );
  }
}
