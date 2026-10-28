import { randomUUID } from "node:crypto";
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
import {
  type SessionDetailSeed,
  seedSessionDetailParents,
} from "../test-helpers/session-detail-seed";

/**
 * ISS-8517: what the two-armed `estimated_cost` repair actually MOVES, against
 * real Postgres, by executing the SHIPPED migration file rather than a
 * transcription of it.
 *
 * The sibling `iss8517-...-migration.test.ts` pins the SQL text. That proves the
 * migration SAYS the right thing, not that Postgres DOES the right thing with
 * it — and the gap between those two is where this ticket's risk lives, because
 * the predicates lean on three-valued logic (`IS NULL`, `IS DISTINCT FROM`,
 * `NOT EXISTS`) that reads correctly and behaves surprisingly. `NULL = 0` is
 * NULL, not TRUE; a row with no matching rollup disappears from an inner join
 * rather than being "skipped"; and a `numeric` comparison against a
 * `NOT NULL DEFAULT 0` column is exactly the shape that silently writes a
 * fabricated zero if `> 0` is ever dropped. Each of those is a case below.
 *
 * Reading the file off disk and handing it to the server verbatim is deliberate:
 * a copy of the statements inside this test would keep passing after someone
 * edited the migration, which is the one regression this file exists to prevent.
 * That guarantee comes from reading the bytes, NOT from the migration's shape —
 * node-pg sends a parameterless string over the simple query protocol, so a
 * multi-statement file would execute here just as well.
 *
 * Every case runs inside a transaction that is rolled back, so nothing persists —
 * including the repair, which on a seeded database would otherwise be a real
 * whole-table write.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION =
  "20260903140000_iss8517_backfill_session_detail_estimated_cost";

/**
 * The shipped ceiling, and the declaration it lives on. Named here so the
 * guard-abort cases can lower it with ONE substitution off the shipped bytes
 * rather than transcribing a predicate — the whole point of executing the file
 * is that nothing about the decision is re-typed.
 */
const CEILING_DECLARATION = "max_inline_rows CONSTANT bigint";
const SHIPPED_CEILING = "250000";
/** Small enough to seed past, large enough that `+ 1` is not the only margin. */
const TEST_CEILING = 2;

const ARM_1_RAISE_RE = /ISS-8517 arm 1/;
const ARM_2_RAISE_RE = /ISS-8517 arm 2/;

/** The shipped file, verbatim. */
function shippedMigrationSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
}

/**
 * The shipped file with only the ceiling constant replaced.
 *
 * Everything else — both preflights, both comparisons, both `RAISE`s — is the
 * shipped text. Seeding 250,001 real rows to cross the real ceiling would take
 * minutes and prove the same thing.
 */
function migrationWithCeiling(ceiling: number): string {
  const shipped = shippedMigrationSql();
  const lowered = shipped.replace(
    `${CEILING_DECLARATION} := ${SHIPPED_CEILING}`,
    `${CEILING_DECLARATION} := ${ceiling}`
  );
  // A substitution that silently matched nothing would make these cases assert
  // the ordinary success path while claiming to test the abort.
  if (lowered === shipped) {
    throw new Error(`${MIGRATION}: ceiling declaration not found to lower`);
  }
  return lowered;
}

