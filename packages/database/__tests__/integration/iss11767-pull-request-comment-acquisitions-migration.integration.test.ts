/**
 * ISS-11767 (PLN-2174 Step 1) — behavioural coverage for
 * `20261009134453_iss11767_pull_request_comment_acquisitions`, which creates
 * the per-lane proof table and seeds it from the existing reconcile stamps.
 *
 * Runs the committed SQL verbatim against a real Postgres, inside a
 * transaction that drops the already-applied table first and is always rolled
 * back. Skips when DATABASE_URL is unset.
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

const MIGRATION_DIR =
  "20261009134453_iss11767_pull_request_comment_acquisitions";

/** One statement per round trip, as Prisma's applier sends them. */
const MIGRATION_STATEMENTS = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    MIGRATION_DIR,
    "migration.sql"
  ),
  "utf8"
)
  .replace(COMMENT_LINE_RE, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f1767-0000-7000-8000-000000000001";
const OTHER_ORG_ID = "019f1767-0000-7000-8000-000000000002";
const BRANCH_ARTIFACT_ID = "019f1767-0000-7000-8000-000000000003";
const RECONCILED_AT = "2026-10-05T12:00:00.000Z";
const LATER = "2026-10-05T13:00:00.000Z";
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = "23503";

/** Lane and status literals, not the TS consts: the migration hard-codes them. */
const ALL_LANES = ["ISSUE_COMMENTS", "REVIEW_COMMENTS", "REVIEWS"];

const PULL_REQUESTS = {
  reconciledAtLatestAttempt: {
    number: 1,
    reconciledAt: RECONCILED_AT,
    attemptedAt: RECONCILED_AT,
  },
  reconciledNeverAttempted: {
    number: 2,
    reconciledAt: RECONCILED_AT,
    attemptedAt: null,
  },
  supersededByLaterAttempt: {
    number: 3,
    reconciledAt: RECONCILED_AT,
    attemptedAt: LATER,
  },
  neverReconciled: { number: 4, reconciledAt: null, attemptedAt: null },
} as const;

type AcquisitionRow = {
  lane: string;
  organizationId: string;
  generation: number;
  status: string;
  itemCount: number | null;
  errorCode: string | null;
  listedAt: Date;
  lastCompleteListedAt: Date | null;
  incompleteStreak: number;
  retractedCount: number | null;
  recordedAt: Date | null;
};

describe.skipIf(!DATABASE_URL)(
  "ISS-11767 pull_request_comment_acquisitions migration",
  () => {
    let client: Client;
    const ids = new Map<number, string>();

    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    beforeEach(async () => {
      await client.query("BEGIN");
      await client.query('DROP TABLE "pull_request_comment_acquisitions"');
      await client.query('DROP TYPE "PullRequestCommentLaneStatus"');
      await client.query('DROP TYPE "PullRequestCommentLane"');
      await seedFixture(client, ids);
      for (const statement of MIGRATION_STATEMENTS) {
        await client.query(statement);
      }
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it.each([
      ["a PR whose latest attempt reconciled", "reconciledAtLatestAttempt"],
      ["a reconciled PR with no attempt stamp", "reconciledNeverAttempted"],
    ] as const)("seeds three COMPLETE lanes for %s", async (_label, key) => {
      const rows = await readRows(client, idOf(ids, key));

      expect(rows.map((row) => row.lane)).toEqual(ALL_LANES);
      for (const row of rows) {
        expect(row).toEqual({
          lane: row.lane,
          organizationId: ORG_ID,
          generation: 1,
          status: "COMPLETE",
          itemCount: null,
          errorCode: null,
          listedAt: new Date(RECONCILED_AT),
          lastCompleteListedAt: new Date(RECONCILED_AT),
          incompleteStreak: 0,
          retractedCount: null,
          recordedAt: expect.any(Date),
        });
      }
    });

    it.each([
      ["a PR whose later attempt did not complete", "supersededByLaterAttempt"],
      ["a PR never reconciled", "neverReconciled"],
    ] as const)("seeds nothing for %s", async (_label, key) => {
      expect(await readRows(client, idOf(ids, key))).toEqual([]);
    });

    it("refuses a row whose organization is not its pull request's", async () => {
      const pullRequestId = idOf(ids, "neverReconciled");
      await client.query("SAVEPOINT cross_org");
      await expect(
        client.query(
          `INSERT INTO "pull_request_comment_acquisitions"
             ("pull_request_detail_id", "lane", "organization_id", "generation",
              "status", "listed_at", "incomplete_streak", "recorded_at")
           VALUES ($1, 'REVIEWS', $2, 1, 'COMPLETE', now(), 0, now())`,
          [pullRequestId, OTHER_ORG_ID]
        )
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
      await client.query("ROLLBACK TO SAVEPOINT cross_org");
    });

    it("deletes a pull request's lanes with the pull request", async () => {
      const pullRequestId = idOf(ids, "reconciledAtLatestAttempt");

      await client.query('DELETE FROM "pull_request_detail" WHERE "id" = $1', [
        pullRequestId,
      ]);

      expect(await readRows(client, pullRequestId)).toEqual([]);
    });
  }
);

function idOf(
  ids: ReadonlyMap<number, string>,
  key: keyof typeof PULL_REQUESTS
): string {
  const id = ids.get(PULL_REQUESTS[key].number);
  if (!id) {
    throw new Error(`fixture pull request ${key} was not seeded`);
  }
  return id;
}

async function readRows(
  client: Client,
  pullRequestDetailId: string
): Promise<AcquisitionRow[]> {
  const { rows } = await client.query<AcquisitionRow>(
    `SELECT "lane", "organization_id" AS "organizationId", "generation",
       "status", "item_count" AS "itemCount", "error_code" AS "errorCode",
       "listed_at" AT TIME ZONE 'UTC' AS "listedAt",
       "last_complete_listed_at" AT TIME ZONE 'UTC' AS "lastCompleteListedAt",
       "incomplete_streak" AS "incompleteStreak",
       "retracted_count" AS "retractedCount", "recorded_at" AS "recordedAt"
     FROM "pull_request_comment_acquisitions"
     WHERE "pull_request_detail_id" = $1
     ORDER BY "lane"`,
    [pullRequestDetailId]
  );
  return rows;
}

async function seedFixture(
  client: Client,
  ids: Map<number, string>
): Promise<void> {
  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
       VALUES ($1, $2, 'ISS-11767 Org', $3, now())`,
      [organizationId, `org_${organizationId}`, `iss11767-${organizationId}`]
    );
  }
  await client.query(
    `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
     VALUES ($1, $2, 'BRANCH', 'iss11767-branch', 'OPEN', now())`,
    [BRANCH_ARTIFACT_ID, ORG_ID]
  );
  ids.clear();
  for (const pullRequest of Object.values(PULL_REQUESTS)) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO "pull_request_detail"
         ("organization_id", "branch_artifact_id", "repository_full_name", "number",
          "comments_reconciled_at", "comments_reconcile_attempted_at")
       VALUES ($1, $2, 'acme/widgets', $3, $4, $5)
       RETURNING "id"`,
      [
        ORG_ID,
        BRANCH_ARTIFACT_ID,
        pullRequest.number,
        pullRequest.reconciledAt,
        pullRequest.attemptedAt,
      ]
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("fixture pull request insert returned no id");
    }
    ids.set(pullRequest.number, id);
  }
}
