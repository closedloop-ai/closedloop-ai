import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireScanNode,
} from "../test-helpers/explain-plan";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-6756 — the persisted `component_key_normalized` column (migration
 * 20260820120000), its backfill (20260820120100) and the
 * `(component_kind, component_key_normalized)` index (20260820120200).
 *
 * This suite runs against a real Postgres that has had `prisma migrate deploy`
 * applied, so the objects under test are the ones the migrations actually
 * create. Three of the four facts below cannot be judged by a mock at all:
 *
 *  1. THE TRIGGER. The fold is derived by the database, not by the application,
 *     precisely so a PRE-deploy writer — `persistSessionComponentUsage` keeps
 *     running its old raw `INSERT … ON CONFLICT` for as long as the old revision
 *     serves traffic — cannot land a row the new reads are blind to. Only a real
 *     INSERT that omits (or lies about) the column proves that.
 *  2. THE BACKFILL AND THE TRIGGER AGREE. Both go through the same fold
 *     function, so re-running the backfill against a fully-migrated table must
 *     change ZERO rows. If they could disagree, the same identity would return
 *     different rows depending only on when each row was written.
 *  3. THE PLANNER USES THE INDEX. The whole point of the column is that
 *     `component_key ILIKE $n` — what Prisma emits for `mode: "insensitive"` —
 *     can be served by NO btree, so the read fell back to scanning the same-kind
 *     partition of every tenant. That is a plan fact.
 *  4. WHERE THE ROW SET MOVES, IT MOVES THE WAY THE CHANGE SAYS. The folded
 *     predicate is NOT equivalent to the `ILIKE` it replaces: the fold trims
 *     (wider) and `ILIKE` treated `_`/`%` in the key as wildcards (so the
 *     equality is narrower). An "the two select the same rows" test seeded with
 *     plain, unpadded, metacharacter-free keys would pass no matter which way
 *     either delta went, so the cases below drive BOTH deltas and assert their
 *     direction.
 *
 * Rows are written under throwaway organizations and removed in `afterAll`.
 */

const TABLE = "agent_component_session_usage";
const INDEX_NAME = "agent_component_session_usage_kind_key_norm_idx";
const FOLD_FUNCTION = "agent_component_session_usage_normalized_key";
const TRIGGER_NAME = "agent_component_session_usage_normalized_key_sync";
const BACKFILL_MIGRATION =
  "20260820120100_iss6756_backfill_component_key_normalized";

/**
 * The identity the plan assertions probe for. Stored mixed-case (as the desktop
 * records a raw transcript name), queried folded — so the equivalence case below
 * exercises real case folding rather than an exact match dressed up as one.
 */
const IDENTITY_PREFIX = "Tail";
const PROBE_KEY_RAW = `${IDENTITY_PREFIX}-7`;
const PROBE_KEY_FOLDED = PROBE_KEY_RAW.toLowerCase();
const COMPONENT_KIND = "subagent";

/**
 * A key carrying a LIKE metacharacter, in the shape this domain actually
 * produces them (`mcp__<server>__<tool>`), plus a decoy that ONLY `ILIKE`'s
 * wildcard interpretation of `_` ever matched. The decoy is a different
 * component; the over-match was the defect.
 */
const WILDCARD_KEY_RAW = "Mcp__closedloop__ping";
const WILDCARD_KEY_FOLDED = WILDCARD_KEY_RAW.toLowerCase();
const WILDCARD_DECOY_KEY = "mcpXXclosedloopYYping";
/** A stored key the collector left padded — matched by the fold, not by ILIKE. */
const PADDED_KEY_RAW = `\r${PROBE_KEY_RAW}\t`;
/**
 * A SEPARATE identity for the "the two agree" case, kept free of padding and
 * metacharacters. Reusing the probed identity would put the padded row inside
 * it and the agreement assertion would be asserting the disagreement instead.
 */
const PLAIN_KEY_FOLDED = `${IDENTITY_PREFIX}-11`.toLowerCase();

/** Ids of the rows the delta cases assert on, filled in by `seedFixture`. */
let paddedRowId = "";
let wildcardRowId = "";
let wildcardDecoyRowId = "";