describe.skipIf(!DATABASE_URL)(
  "ISS-8517 session_detail.estimated_cost backfill",
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

    it("arm 1 repairs only the unknowns that a positive rollup can vouch for", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");

      // One row per branch of arm 1. The ones that must NOT move matter more
      // than the ones that must: this migration is irreversible, so a row it
      // wrongly touches cannot be put back.
      const repairableFromNull = await seedSession(client, seed, {
        storedCost: null,
        rollupCost: 0.5,
      });
      const repairableFromZero = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0.5,
      });
      const alreadyPriced = await seedSession(client, seed, {
        storedCost: 9.99,
        rollupCost: 0.5,
      });
      // `estimated_cost` on the rollup is an unconstrained Decimal(14,6) — a
      // negative is representable, and `> 0` is what excludes it from arm 1.
      // Without this case the predicate could be relaxed to `<> 0` and stay
      // green while writing a negative dollar figure into the displayed cost.
      // Arm 2 then clears it: a negative is not evidence that anything was
      // measured, so the row is an unknown like any other.
      const negativeRollup = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: -0.5,
      });

      await client.query(shippedMigrationSql());

      // Repaired: a real measurement existed and this column had failed to
      // receive it.
      expect(await readCost(client, repairableFromNull)).toBe("0.500000");
      expect(await readCost(client, repairableFromZero)).toBe("0.500000");
      // Never lower a figure that is already real.
      expect(await readCost(client, alreadyPriced)).toBe("9.990000");
      // Not copied — and the assertion is `null`, not `-0.500000`, which is the
      // mutation this case kills.
      expect(await readCost(client, negativeRollup)).toBeNull();
    });

    it("arm 2 clears the fabricated zeros and nothing else", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");

      // (a) nothing measured this session anywhere: no token rows, and a rollup
      // that is zero on cost AND on all four token counts.
      const unmeasuredZero = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0,
      });
      // (a') the same claim with no rollup row at all — the inner-join case,
      // which `NOT EXISTS` covers and an inner join would have dropped.
      const unmeasuredZeroNoRollup = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: null,
      });
      // (b) per-model token rows exist, so something DID measure this session.
      // The probe reads their existence only — it never sums their cost.
      const hasTokenUsageRows = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0,
        tokenUsageRows: 1,
      });
      // (c) the rollup carries tokens but no cost: measured, not yet priced.
      const rollupHasTokens = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0,
        rollupCacheReadTokens: 12,
      });
      // (d) arm 1's population. Arm 1 repairs it; arm 2 must never then clear
      // what arm 1 just wrote — the disjointness claim, executed.
      const repairedByArmOne = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0.5,
      });
      // (e) already NULL: already saying "unknown", so there is nothing to say.
      const alreadyNull = await seedSession(client, seed, {
        storedCost: null,
        rollupCost: 0,
      });
      const alreadyNullNoRollup = await seedSession(client, seed, {
        storedCost: null,
        rollupCost: null,
      });
      // (f) a real positive figure is never touched by either arm.
      const positive = await seedSession(client, seed, {
        storedCost: 9.99,
        rollupCost: 0,
      });

      await client.query(shippedMigrationSql());

      expect(await readCost(client, unmeasuredZero)).toBeNull();
      expect(await readCost(client, unmeasuredZeroNoRollup)).toBeNull();
      expect(await readCost(client, hasTokenUsageRows)).toBe("0.000000");
      expect(await readCost(client, rollupHasTokens)).toBe("0.000000");
      expect(await readCost(client, repairedByArmOne)).toBe("0.500000");
      expect(await readCost(client, alreadyNull)).toBeNull();
      expect(await readCost(client, alreadyNullNoRollup)).toBeNull();
      expect(await readCost(client, positive)).toBe("9.990000");
    });

    // `updated_at` is a Prisma `@updatedAt` column with no database default and
    // no trigger, so a raw UPDATE that does not name it leaves it alone. That is
    // deliberate: the column is the Sessions list's "Updated" value and its
    // `sortBy=updated` key, so bumping it would reorder the list for a change no
    // user made. Asserted as an executed fact rather than left to the header,
    // for BOTH arms — a `now()` added to one of them would be invisible here if
    // only the other were checked.
    it("moves the cost without touching either row's updated_at", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");
      const repaired = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0.5,
      });
      const cleared = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0,
      });

      // Backdated deliberately. Postgres `now()` is TRANSACTION-scoped, so a
      // row seeded with `now()` and then bumped by a `now()` inside the same
      // transaction lands on the identical timestamp — the assertion would pass
      // against a migration that DID bump the column. Verified by mutation: with
      // `SET … , "updated_at" = now()` added, the `now()`-seeded version of this
      // test stayed green and this one goes red.
      await client.query(
        "UPDATE session_detail SET updated_at = TIMESTAMP '2020-01-01 00:00:00' WHERE artifact_id = ANY($1)",
        [[repaired, cleared]]
      );
      const beforeRepaired = await readUpdatedAt(client, repaired);
      const beforeCleared = await readUpdatedAt(client, cleared);

      await client.query(shippedMigrationSql());

      expect(await readCost(client, repaired)).toBe("0.500000");
      expect(await readCost(client, cleared)).toBeNull();
      expect(await readUpdatedAt(client, repaired)).toEqual(beforeRepaired);
      expect(await readUpdatedAt(client, cleared)).toEqual(beforeCleared);
    });

    it("is idempotent: a second application moves nothing, in either arm", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");
      const repaired = await seedSession(client, seed, {
        storedCost: null,
        rollupCost: 0.5,
      });
      const cleared = await seedSession(client, seed, {
        storedCost: 0,
        rollupCost: 0,
      });

      await client.query(shippedMigrationSql());
      const repairedAfterFirst = await readCost(client, repaired);
      const clearedAfterFirst = await readCost(client, cleared);

      // Prisma's deploy-recovery can re-run a migration it marked rolled back,
      // and the documented operator escape re-runs the deploy by hand, so a
      // second application is a REAL path rather than a hypothetical.
      await client.query(shippedMigrationSql());

      expect(repairedAfterFirst).toBe("0.500000");
      expect(clearedAfterFirst).toBeNull();
      expect(await readCost(client, repaired)).toBe(repairedAfterFirst);
      expect(await readCost(client, cleared)).toBeNull();
    });

    it("reports zero repairable rows once both populations are drained", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");
      await seedSession(client, seed, { storedCost: null, rollupCost: 0.5 });
      await seedSession(client, seed, { storedCost: 0, rollupCost: 0.5 });
      await seedSession(client, seed, { storedCost: 0, rollupCost: 0 });

      expect(await countArmOne(client)).toBeGreaterThanOrEqual(2);
      expect(await countArmTwo(client)).toBeGreaterThanOrEqual(1);

      await client.query(shippedMigrationSql());

      // These counts are this test's OWN transcription of the two predicates, so
      // what they pin is transcription-vs-statement: neither arm leaves behind a
      // row its own predicate still selects.
      expect(await countArmOne(client)).toBe(0);
      expect(await countArmTwo(client)).toBe(0);
    });

    // THE GUARD, EXECUTED, ONCE PER ARM. The sibling text-pin proves each
    // ceiling is written down and that its `RAISE EXCEPTION` sits between the
    // two arms; neither proves Postgres ACTS on it.
    // `packages/database/AGENTS.md`: "A guard/source test must EXECUTE the
    // decision against synthetic inputs, not assert that a predicate appears
    // somewhere."
    //
    // Each case drains BOTH populations with the shipped file first, so the only
    // candidates left are the ones it then seeds — otherwise a pre-existing row
    // in a shared database could be what trips the ceiling, and the case would
    // pass without its own seed mattering.
    it("arm 1 aborts above the ceiling, leaving every row where it was", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");
      await client.query(shippedMigrationSql());

      // Exactly ceiling + 1 qualifying rows: one more than the statement is
      // willing to rewrite in a single transaction.
      const sessions: string[] = [];
      for (let index = 0; index <= TEST_CEILING; index += 1) {
        sessions.push(
          await seedSession(client, seed, {
            storedCost: index === 0 ? null : 0,
            rollupCost: 0.5,
          })
        );
      }
      expect(sessions).toHaveLength(TEST_CEILING + 1);
      expect(await countArmOne(client)).toBe(TEST_CEILING + 1);

      // A raised exception poisons the whole transaction, which would take the
      // seeded rows with it and leave nothing to assert against. The savepoint
      // unwinds only the migration's own effects, so the rows below are read at
      // exactly the state the aborted migration left them in.
      await client.query("SAVEPOINT before_guard");
      await expect(
        client.query(migrationWithCeiling(TEST_CEILING))
      ).rejects.toThrow(ARM_1_RAISE_RE);
      await client.query("ROLLBACK TO SAVEPOINT before_guard");

      // Changed nothing: every row still holds the unknown it started with.
      expect(await readCost(client, sessions[0])).toBeNull();
      for (const session of sessions.slice(1)) {
        expect(await readCost(client, session)).toBe("0.000000");
      }
      expect(await countArmOne(client)).toBe(TEST_CEILING + 1);
    });

    it("arm 2 aborts above the ceiling, leaving every row where it was", async () => {
      const seed = await seedSessionDetailParents(client, "iss8517");
      await client.query(shippedMigrationSql());

      const sessions: string[] = [];
      for (let index = 0; index <= TEST_CEILING; index += 1) {
        sessions.push(
          await seedSession(client, seed, { storedCost: 0, rollupCost: 0 })
        );
      }
      expect(sessions).toHaveLength(TEST_CEILING + 1);
      expect(await countArmOne(client)).toBe(0);
      expect(await countArmTwo(client)).toBe(TEST_CEILING + 1);

      await client.query("SAVEPOINT before_guard");
      await expect(
        client.query(migrationWithCeiling(TEST_CEILING))
      ).rejects.toThrow(ARM_2_RAISE_RE);
      await client.query("ROLLBACK TO SAVEPOINT before_guard");

      for (const session of sessions) {
        expect(await readCost(client, session)).toBe("0.000000");
      }
      expect(await countArmTwo(client)).toBe(TEST_CEILING + 1);
    });
  }
);

