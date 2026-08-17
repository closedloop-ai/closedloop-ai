/**
 * ISS-4601 — the core proof, against a REAL Postgres: a genuinely INVALID index
 * is detected by the post-deploy sweep and named in the report.
 *
 * The invalid index is FORCED the way production produces one, not by poking the
 * catalog: `CREATE UNIQUE INDEX CONCURRENTLY` over a table that already has
 * duplicate keys fails its second pass and leaves an INVALID index of that name
 * behind. This test also pins the two facts that make the bug silent — a repeated
 * `IF NOT EXISTS` build no-ops onto the remnant and reports success, and
 * `pg_indexes` still lists the index as if nothing were wrong — so a regression
 * that reverts the sweep to a name check would fail here.
 *
 * Uses an isolated schema it creates and drops. Never touches `public` or
 * `_prisma_migrations`. Skips when DATABASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";
import {
  formatMigrateCompletionLine,
  sweepInvalidIndexes,
} from "../../scripts/invalid-index-sweep";

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = "iss4601_invalid_index_sweep_it";
const TABLE = "sweep_target";
const INVALID_INDEX = "sweep_target_key_uidx";
const HEALTHY_INDEX = "sweep_target_payload_idx";

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

async function withClient<T>(
  run: (client: {
    query: (text: string, values?: unknown[]) => Promise<unknown>;
  }) => Promise<T>
): Promise<T> {
  const client = createSslClient(requireUrl());
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Builds the fixture schema and leaves exactly one INVALID index in it, produced
 * by a real failed concurrent build (duplicate keys break the uniqueness check on
 * the second pass, after the index relation already exists).
 */