/**
 * The tenant under test: many sessions, a long tail of component identities, and
 * the probed identity present on only a small fraction of them.
 *
 * The shape is not decorative. A tenant with few sessions gives the planner a
 * cheaper route — drive from `artifacts(organization_id)` into the
 * `(agent_session_id, component_kind)` index — and it takes it whatever the key
 * predicate says, so a small fixture would measure the fixture rather than the
 * index. The regression this index exists for appears exactly when the key is
 * more selective than the tenant is.
 */
const TENANT_SESSIONS = 6000;
const USAGE_ROWS_PER_SESSION = 20;
const IDENTITY_TAIL_WIDTH = 400;

/** Decoy tenants, so the org under test is a slice of the table, not all of it. */
const DECOY_ORGS = 11;
const DECOY_SESSIONS_PER_ORG = 200;

/**
 * Every code point `String.prototype.trim` strips (WhiteSpace + LineTerminator),
 * written as escapes because the characters themselves are invisible. Used to
 * drive the stored fold against the JS one on a REAL database rather than
 * against a re-statement of it.
 */
const JS_WHITESPACE =
  "\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

const TENANT_ORG_ID = randomUUID();
const DECOY_ORG_IDS: readonly string[] = Array.from(
  { length: DECOY_ORGS },
  () => randomUUID()
);
const ALL_ORG_IDS: readonly string[] = [TENANT_ORG_ID, ...DECOY_ORG_IDS];

/**
 * The org-scoped identity read, in the SQL shape Prisma emits for
 * `fetchTokenTrendUsageRows` — captured from the query log rather than
 * paraphrased, because the join shape (the relation `orderBy` gets its own extra
 * `session_detail` alias) is what decides whether the planner can drive from the
 * usage table at all. `%%KEY_PREDICATE%%` is the only thing that varies between
 * the old spelling and the new one.
 */
const IDENTITY_READ_SQL = `
  SELECT "public"."${TABLE}"."id"
    FROM "public"."${TABLE}"
    LEFT JOIN "public"."session_detail" AS "orderby_1"
      ON ("orderby_1"."artifact_id") = ("public"."${TABLE}"."agent_session_id")
    LEFT JOIN "public"."session_detail" AS "j0"
      ON ("j0"."artifact_id") = ("public"."${TABLE}"."agent_session_id")
    LEFT JOIN "public"."artifacts" AS "j1" ON ("j1"."id") = ("j0"."artifact_id")
   WHERE ("public"."${TABLE}"."component_kind" = '${COMPONENT_KIND}'
     AND %%KEY_PREDICATE%%
     AND (("j1"."organization_id" = '${TENANT_ORG_ID}' AND ("j1"."id" IS NOT NULL))
      AND "j0"."session_started_at" >= '2020-01-01'
      AND ("j0"."artifact_id" IS NOT NULL)))
   ORDER BY "orderby_1"."session_started_at" DESC,
            "public"."${TABLE}"."agent_session_id" ASC,
            "public"."${TABLE}"."id" ASC
   LIMIT 20001 OFFSET 0`;

/** What the read used to ask for: `mode: "insensitive"` on the raw column. */
function ilikePredicate(foldedKey: string): string {
  return `"public"."${TABLE}"."component_key" ILIKE '${foldedKey}'`;
}
/** What it asks for instead: an equality on the persisted fold. */
function foldedPredicate(foldedKey: string): string {
  return `"public"."${TABLE}"."component_key_normalized" IN ('${foldedKey}')`;
}
const ILIKE_PREDICATE = ilikePredicate(PROBE_KEY_FOLDED);
const FOLDED_PREDICATE = foldedPredicate(PROBE_KEY_FOLDED);

let ctx: EphemeralDbContext;