/**
 * One session, with a stored cost and optionally a rollup beside it.
 * `rollupCost: null` means NO rollup row exists — a distinct case from a rollup
 * row holding 0, and the two must not be collapsed. `tokenUsageRows` seeds
 * per-model rows whose EXISTENCE is what arm 2 probes; their cost is never read.
 */
async function seedSession(
  client: Client,
  seed: SessionDetailSeed,
  costs: {
    storedCost: number | null;
    rollupCost: number | null;
    rollupCacheReadTokens?: number;
    tokenUsageRows?: number;
  }
): Promise<string> {
  const artifactId = randomUUID();

  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_at, updated_at)
     VALUES ($1, $2, 'SESSION', 'iss8517', 'active', now(), now())`,
    [artifactId, seed.organizationId]
  );
  await client.query(
    `INSERT INTO session_detail (
       artifact_id, compute_target_id, external_session_id,
       session_started_at, session_updated_at, last_activity_at, updated_at,
       estimated_cost
     ) VALUES ($1, $2, $3, now(), now(), now(), now(), $4)`,
    [artifactId, seed.computeTargetId, `ext-${artifactId}`, costs.storedCost]
  );

  if (costs.rollupCost !== null) {
    await client.query(
      `INSERT INTO agent_session_usage_rollups (
         artifact_id, estimated_cost, cache_read_tokens, updated_at
       ) VALUES ($1, $2, $3, now())`,
      [artifactId, costs.rollupCost, costs.rollupCacheReadTokens ?? 0]
    );
  }

  for (let index = 0; index < (costs.tokenUsageRows ?? 0); index += 1) {
    await client.query(
      `INSERT INTO agent_session_token_usage (
         id, agent_session_id, model, estimated_cost, updated_at
       ) VALUES ($1, $2, $3, 0, now())`,
      [randomUUID(), artifactId, `model-${index}`]
    );
  }

  return artifactId;
}

async function readCost(
  client: Client,
  artifactId: string
): Promise<string | null> {
  const { rows } = await client.query<{ estimated_cost: string | null }>(
    "SELECT estimated_cost FROM session_detail WHERE artifact_id = $1",
    [artifactId]
  );
  // Throws rather than asserts: a missing row means the seed failed, and an
  // `expect` in a helper reports that as a confusing failure attributed to
  // whichever case happened to call it first.
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one session_detail row for ${artifactId}, found ${rows.length}`
    );
  }
  return rows[0].estimated_cost;
}