async function seedInvalidIndex(): Promise<void> {
  const schema = quoteIdentifier(TEST_SCHEMA);
  await withClient(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(
      `CREATE TABLE ${schema}.${quoteIdentifier(TABLE)} ("key" int NOT NULL, "payload" text)`
    );
    await client.query(
      `INSERT INTO ${schema}.${quoteIdentifier(TABLE)} ("key", "payload") VALUES (1, 'a'), (1, 'b'), (2, 'c')`
    );
    // A healthy index alongside it, so the sweep is proven to discriminate rather
    // than just returning everything in the schema.
    await client.query(
      `CREATE INDEX ${quoteIdentifier(HEALTHY_INDEX)} ON ${schema}.${quoteIdentifier(TABLE)} ("payload")`
    );
    // The failure IS the fixture: this build gets far enough to create the index
    // relation, then aborts on the duplicate key, leaving it INVALID. If Postgres
    // ever let it succeed the whole suite would be vacuous, so fail setup loudly.
    let concurrentBuildFailed = false;
    try {
      await client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY ${quoteIdentifier(INVALID_INDEX)} ON ${schema}.${quoteIdentifier(TABLE)} ("key")`
      );
    } catch {
      concurrentBuildFailed = true;
    }
    if (!concurrentBuildFailed) {
      throw new Error(
        "fixture invalid: the unique concurrent build over duplicate keys succeeded, so no INVALID index was produced"
      );
    }
  });
}

describe.skipIf(!DATABASE_URL)(
  "sweepInvalidIndexes against a real invalid index (ISS-4601)",
  () => {
    beforeAll(async () => {
      await seedInvalidIndex();
    });

    afterAll(async () => {
      await withClient((client) =>
        client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA)} CASCADE`
        )
      );
    });

    it("leaves a remnant that name-based checks cannot distinguish from a healthy index", async () => {
      const listed = await withClient((client) =>
        client.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
          [TEST_SCHEMA]
        )
      );
      const names = (listed as { rows: { indexname: string }[] }).rows.map(
        (row) => row.indexname
      );
      // This is exactly why the sweep must read pg_index.indisvalid: the unusable
      // index is present and indistinguishable here.
      expect(names).toContain(INVALID_INDEX);
      expect(names).toContain(HEALTHY_INDEX);
    });

    it("reports success while silently no-oping when the build is retried with IF NOT EXISTS", async () => {
      // The production silence: the retry `migrate deploy` performs, which is what
      // makes Prisma record the migration applied and the deploy go green.
      await withClient((client) =>
        client.query(
          `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdentifier(INVALID_INDEX)} ON ${quoteIdentifier(TEST_SCHEMA)}.${quoteIdentifier(TABLE)} ("key")`
        )
      );
      const stillInvalid = await withClient((client) =>
        client.query(
          `SELECT indisvalid FROM pg_index WHERE indexrelid = '${quoteIdentifier(TEST_SCHEMA)}.${quoteIdentifier(INVALID_INDEX)}'::regclass`
        )
      );
      expect(
        (stillInvalid as { rows: { indisvalid: boolean }[] }).rows[0].indisvalid
      ).toBe(false);
    });

    it("names the invalid index, its table, and the concurrent recovery commands", async () => {
      const warnings: string[] = [];
      const found = await sweepInvalidIndexes(requireUrl(), TEST_SCHEMA, {
        logger: { warn: (message) => warnings.push(message) },
      });

      expect(found).not.toBeNull();
      expect(found?.map((index) => index.name)).toEqual([INVALID_INDEX]);
      expect(found?.[0]).toMatchObject({
        schema: TEST_SCHEMA,
        table: TABLE,
      });

      const report = warnings.join("\n");
      expect(report).toContain(`${TEST_SCHEMA}.${INVALID_INDEX}`);
      // The recovery recipe, rendered for THIS index (ISS-4565): bounded drop,
      // concurrent rebuild derived from the live definition, re-verify.
      expect(report).toContain("SET lock_timeout = '5s';");
      expect(report).toContain(
        `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(TEST_SCHEMA)}.${quoteIdentifier(INVALID_INDEX)};`
      );
      expect(report).toContain(
        `CREATE UNIQUE INDEX CONCURRENTLY ${INVALID_INDEX} ON ${TEST_SCHEMA}.${TABLE} USING btree (key);`
      );
      expect(report).toContain("indisvalid");
      // The duplicate-key build fails during its FIRST pass, so indisready is
      // false here — pinned so the two remnant states cannot silently swap.
      expect(found?.[0].ready).toBe(false);
      expect(report).toContain("(its first build pass never finished)");
      // Both recoveries, because the sweep reads no migration history and so
      // cannot know which one applies to this index.
      expect(report).toContain("RECORDED APPLIED");
      expect(report).toContain("NOT RECORDED APPLIED");
    });

    it("makes the deploy report a qualified, non-clean completion", async () => {
      const found = await sweepInvalidIndexes(requireUrl(), TEST_SCHEMA, {
        logger: { warn: () => undefined },
      });

      const line = formatMigrateCompletionLine(found);
      expect(line).not.toContain("✓ Migrations completed successfully");
      expect(line).toContain("NOT a clean deploy");
      expect(line).toContain(`${TEST_SCHEMA}.${INVALID_INDEX}`);
    });

    it("excludes a build that is still running, so the recipe never targets live work", async () => {
      // A `CREATE INDEX CONCURRENTLY` is indisvalid=false for its ENTIRE run, so
      // catalog state alone cannot tell it from an abandoned remnant. Held here
      // deterministically: an open transaction with a snapshot on the table makes
      // the build wait in its first phase rather than racing to completion.
      const schema = quoteIdentifier(TEST_SCHEMA);
      const inFlight = "sweep_target_payload_inflight_idx";
      const blocker = createSslClient(requireUrl());
      const builder = createSslClient(requireUrl());
      await blocker.connect();
      await builder.connect();
      try {
        // REPEATABLE READ, not the default: a READ COMMITTED transaction releases
        // its snapshot when the statement ends, so it would not hold the build in
        // its "waiting for old snapshots" phase.
        await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await blocker.query(`SELECT count(*) FROM ${schema}."${TABLE}"`);

        // Deliberately not awaited: it blocks until the transaction above ends.
        const building = builder
          .query(
            `CREATE INDEX CONCURRENTLY ${quoteIdentifier(inFlight)} ON ${schema}."${TABLE}" ("payload")`
          )
          .catch(() => undefined);

        // Wait for the build to actually register, rather than sleeping a guess.
        let registered = false;
        for (let attempt = 0; attempt < 100 && !registered; attempt++) {
          const progress = await withClient((client) =>
            client.query(
              "SELECT count(*)::int AS n FROM pg_stat_progress_create_index WHERE index_relid = to_regclass($1)::oid",
              [`${TEST_SCHEMA}.${inFlight}`]
            )
          );
          registered = (progress as { rows: { n: number }[] }).rows[0].n > 0;
          if (!registered) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(registered).toBe(true);

        // It IS indisvalid=false right now — so an exclusion, not absence, is what
        // keeps it out of the sweep below.
        const state = await withClient((client) =>
          client.query(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)::oid",
            [`${TEST_SCHEMA}.${inFlight}`]
          )
        );
        expect(
          (state as { rows: { indisvalid: boolean }[] }).rows[0].indisvalid
        ).toBe(false);

        const found = await sweepInvalidIndexes(requireUrl(), TEST_SCHEMA, {
          logger: { warn: () => undefined },
        });
        expect(found?.map((index) => index.name)).not.toContain(inFlight);

        await blocker.query("COMMIT");
        await building;
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await builder.end().catch(() => undefined);
        await withClient((client) =>
          client.query(
            `DROP INDEX IF EXISTS ${schema}.${quoteIdentifier(inFlight)}`
          )
        );
      }
    });

    it("excludes an index being DROPPED CONCURRENTLY — the recipe must not target a deliberate removal", async () => {
      // `DROP INDEX CONCURRENTLY` clears indisvalid FIRST, then waits minutes for
      // old snapshots. In that window the index reads ready=true, valid=false,
      // live=TRUE and has NO `pg_stat_progress_create_index` row — so it is
      // indistinguishable from an abandoned remnant by the create-progress
      // anti-join alone, and the sweep would tell the operator to rebuild the
      // very index they are removing (and inflate invalid_index_count with it).
      // The dropping backend does hold a ShareUpdateExclusiveLock on the index,
      // which is what excludes it.
      const schema = quoteIdentifier(TEST_SCHEMA);
      const doomed = "sweep_target_doomed_idx";
      const blocker = createSslClient(requireUrl());
      const dropper = createSslClient(requireUrl());
      await blocker.connect();
      await dropper.connect();
      try {
        await withClient((client) =>
          client.query(
            `CREATE INDEX ${quoteIdentifier(doomed)} ON ${schema}."${TABLE}" ("payload")`
          )
        );

        // Same REPEATABLE READ hold as the in-flight build case above: it parks
        // the concurrent drop rather than letting it race to completion.
        await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await blocker.query(`SELECT count(*) FROM ${schema}."${TABLE}"`);

        // Deliberately not awaited: it blocks until the transaction above ends.
        const dropping = dropper
          .query(`DROP INDEX CONCURRENTLY ${schema}.${quoteIdentifier(doomed)}`)
          .catch(() => undefined);

        // Wait for the drop to actually clear indisvalid, rather than sleeping a
        // guess — that is the state that makes it look like a remnant.
        let clearedValid = false;
        for (let attempt = 0; attempt < 100 && !clearedValid; attempt++) {
          const state = await withClient((client) =>
            client.query(
              "SELECT count(*)::int AS n FROM pg_index WHERE indexrelid = to_regclass($1)::oid AND NOT indisvalid AND indislive",
              [`${TEST_SCHEMA}.${doomed}`]
            )
          );
          clearedValid = (state as { rows: { n: number }[] }).rows[0].n > 0;
          if (!clearedValid) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(clearedValid).toBe(true);

        // And no create-progress row covers it — so this is a genuine exclusion
        // by the pg_locks predicate, not the create anti-join doing the work.
        const progress = await withClient((client) =>
          client.query(
            "SELECT count(*)::int AS n FROM pg_stat_progress_create_index WHERE index_relid = to_regclass($1)::oid",
            [`${TEST_SCHEMA}.${doomed}`]
          )
        );
        expect((progress as { rows: { n: number }[] }).rows[0].n).toBe(0);

        const found = await sweepInvalidIndexes(requireUrl(), TEST_SCHEMA, {
          logger: { warn: () => undefined },
        });
        expect(found?.map((index) => index.name)).not.toContain(doomed);

        await blocker.query("COMMIT");
        await dropping;
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await dropper.end().catch(() => undefined);
        await withClient((client) =>
          client.query(
            `DROP INDEX IF EXISTS ${schema}.${quoteIdentifier(doomed)}`
          )
        );
      }
    });

    it("reports a schema with no invalid index as verifiably clean", async () => {
      // Its own schema, so this case does not depend on the order the cases above
      // ran in (and cannot be satisfied by an empty/missing schema either — the
      // healthy index proves the query reached real catalog rows).
      const cleanSchema = quoteIdentifier(`${TEST_SCHEMA}_clean`);
      await withClient(async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS ${cleanSchema} CASCADE`);
        await client.query(`CREATE SCHEMA ${cleanSchema}`);
        await client.query(`CREATE TABLE ${cleanSchema}."t" ("a" int)`);
        await client.query(`CREATE INDEX ON ${cleanSchema}."t" ("a")`);
      });
      try {
        // Pin that the schema really holds an index, so `[]` below cannot be
        // satisfied by a typo'd or empty schema.
        const present = await withClient((client) =>
          client.query(
            "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1",
            [`${TEST_SCHEMA}_clean`]
          )
        );
        expect((present as { rows: { n: number }[] }).rows[0].n).toBe(1);

        const found = await sweepInvalidIndexes(
          requireUrl(),
          `${TEST_SCHEMA}_clean`,
          { logger: { warn: () => undefined } }
        );

        expect(found).toEqual([]);
        expect(formatMigrateCompletionLine(found)).toBe(
          "✓ Migrations completed successfully"
        );
      } finally {
        await withClient((client) =>
          client.query(`DROP SCHEMA IF EXISTS ${cleanSchema} CASCADE`)
        );
      }
    });
  }
);