async function explain(keyPredicate: string): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF) ${IDENTITY_READ_SQL.replace("%%KEY_PREDICATE%%", keyPredicate)}`
  );
  return requireNonEmptyPlan(
    rows.map((row) => Object.values(row)[0]).join("\n"),
    `identity read with ${keyPredicate}`
  );
}

async function idsFor(keyPredicate: string): Promise<string[]> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ id: string }[]>(
    IDENTITY_READ_SQL.replace("%%KEY_PREDICATE%%", keyPredicate)
  );
  return rows.map((row) => row.id).sort();
}

describe.skipIf(!process.env.DATABASE_URL)(
  "ISS-6756 component_key_normalized",
  () => {
    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      // `setupEphemeralDb` is not schema-isolated despite the name: this writes
      // into the shared integration database. `afterAll` does not run if the
      // worker is killed or the run times out, and ~164k leaked rows plus the
      // re-`ANALYZE`d statistics below would change the plans every other
      // planner-asserting suite depends on — including this file's own. So sweep
      // any previous run's residue FIRST, keyed on the `iss6756-` clerk-id
      // prefix, which makes a crashed run self-heal on the next invocation.
      await purgeFixtureOrganizations(
        `SELECT "id" FROM "organizations" WHERE "clerk_id" LIKE 'iss6756-%'`
      );
      await seedFixture();
    });

    afterAll(async () => {
      // whitlockk: FAILURE-COMPLETE, not best-effort. This suite writes ~164k rows
      // into the SHARED integration database and re-`ANALYZE`s three tables that
      // every other planner-asserting suite reads, so a teardown that stops at
      // its first failed DELETE leaves both the rows AND statistics describing
      // them behind. `settleAll` runs every step regardless and rethrows the
      // combined failure, so a partial cleanup is loud rather than inherited.
      //
      // The re-`ANALYZE` is the second half of that: deleting the rows does not
      // un-skew `pg_statistic`, and a later suite planning against the fixture's
      // cardinalities is exactly as wrong as one planning against its rows.
      await settleAll(
        [
          () =>
            purgeFixtureOrganizations(
              `SELECT "id" FROM "organizations" WHERE "id" IN (${ALL_ORG_IDS.map((id) => `'${id}'::uuid`).join(",")})`
            ),
          () => analyzeFixtureTables(),
          () => teardownEphemeralDb(ctx),
        ],
        "iss6756 component_key_normalized suite teardown failed"
      );
    });

    describe("the trigger, not the application, derives the fold", () => {
      it("folds case and padding on an INSERT that omits the column", async () => {
        // The shape a PRE-deploy writer produces during a rolling deploy.
        const id = await insertUsageRow("  ExPlOrE  ", null);

        expect(await foldOf(id)).toBe("explore");
      });

      it("strips every character JS trim() strips, not just the ASCII space", async () => {
        // One-argument `btrim` would strip U+0020 and nothing else, so a key
        // stored as `deploy\r` (CRLF frontmatter the collector did not strip)
        // would fold to `deploy\r` here while the LIST's JS fold produced
        // `deploy` — and the detail/trend lanes would report 0 against a list row
        // showing usage. The predicate is asserted against the JS function
        // itself, so the two folds cannot drift apart in either direction.
        const padded = `${JS_WHITESPACE}Deploy${JS_WHITESPACE}`;
        const id = await insertUsageRow(padded, null);

        expect(await foldOf(id)).toBe("deploy");
        expect(await foldOf(id)).toBe(padded.toLowerCase().trim());
      });

      it("overwrites a value the writer supplied for itself", async () => {
        const id = await insertUsageRow("Reviewer", "not-the-fold");

        expect(await foldOf(id)).toBe("reviewer");
      });

      it("re-folds when an UPDATE changes component_key", async () => {
        const id = await insertUsageRow("Before", null);

        await ctx.prisma.$executeRawUnsafe(
          `UPDATE "${TABLE}" SET "component_key" = 'AfterWards' WHERE "id" = '${id}'`
        );

        expect(await foldOf(id)).toBe("afterwards");
      });

      it("leaves the fold intact on an UPDATE that does not name component_key", async () => {
        // The ingest upsert's `DO UPDATE SET` list — the hot path, which the
        // trigger's `UPDATE OF "component_key"` deliberately stays off.
        const id = await insertUsageRow("Steady", null);

        await ctx.prisma.$executeRawUnsafe(
          `UPDATE "${TABLE}" SET "invocation_count" = 7 WHERE "id" = '${id}'`
        );

        expect(await foldOf(id)).toBe("steady");
      });
    });

    it("moves a row stranded at the column default, then has nothing left to do", async () => {
      // whitlockk: re-running the backfill over rows the trigger already folded
      // proves the NO-OP case, not the migration's job. The job is the row that
      // predates migration 20260820120000 — the one carrying the `''` column
      // default `ADD COLUMN … NOT NULL DEFAULT ''` gave every existing row, and
      // which is invisible to every read that matches on this column.
      //
      // Reproduced by disabling the trigger for the insert, which is exactly the
      // state 20260820120000 leaves an already-populated table in: column
      // present, holding `''`, nothing having folded it yet. Then the SHIPPED
      // file is executed — read from disk, preflight and all — rather than a
      // transcription of its UPDATE, so a preflight that starts refusing, or an
      // UPDATE whose predicate stops covering this population, fails here.
      const { historical, alreadyFolded, secondRun } =
        await runShippedBackfillOverHistoricalRow();

      // The row moves off the default and onto the real fold...
      expect(historical.before).toBe("");
      expect(historical.after).toBe("legacy-key");
      // ...without disturbing a row the trigger had already folded...
      expect(alreadyFolded.before).toBe(alreadyFolded.after);
      // ...and a second application selects nothing, which is the idempotency
      // Prisma's deploy-recovery re-run depends on.
      expect(secondRun).toBe(0);
    });

    it("leaves the trigger's own rows alone, so trigger and backfill agree", async () => {
      // The other half: over a table the trigger has fully folded, the shipped
      // predicate matches ZERO rows. A non-zero count means some row's stored
      // fold disagrees with the fold function — the divergence that would make
      // one identity return different rows depending on when each row was
      // written.
      const rewritten = await ctx.prisma.$executeRawUnsafe(
        `UPDATE "${TABLE}"
            SET "component_key_normalized" = "${FOLD_FUNCTION}"("component_key")
          WHERE "component_key_normalized" IS DISTINCT FROM "${FOLD_FUNCTION}"("component_key")`
      );

      expect(rewritten).toBe(0);
    });

    it("draws a full collision-free identity spread for the int4 hashes that used to overflow the seed", async () => {
      // ISS-7742. The seed's OWN projection over the seeded tenant, with
      // `hashtext` FORCED to each value that raised `22003 integer out of
      // range` before the modulo could act. Forcing is the only way to judge
      // it: the unfixed expression seeded green on most runs by chance. Run as
      // a bare SELECT, so it evaluates the statement without adding a row to
      // the table the plan assertions read.
      for (const hash of OVERFLOWING_HASHES) {
        const [row] = await ctx.prisma.$queryRawUnsafe<
          { drawn: bigint; distinct_keys: bigint }[]
        >(
          `SELECT count(*) AS drawn, count(DISTINCT "component_key") AS distinct_keys
             FROM (${usageSeedProjection(TENANT_ORG_ID, hash)}) seeded`
        );

        expect(Number(row.drawn)).toBe(
          TENANT_SESSIONS * USAGE_ROWS_PER_SESSION
        );
        // Every session shares the forced hash, so the identities ONE session
        // draws are the distinct identities overall: one per `g`, or the seed
        // collides with itself on the UNIQUE (session, kind, key, branch) the
        // spread exists to dodge.
        expect(Number(row.distinct_keys)).toBe(USAGE_ROWS_PER_SESSION);
      }
    });

    it("built the index on exactly (component_kind, component_key_normalized)", async () => {
      const [row] = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX_NAME}'`
      );

      expect(row?.indexdef).toContain(
        "btree (component_kind, component_key_normalized)"
      );
    });

    it("serves the identity read from the index instead of scanning the kind partition", async () => {
      const plan = await explain(FOLDED_PREDICATE);

      const cond = requireIndexPredicate(plan, TABLE);
      expect(cond).toContain("component_kind");
      expect(cond).toContain("component_key_normalized");
    });

    it("could never have pushed the ILIKE into an index — it is always a post-scan filter", async () => {
      // Not a cost decision the planner could make differently on another
      // machine: `ILIKE` is an operator no btree on this table implements, so
      // the key predicate can only ever appear as a `Filter:` on whatever node
      // reads the rows. That is the whole reason a persisted column was needed
      // rather than a `LOWER(component_key)` expression index.
      const node = requireScanNode(await explain(ILIKE_PREDICATE), TABLE);

      expect(node).toContain("Filter:");
      expect(node).toContain("~~*");
      expect(node).not.toContain("component_key_normalized");
    });

    it("selects exactly the ILIKE's rows for a plain, unpadded, metacharacter-free key", async () => {
      // The common case, and the only one where the two predicates agree. A
      // DIFFERENT identity from the probed one on purpose: the padded row below
      // lives in that one, so reusing it would make this assert the delta.
      const [folded, ilike] = await Promise.all([
        idsFor(foldedPredicate(PLAIN_KEY_FOLDED)),
        idsFor(ilikePredicate(PLAIN_KEY_FOLDED)),
      ]);

      expect(folded.length).toBeGreaterThan(0);
      expect(folded).toEqual(ilike);
    });

    it("stops matching a DIFFERENT component that ILIKE's `_` wildcard swept in", async () => {
      // Prisma binds the key as the ILIKE PATTERN, unescaped, so `_` was a
      // wildcard: `mcp__closedloop__ping` also matched `mcpXXclosedloopYYping`.
      // The equality does not. Asserted as the deliberate INEQUALITY it is —
      // an `toEqual` here would have to be seeded with a metacharacter-free key
      // to pass, which is exactly how this delta stayed invisible.
      const [folded, ilike] = await Promise.all([
        idsFor(foldedPredicate(WILDCARD_KEY_FOLDED)),
        idsFor(ilikePredicate(WILDCARD_KEY_FOLDED)),
      ]);

      expect(folded).toEqual([wildcardRowId]);
      expect(ilike).toEqual([wildcardRowId, wildcardDecoyRowId].sort());
    });

    it("starts matching a padded stored key that ILIKE missed", async () => {
      // The other direction: the fold trims, `ILIKE` did not. Seeded under the
      // PROBED kind, so the identity read actually reaches it.
      const [folded, ilike] = await Promise.all([
        idsFor(FOLDED_PREDICATE),
        idsFor(ILIKE_PREDICATE),
      ]);

      expect(folded).toContain(paddedRowId);
      expect(ilike).not.toContain(paddedRowId);
    });
  }
);