async function readUpdatedAt(
  client: Client,
  artifactId: string
): Promise<Date> {
  const { rows } = await client.query<{ updated_at: Date }>(
    "SELECT updated_at FROM session_detail WHERE artifact_id = $1",
    [artifactId]
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one session_detail row for ${artifactId}, found ${rows.length}`
    );
  }
  return rows[0].updated_at;
}

/** Arm 1's selection predicate, run as a plain count. */
async function countArmOne(client: Client): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM session_detail AS s
       JOIN agent_session_usage_rollups AS r
         ON r.artifact_id = s.artifact_id
      WHERE r.estimated_cost > 0
        AND (s.estimated_cost IS NULL OR s.estimated_cost = 0)
        AND s.estimated_cost IS DISTINCT FROM r.estimated_cost`
  );
  return Number(rows[0].count);
}

/** Arm 2's selection predicate, run as a plain count. */
async function countArmTwo(client: Client): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM session_detail AS s
      WHERE s.estimated_cost = 0
        AND NOT EXISTS (
          SELECT 1 FROM agent_session_token_usage AS u
           WHERE u.agent_session_id = s.artifact_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_session_usage_rollups AS r
           WHERE r.artifact_id = s.artifact_id
             AND (r.estimated_cost > 0
                  OR r.input_tokens + r.output_tokens
                     + r.cache_read_tokens + r.cache_write_tokens > 0)
        )`
  );
  return Number(rows[0].count);
}
