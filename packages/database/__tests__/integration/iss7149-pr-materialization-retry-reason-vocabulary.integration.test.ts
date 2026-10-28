/**
 * ISS-7149 — behavioural coverage for
 * `20260902100000_iss7149_pr_materialization_retry_reason_vocabulary`.
 *
 * The sibling text-scan suite
 * (`../iss7149-pr-materialization-retry-reason-vocabulary-migration.test.ts`)
 * reads the migration FILE, so everything it proves is true of a file that was
 * never applied. This suite reads the DATABASE instead — a fully migrated
 * Postgres, the one the CI `database-integration-tests` job provisions — so it
 * additionally proves the constraint reached the server.
 *
 * The REJECTION case is the load-bearing one. Prisma's differ does not model
 * CHECK constraints at all, so a dropped `pr_materialization_retries_reason_check`
 * produces no drift, no failed migration, and no red test anywhere else in the
 * repo: every acceptance assertion keeps passing precisely because an
 * unconstrained column accepts everything. Only an assertion that an UNDECLARED
 * value is refused can fail when the constraint goes missing.
 *
 * The reason literals are spelled out here rather than imported because
 * `PrMaterializationRetryTerminalReason` lives in `apps/api`, which this package
 * cannot import. That the TypeScript vocabulary and this column agreed member
 * for member was asserted from the owning side, by the round trip in
 * `apps/api/__tests__/integration/pr-materialization-retry-realdb.test.ts`, until
 * ISS-12435 removed that vocabulary and its round trip with the Loops drain;
 * this suite owns only what the storage boundary itself enforces.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
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

const DATABASE_URL = process.env.DATABASE_URL;

/** SQLSTATE raised by a violated CHECK constraint. */
const CHECK_VIOLATION_SQLSTATE = "23514";

const REASON_CONSTRAINT = "pr_materialization_retries_reason_check";

/** The two members ISS-7149 adds. */
const ADDED_REASONS = [
  "provider_delay_out_of_policy",
  "retry_horizon_exceeded",
] as const;

/**
 * One member the baseline already accepted. The migration is a widening, so a
 * predicate that replaced the vocabulary instead of extending it would start
 * rejecting rows that are already stored.
 */
const BASELINE_REASON = "attempts_exhausted";

/**
 * A value no member of the vocabulary spells, chosen to be plausible rather
 * than obviously junk: a near-miss is what a real drift produces.
 */
const UNDECLARED_REASON = "provider_delay_out_of_bounds";

describe.skipIf(!DATABASE_URL)(
  "ISS-7149 pr_materialization_retries reason vocabulary",
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
      /*
       * The reason CHECK is the only constraint under test, so the four foreign
       * keys are dropped for the duration rather than seeding an organization, a
       * user, an artifact, a loop and an installation repository whose shapes
       * have nothing to do with this migration. Precedent: the ISS-5981
       * integration suite likewise reshapes the schema inside its own
       * always-rolled-back transaction.
       */
      await client.query(
        `ALTER TABLE "pr_materialization_retries"
           DROP CONSTRAINT "pr_materialization_retries_organization_id_fkey",
           DROP CONSTRAINT "pr_materialization_retries_loop_id_fkey",
           DROP CONSTRAINT "pr_materialization_retries_source_artifact_id_fkey",
           DROP CONSTRAINT "pr_materialization_retries_base_repository_id_fkey"`
      );
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it.each([...ADDED_REASONS])(
      "stores %s, which the baseline vocabulary had no member for",
      async (reason) => {
        await expect(insertWithReason(client, reason)).resolves.toBe(reason);
      }
    );

    it("still stores a reason the baseline already accepted", async () => {
      await expect(insertWithReason(client, BASELINE_REASON)).resolves.toBe(
        BASELINE_REASON
      );
    });

    it("still stores a null reason, which both vocabularies accept", async () => {
      await expect(insertWithReason(client, null)).resolves.toBeNull();
    });

    /*
     * The counterfactual this file exists for: DROP the constraint (or narrow it
     * back to the baseline list, which no longer contains the added members) and
     * every other case in this repo stays green while this one turns red.
     */
    it("refuses an undeclared reason with a check violation", async () => {
      const error = await insertWithReason(client, UNDECLARED_REASON).then(
        () => {
          throw new Error(
            `Expected ${UNDECLARED_REASON} to violate ${REASON_CONSTRAINT}`
          );
        },
        (rejection: unknown) => rejection
      );

      // The SQLSTATE and the constraint name together: a 23514 alone could be
      // raised by any of the table's three other CHECKs (state, attempts, and
      // pull_request_number), none of which this migration touches.
      expect(sqlErrorCode(error)).toBe(CHECK_VIOLATION_SQLSTATE);
      expect(sqlErrorConstraint(error)).toBe(REASON_CONSTRAINT);
    });
  }
);

/**
 * Insert one retry row carrying `reason`, returning the value the column
 * actually stored. Rejects with the driver's error when a constraint refuses it.
 */
async function insertWithReason(
  client: Client,
  reason: string | null
): Promise<string | null> {
  const result = await client.query<{ reason: string | null }>(
    `INSERT INTO "pr_materialization_retries"
       ("id", "organization_id", "loop_id", "source_artifact_id",
        "base_repository_id", "pull_request_number", "reason", "updated_at")
     VALUES ($1, $2, $3, $4, $5, 42, $6, now())
     RETURNING "reason"`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      reason,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected the insert to return its stored row");
  }
  return row.reason;
}

function sqlErrorCode(error: unknown): string | undefined {
  return readStringField(error, "code");
}

function sqlErrorConstraint(error: unknown): string | undefined {
  return readStringField(error, "constraint");
}

/** `node-pg` reports SQLSTATE and the offending constraint on the error itself. */
function readStringField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