/**
 * Delete every organization the selector returns, child-first: `users` and
 * `compute_targets` RESTRICT rather than cascade, so deleting the organizations
 * alone fails on the foreign key and leaves the fixture behind.
 */
async function purgeFixtureOrganizations(selector: string): Promise<void> {
  // Every statement runs even when an earlier one fails (whitlockk): the order is
  // child-first because `users` and `compute_targets` RESTRICT, so stopping at
  // the first failure is precisely how a partial fixture survives into the next
  // suite. `settleAll` still rethrows, so a real breakage is not swallowed.
  await settleAll(
    [
      `DELETE FROM "artifacts" WHERE "organization_id" IN (${selector})`,
      `DELETE FROM "compute_targets" WHERE "organization_id" IN (${selector})`,
      `DELETE FROM "users" WHERE "organization_id" IN (${selector})`,
      `DELETE FROM "organizations" WHERE "id" IN (${selector})`,
    ].map((statement) => () => ctx.prisma.$executeRawUnsafe(statement)),
    `iss6756 fixture purge failed for ${selector}`
  );
}

/**
 * Re-`ANALYZE` the tables `seedFixture` skewed, so the statistics a later suite
 * plans against describe the table it actually reads.
 */
async function analyzeFixtureTables(): Promise<void> {
  await settleAll(
    [TABLE, "session_detail", "artifacts"].map(
      (table) => () => ctx.prisma.$executeRawUnsafe(`ANALYZE "${table}"`)
    ),
    "iss6756 post-teardown ANALYZE failed"
  );
}

