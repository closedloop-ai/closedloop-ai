/**
 * ISS-8284 — behavioural coverage for
 * `20260917153000_iss8284_branch_materialization_retry_reason_not_pushed`.
 *
 * The sibling text-scan suite
 * (`../iss8284-branch-materialization-retry-reason-not-pushed-migration.test.ts`)
 * reads the migration FILE, so everything it proves is equally true of a file
 * that was never applied. This suite reads the DATABASE instead — the fully
 * migrated Postgres the CI `database-integration-tests` job provisions — so it
 * additionally proves the widened constraint reached the server.
 *
 * The REJECTION case is the load-bearing one, for the reason the ISS-7149 suite
 * this mirrors spells out: Prisma's differ does not model CHECK constraints at
 * all, so a dropped `branch_materialization_retries_reason_check` produces no
 * drift, no failed migration, and no red test anywhere else in the repo. Every
 * ACCEPTANCE assertion keeps passing precisely because an unconstrained column
 * accepts everything. Only an assertion that an UNDECLARED value is refused can
 * fail when the constraint goes missing.
 *
 * The reason literals are spelled out rather than imported because
 * `BranchMaterializationRetryTerminalReason` lives in `apps/api`, which this
 * package cannot import. That the TypeScript vocabulary and this column agree
 * member for member is asserted from the owning side, by the migration-parity
 * case in
 * `apps/api/app/agent-sessions/service/artifact-links/branch-materialization-retry-not-pushed-vocabulary.test.ts`;
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

const REASON_CONSTRAINT = "branch_materialization_retries_reason_check";

/** The one member ISS-8284 adds. */
const ADDED_REASON = "not_pushed";

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
const UNDECLARED_REASON = "never_pushed";

describe.skipIf(!DATABASE_URL)(
  "ISS-8284 branch_materialization_retries reason vocabulary",
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
       * The reason CHECK is the only constraint under test, so the two foreign
       * keys are dropped for the duration rather than seeding an organization
       * and an artifact whose shapes have nothing to do with this migration.
       * Precedent: the ISS-7149 integration suite this mirrors does the same
       * inside its own always-rolled-back transaction.
       */
      await client.query(
        `ALTER TABLE "branch_materialization_retries"
           DROP CONSTRAINT "branch_materialization_retries_organization_id_fkey",
           DROP CONSTRAINT "branch_materialization_retries_source_artifact_id_fkey"`
      );
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("stores not_pushed, which the baseline vocabulary had no member for", async () => {
      await expect(insertWithReason(client, ADDED_REASON)).resolves.toBe(
        ADDED_REASON
      );
    });

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
     * back to the baseline list, which has no `not_pushed`) and every other case
     * in this repo stays green while this one turns red.
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
      // raised by either of the table's other two CHECKs (state and the
      // non-negative counters), neither of which this migration touches.
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
    `INSERT INTO "branch_materialization_retries"
       ("id", "organization_id", "source_artifact_id", "repository_full_name",
        "branch_name", "branch_ref", "reason", "updated_at")
     VALUES ($1, $2, $3, 'acme/widgets', 'feat/thing', '{}'::jsonb, $4, now())
     RETURNING "reason"`,
    [randomUUID(), randomUUID(), randomUUID(), reason]
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