/**
 * Reproduce the pre-20260820120000 population and run the SHIPPED backfill file
 * over it.
 *
 * All of it inside a transaction that is always rolled back: the trigger is
 * disabled for the historical insert, and neither that poke nor the probe rows
 * may outlive the case on this shared database.
 */
async function runShippedBackfillOverHistoricalRow(): Promise<{
  historical: { before: string; after: string };
  alreadyFolded: { before: string; after: string };
  secondRun: number;
}> {
  const backfillSql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      BACKFILL_MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );

  let captured: {
    historical: { before: string; after: string };
    alreadyFolded: { before: string; after: string };
    secondRun: number;
  } | null = null;
  try {
    await ctx.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE "${TABLE}" DISABLE TRIGGER "${TRIGGER_NAME}"`
        );
        const historicalId = await insertProbeRow(tx, "Legacy-Key", "");
        await tx.$executeRawUnsafe(
          `ALTER TABLE "${TABLE}" ENABLE TRIGGER "${TRIGGER_NAME}"`
        );
        // Written WITH the trigger live, so the backfill must not touch it.
        const foldedId = await insertProbeRow(tx, "Already-Folded", null);

        const before = {
          historical: await foldOfIn(tx, historicalId),
          alreadyFolded: await foldOfIn(tx, foldedId),
        };
        await tx.$executeRawUnsafe(backfillSql);
        const after = {
          historical: await foldOfIn(tx, historicalId),
          alreadyFolded: await foldOfIn(tx, foldedId),
        };
        const secondRun = await tx.$executeRawUnsafe(
          `UPDATE "${TABLE}"
              SET "component_key_normalized" = "${FOLD_FUNCTION}"("component_key")
            WHERE "component_key_normalized" IS DISTINCT FROM "${FOLD_FUNCTION}"("component_key")`
        );

        captured = {
          historical: {
            before: before.historical,
            after: after.historical,
          },
          alreadyFolded: {
            before: before.alreadyFolded,
            after: after.alreadyFolded,
          },
          secondRun,
        };
        throw new BackfillRollbackSignal();
      },
      { timeout: 120_000 }
    );
  } catch (error) {
    // Anything but the sentinel is a real failure — most usefully the trigger
    // poke erroring because the migration never created it.
    if (!(error instanceof BackfillRollbackSignal)) {
      throw error;
    }
  }
  if (captured === null) {
    throw new Error(
      "iss6756: the rollback transaction captured no result, so the case cannot be evaluated"
    );
  }
  return captured;
}

/** Sentinel used to roll the backfill-boundary probe back. */
class BackfillRollbackSignal extends Error {
  constructor() {
    super("iss6756: intentional rollback");
  }
}

/** The stored fold for one row, read on a caller-supplied client. */
async function foldOfIn(
  client: { $queryRawUnsafe: typeof ctx.prisma.$queryRawUnsafe },
  id: string
): Promise<string> {
  const [row] = await client.$queryRawUnsafe<
    { component_key_normalized: string }[]
  >(
    `SELECT "component_key_normalized" FROM "${TABLE}" WHERE "id" = $1::uuid`,
    id
  );
  return row.component_key_normalized;
}

/**
 * Insert one probe row onto the tenant's first session, RAW. `suppliedFold` is
 * written verbatim when given (`""` reproduces the pre-backfill column default);
 * omitted entirely when null, so the trigger — if enabled — derives it.
 */
async function insertProbeRow(
  client: { $executeRawUnsafe: typeof ctx.prisma.$executeRawUnsafe },
  componentKey: string,
  suppliedFold: string | null
): Promise<string> {
  const id = randomUUID();
  const columns = suppliedFold === null ? "" : `, "component_key_normalized"`;
  const values = suppliedFold === null ? "" : ", $3";
  await client.$executeRawUnsafe(
    `INSERT INTO "${TABLE}" ("id", "agent_session_id", "component_kind", "component_key", "git_branch", "created_at", "updated_at"${columns})
     SELECT $1::uuid, sd."artifact_id", 'backfill-probe', $2, '', NOW(), NOW()${values}
       FROM "session_detail" sd
       JOIN "artifacts" a ON a."id" = sd."artifact_id"
      WHERE a."organization_id" = '${TENANT_ORG_ID}'
      LIMIT 1`,
    ...(suppliedFold === null
      ? [id, componentKey]
      : [id, componentKey, suppliedFold])
  );
  return id;
}

/** The stored fold for one row. */
async function foldOf(id: string): Promise<string> {
  const [row] = await ctx.prisma.$queryRawUnsafe<
    { component_key_normalized: string }[]
  >(
    `SELECT "component_key_normalized" FROM "${TABLE}" WHERE "id" = $1::uuid`,
    id
  );
  return row.component_key_normalized;
}

/**
 * Insert one usage row onto the tenant's first session, RAW — Prisma's typed
 * `create()` would always supply the column, and the point of these cases is
 * what happens when a writer does not, or supplies the wrong thing.
 */
async function insertUsageRow(
  componentKey: string,
  suppliedFold: string | null
): Promise<string> {
  const id = randomUUID();
  // Bound, not interpolated: the keys under test carry raw control characters,
  // and a fixture that had to keep them SQL-literal-safe would be testing the
  // fixture's escaping rather than the trigger's fold.
  const columns = suppliedFold === null ? "" : `, "component_key_normalized"`;
  const values = suppliedFold === null ? "" : ", $3";
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${TABLE}" ("id", "agent_session_id", "component_kind", "component_key", "git_branch", "created_at", "updated_at"${columns})
     SELECT $1::uuid, sd."artifact_id", 'trigger-probe', $2, '', NOW(), NOW()${values}
       FROM "session_detail" sd
       JOIN "artifacts" a ON a."id" = sd."artifact_id"
      WHERE a."organization_id" = '${TENANT_ORG_ID}'
      LIMIT 1`,
    ...(suppliedFold === null
      ? [id, componentKey]
      : [id, componentKey, suppliedFold])
  );
  return id;
}

/**
 * The three rows the row-set deltas are asserted on, each on its OWN session so
 * none of them collides with the tail seeding on the natural key
 * `(agent_session_id, component_kind, component_key, git_branch)`.
 *
 * All under `COMPONENT_KIND`, so the identity read — which binds
 * `component_kind` — actually reaches them. The padded and wildcard rows the
 * trigger sub-suite inserts live under `trigger-probe` and are invisible here;
 * that is precisely why they could not have covered these cases.
 */
async function seedDeltaRows(): Promise<void> {
  const sessions = await ctx.prisma.$queryRawUnsafe<{ artifact_id: string }[]>(
    `SELECT sd."artifact_id"
       FROM "session_detail" sd
       JOIN "artifacts" a ON a."id" = sd."artifact_id"
      WHERE a."organization_id" = $1::uuid
      ORDER BY sd."artifact_id"
      LIMIT 3`,
    TENANT_ORG_ID
  );
  const rows: [string, string][] = [
    [PADDED_KEY_RAW, sessions[0].artifact_id],
    [WILDCARD_KEY_RAW, sessions[1].artifact_id],
    [WILDCARD_DECOY_KEY, sessions[2].artifact_id],
  ];
  const ids: string[] = [];
  for (const [componentKey, sessionId] of rows) {
    const id = randomUUID();
    ids.push(id);
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "${TABLE}" ("id", "agent_session_id", "component_kind", "component_key", "git_branch", "invocation_count", "last_invoked_at", "created_at", "updated_at")
       VALUES ($1::uuid, $2::uuid, '${COMPONENT_KIND}', $3, 'iss6756-delta', 1, NOW(), NOW(), NOW())`,
      id,
      sessionId,
      componentKey
    );
  }
  [paddedRowId, wildcardRowId, wildcardDecoyRowId] = ids;
}

/**
 * Seed the tenant and its decoys with raw bulk SQL. Prisma's `createMany` over
 * ~164k usage rows is minutes of round-trips for a fixture whose only job is to
 * give the planner a realistic table to choose a plan against.
 */
async function seedFixture(): Promise<void> {
  for (const [index, orgId] of ALL_ORG_IDS.entries()) {
    const userId = randomUUID();
    const computeTargetId = randomUUID();
    const sessions = index === 0 ? TENANT_SESSIONS : DECOY_SESSIONS_PER_ORG;
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "created_at", "updated_at")
       VALUES ('${orgId}'::uuid, 'iss6756-${orgId}', 'ISS-6756 ${index}', 'iss6756-${orgId}', NOW(), NOW())`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "created_at", "updated_at")
       VALUES ('${userId}'::uuid, 'iss6756-u-${userId}', '${orgId}'::uuid, '${userId}@iss6756.test', NOW(), NOW())`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "compute_targets" ("id", "organization_id", "user_id", "machine_name", "platform", "updated_at")
       VALUES ('${computeTargetId}'::uuid, '${orgId}'::uuid, '${userId}'::uuid, 'iss6756', 'darwin', NOW())`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "created_at", "updated_at")
       SELECT gen_random_uuid(), '${orgId}'::uuid, 'SESSION', 'iss6756-'||g, 'active', NOW(), NOW()
         FROM generate_series(1, ${sessions}) g`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "session_detail" ("artifact_id", "compute_target_id", "external_session_id", "session_started_at", "session_updated_at", "last_activity_at", "updated_at")
       SELECT a."id", '${computeTargetId}'::uuid, 'iss6756-'||a."id", NOW() - (random() * interval '60 days'), NOW(), NOW(), NOW()
         FROM "artifacts" a
        WHERE a."organization_id" = '${orgId}'::uuid`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "${TABLE}" ("id", "agent_session_id", "component_kind", "component_key", "git_branch", "invocation_count", "last_invoked_at", "created_at", "updated_at")
       ${usageSeedProjection(orgId, `hashtext(sd."artifact_id"::text)`)}`
    );
  }
  await seedDeltaRows();
  await ctx.prisma.$executeRawUnsafe(`ANALYZE "${TABLE}"`);
  await ctx.prisma.$executeRawUnsafe(`ANALYZE "session_detail"`);
  await ctx.prisma.$executeRawUnsafe(`ANALYZE "artifacts"`);
}

/**
 * The `Tail-<n>` suffix one seeded usage row draws, given the SQL expression
 * that hashes its session. Multiplying `g` by 977 — coprime with
 * `IDENTITY_TAIL_WIDTH` — is what keeps a single session's
 * `USAGE_ROWS_PER_SESSION` draws distinct against the UNIQUE natural key.
 *
 * ISS-7742: the whole sum has to be evaluated in `bigint`, because `hashtext`
 * returns int4 and BOTH terms overflow it before the modulo can bring the value
 * back into range — `abs(INT_MIN)` has no int4 representation, and any hash
 * within `USAGE_ROWS_PER_SESSION * 977` of INT_MAX overflows the addition. The
 * widening therefore has to sit INSIDE `abs()`: casting its int4 result
 * afterwards is already too late for the INT_MIN input.
 */
function identityTailExpression(hashExpression: string): string {
  return `(((abs((${hashExpression})::bigint) + g * 977) % ${IDENTITY_TAIL_WIDTH}) + 1)`;
}

/**
 * The usage rows one org contributes to the seed, as the SELECT the seeding
 * INSERT consumes. `hashExpression` is what identifies the session; the case
 * that drives the tail arithmetic substitutes an int4 literal for it and runs
 * this projection on its own, so it exercises the statement the seed actually
 * emits rather than a fragment of it.
 */
function usageSeedProjection(orgId: string, hashExpression: string): string {
  // `Tail-<n>` keys, spread deterministically so no session draws the same
  // identity twice (the natural key is UNIQUE on (session, kind, key, branch))
  // and the probed identity lands on a small, realistic slice of the tenant.
  return `SELECT gen_random_uuid(), sd."artifact_id", '${COMPONENT_KIND}',
              '${IDENTITY_PREFIX}-'||${identityTailExpression(hashExpression)} AS "component_key",
              '', 1, NOW(), NOW(), NOW()
         FROM "session_detail" sd
         JOIN "artifacts" a ON a."id" = sd."artifact_id"
             AND a."organization_id" = '${orgId}'::uuid,
              generate_series(1, ${USAGE_ROWS_PER_SESSION}) g`;
}

/**
 * Hashes the tail arithmetic must survive, as int4 literals substituted for
 * `hashtext` — both extremes plus one value inside the band that overflowed the
 * addition. Forced rather than sampled: a seed run draws ~8,200 session hashes
 * and the band is ~8.2e-6 of the int4 space, so it fired on roughly 7% of runs
 * and a green re-run is what the unfixed expression produced the other 93% of
 * the time. (Observed in the wild as `hashtext` of the session uuid
 * `b82d1a0e-9f67-4948-a5d8-2c676631d4d7`, which is 2147466703; written as a
 * literal here because `hashtext` is not stable across Postgres majors.)
 */
const OVERFLOWING_HASHES: readonly string[] = [
  "2147483647::int4",
  "(-2147483648)::int4",
  "2147466703::int4",
];
