import { randomUUID } from "node:crypto";
import {
  REFERENCE_SEARCH_DEFAULT_LIMIT,
  REFERENCE_TARGET_SEARCH_ORDER_BY,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
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
 * ISS-7804 — the two `artifacts` indexes migrations 20260827130000 and
 * 20260827130100 build for `referenceSearchService.searchTargets`.
 *
 * This runs against a real Postgres with `prisma migrate deploy` applied, so the
 * indexes under test are the ones the migrations actually create: deleting
 * either `CREATE INDEX` line fails cases here. The migrations carry the
 * before/after `EXPLAIN ANALYZE` evidence; what this suite adds is the part a
 * one-off measurement cannot — a standing guard that the planner still reaches
 * the query through them, and that they change plan choice ONLY.
 *
 * WHY A SORT NODE IS THE ASSERTION. The defect was never "no index at all" —
 * an org-prefixed index always existed and the planner always used one. It was
 * that none of them carried `updated_at` without an `assignee_id` equality, so
 * every shape read the whole tenant partition and then top-N sorted it to
 * return 21 rows. So the thing that must not come back is the Sort node, and a
 * guard that only asserted `plan).toContain(INDEX_NAME)` would have been green
 * on the regressed plan too — the old plans name an index on their bitmap-index
 * child as well.
 */

const ARTIFACTS_TABLE = "artifacts";
const ORG_UPDATED_INDEX = "artifacts_org_updated_id_idx";
const ORG_TYPE_UPDATED_INDEX = "artifacts_org_type_updated_id_idx";
const ORG_ID = randomUUID();

/**
 * Eleven decoys beside the tenant under test, for the same reason the ISS-6104
 * suite seeds them: the planner's scan choice depends on the TABLE's absolute
 * size and on how selective the org predicate is, not on the tenant's row count
 * alone. A two-org fixture makes the org predicate merely halve a small table,
 * which is the profile where a cost-based planner prefers a sequential scan
 * however good the index is — the plan assertions would then be measuring the
 * fixture.
 */
const DECOY_ORG_IDS: readonly string[] = Array.from({ length: 11 }, () =>
  randomUUID()
);
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];

/**
 * 60,000 artifacts, the tenant under test holding ~24% of them in the live type
 * mix (70% SESSION, 15% BRANCH, 13% DOCUMENT over five subtypes, 2%
 * DEPLOYMENT). Scaled down from the 500,000-row slice the migrations were
 * measured on; the ratios, which are what the planner costs against, are the
 * same, and the plan assertions below were re-verified at this size rather than
 * assumed to survive the reduction.
 *
 * Not larger, because this suite runs against the SHARED integration database
 * and has to remove every row it wrote: the `afterAll` delete fans out across
 * ~30 foreign keys referencing `artifacts` and is by far the most expensive
 * thing here — measured at 50s for 120,000 rows against 13s to insert them.
 *
 * `hashtext` rather than `g % n` for both the org and the type draw: deriving
 * both from one counter correlates them, and a tenant that turns out to hold
 * exactly one artifact type is a fixture that cannot exercise the type-leading
 * index at all. Written the correlated way first, the tenant came out 100%
 * SESSION.
 */
const TOTAL_ARTIFACTS = 60_000;

/**
 * `take: limit + 1` for the service's default page — the real LIMIT.
 *
 * Derived rather than written as `21`, for the same reason {@link ORDER_SUFFIX}
 * is: a literal here goes on describing a page size the endpoint stopped asking
 * for.
 */
const PAGE = REFERENCE_SEARCH_DEFAULT_LIMIT + 1;

type TargetRow = { id: string; slug: string | null; name: string };

type Comparison = {
  sql: string;
  withIndexes: TargetRow[];
  withoutIndexes: TargetRow[];
};

/** The one client capability this suite's raw reads need, on `prisma` or a `tx`. */
type RawQueryClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

describe.skipIf(!process.env.DATABASE_URL)(
  "artifacts reference-search indexes (integration)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await seedArtifacts(ctx);
    }, 300_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      await settleAll(
        [
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "artifacts" WHERE "organization_id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "organizations" WHERE "id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          // The fixture's `ANALYZE` is not undone by deleting its rows: the
          // statistics keep describing a 60,000-row `artifacts` until something
          // re-reads it. This suite shares its database with the other planner
          // guards, and a stale row estimate is exactly the input that decides
          // their scan choice — so the next one to run would be asserting a plan
          // costed against rows that no longer exist. Re-analyzed here, while
          // the connection that skewed the statistics is still open.
          () => ctx.prisma.$executeRawUnsafe(`ANALYZE ${ARTIFACTS_TABLE}`),
          () => teardownEphemeralDb(ctx),
        ],
        "artifacts reference-search index suite teardown failed"
      );
    }, 300_000);

    it("migration 20260827130000 built (organization_id, updated_at DESC, id)", async () => {
      const def = await indexDef(ctx, ORG_UPDATED_INDEX);

      // Column order and direction are both load-bearing: `organization_id`
      // leads so the equality prefix is servable, and `updated_at DESC` is what
      // lets the LIMIT terminate the scan instead of a Sort consuming the
      // partition. `id` is in the key because it is in the ORDER BY — dropping
      // it puts the Sort back for the ties `hasMore` depends on.
      expect(def).toContain("(organization_id, updated_at DESC, id)");
      expect(def).not.toContain("UNIQUE");
    });

    it("migration 20260827130100 built (organization_id, type, updated_at DESC, id)", async () => {
      const def = await indexDef(ctx, ORG_TYPE_UPDATED_INDEX);

      expect(def).toContain("(organization_id, type, updated_at DESC, id)");
      // `subtype` is deliberately not a key column: it only ever appears as
      // `IN (...)`, and a ScalarArrayOp on a non-final key column cannot return
      // rows pre-sorted by the columns after it, which would hand the sort back.
      expect(def).not.toContain("subtype");
      expect(def).not.toContain("UNIQUE");
    });

    it("plans the ARTIFACT-sourced search as an ordered index scan with no sort", async () => {
      const plan = await explain(
        ctx,
        SOURCE_SQL[ReferenceTargetSource.Artifact]
      );

      expect(plan).toContain(ORG_UPDATED_INDEX);
      // The regression this suite exists to catch. Before the index this shape
      // read `Gather Merge -> Sort (top-N heapsort) -> Parallel Bitmap Heap
      // Scan`, qualifying the whole tenant partition to return 21.
      expect(plan).not.toContain("Sort Method");
      expect(requireIndexPredicate(plan, ARTIFACTS_TABLE)).toContain(
        "organization_id"
      );
      expect(requireScanNode(plan, ARTIFACTS_TABLE)).toContain("Index Scan");
    });

    it("plans the single-source search through the type-leading index with no sort", async () => {
      const plan = await explain(
        ctx,
        SOURCE_SQL[ReferenceTargetSource.Session]
      );

      expect(plan).toContain(ORG_TYPE_UPDATED_INDEX);
      expect(plan).not.toContain("Sort Method");
      // `type` must reach the Index Cond, not a post-scan Filter — that is the
      // whole difference between this index and its sibling for this shape.
      const indexCond = requireIndexPredicate(plan, ARTIFACTS_TABLE);
      expect(indexCond).toContain("organization_id");
      expect(indexCond).toContain("type");
    });

    it("plans the subtype-narrowed search through the type-leading index with no sort", async () => {
      const plan = await explain(ctx, SOURCE_SQL[ReferenceTargetSource.Issue]);

      expect(plan).toContain(ORG_TYPE_UPDATED_INDEX);
      expect(plan).not.toContain("Sort Method");
      expect(requireIndexPredicate(plan, ARTIFACTS_TABLE)).toContain("type");
    });

    it("plans the multi-source OR search as an ordered scan rather than a BitmapOr and sort", async () => {
      const plan = await explain(ctx, MULTI_SOURCE_SQL);

      // No type-leading index can serve a disjunction of type predicates as one
      // ordered scan, so this arm is the bare index's job. Asserted because it
      // is the reason BOTH indexes ship rather than only the type-leading one.
      expect(plan).toContain(ORG_UPDATED_INDEX);
      expect(plan).not.toContain("BitmapOr");
      expect(plan).not.toContain("Sort Method");
    });

    it("returns identical rows with and without both indexes", async () => {
      const { comparisons, unindexedPlan } = await compareWithAndWithout(
        ctx,
        EQUIVALENCE_SQL
      );

      // The "without" arm is only evidence if the planner actually left the
      // indexes alone. Asserted from the plan it really ran rather than assumed
      // from the settings that were issued: if those stopped taking, both arms
      // would be the SAME index scan and every row comparison below would pass
      // while proving nothing.
      expect(unindexedPlan).toContain("Seq Scan");
      expect(unindexedPlan).not.toContain(ORG_UPDATED_INDEX);
      expect(unindexedPlan).not.toContain(ORG_TYPE_UPDATED_INDEX);

      expect(comparisons).toHaveLength(EQUIVALENCE_SQL.length);
      for (const { sql, withIndexes, withoutIndexes } of comparisons) {
        // A non-unique index is a plan change and nothing else. Each arm is
        // asserted non-empty first: two empty arrays are trivially equal, and
        // that is exactly the vacuous pass an equivalence check must not give.
        expect(withIndexes.length, sql).toBeGreaterThan(0);
        expect(withIndexes, sql).toEqual(withoutIndexes);
      }
    });
  }
);

/**
 * The statements Prisma actually emits for `searchTargets`, captured from the
 * server's own `log_statement=all` output while running the service's
 * `findMany` with the production `referenceSourceScope` predicate, then bound to
 * literals here. Transcribing the Prisma call instead would re-derive the SQL
 * from the same library that produced the defect, and would drift silently the
 * moment the query builder changed how it renders a disjunction.
 *
 * A narrower projection than the service's `TARGET_ARTIFACT_SELECT` — the
 * equivalence comparison only needs stable scalar columns, and a projection is
 * not what an index changes.
 *
 * EVERY COLUMN IS TABLE-QUALIFIED, as Prisma emits them, and that is not
 * cosmetic. An unqualified `ORDER BY "id"` resolves to the OUTPUT COLUMN, so a
 * projection like `"id"::text AS id` silently re-targets the sort at the cast
 * expression, `(id)::text` stops matching the index's `id` key column, and the
 * planner adds an Incremental Sort on top of the very index scan under test.
 * Written that way first, this suite failed its own no-sort assertion against a
 * perfectly good index.
 */
const SELECT_PREFIX =
  'SELECT "public"."artifacts"."id", "public"."artifacts"."slug", "public"."artifacts"."name" FROM "public"."artifacts" WHERE ';

/**
 * The Prisma field names in {@link REFERENCE_TARGET_SEARCH_ORDER_BY}, mapped to
 * the columns they compile to.
 *
 * A field the map does not know throws rather than being dropped: an unmapped
 * entry would silently emit a SHORTER `ORDER BY` than the endpoint issues, and
 * a shorter order is exactly the one an index can still serve without a sort —
 * the assertion would go green describing a query nobody runs.
 */
const ORDER_BY_COLUMN: Readonly<Record<string, string>> = {
  updatedAt: "updated_at",
  id: "id",
};

/**
 * `ORDER BY … LIMIT …`, DERIVED FROM THE SERVICE'S OWN ORDER, not transcribed.
 *
 * This is the tie between this suite and `searchTargets`. The order is the only
 * part of the query the indexes actually serve — they exist so the LIMIT
 * terminates an ordered scan instead of a top-N sort consuming the tenant
 * partition — so a reordering at the call site is the change that silently
 * costs the endpoint its plan. Reading the order from
 * {@link REFERENCE_TARGET_SEARCH_ORDER_BY} means such a change re-plans every
 * statement below against the NEW order, and the no-sort assertions go red when
 * the shipped indexes cannot serve it.
 */
const ORDER_SUFFIX = ` ORDER BY ${REFERENCE_TARGET_SEARCH_ORDER_BY.map(orderEntryToSql).join(", ")} LIMIT ${PAGE} OFFSET 0`;

/** A field sourced to ARTIFACT: no type predicate at all. */
const ARTIFACT_SOURCE_SQL = `${SELECT_PREFIX}"public"."artifacts"."organization_id" = $1::uuid${ORDER_SUFFIX}`;

/** A field sourced to SESSION: one type equality. */
const SESSION_SOURCE_SQL = `${SELECT_PREFIX}("public"."artifacts"."organization_id" = $1::uuid AND "public"."artifacts"."type" = CAST('SESSION'::text AS "ArtifactType"))${ORDER_SUFFIX}`;

/** A field sourced to BRANCH: the other single type equality. */
const BRANCH_SOURCE_SQL = `${SELECT_PREFIX}("public"."artifacts"."organization_id" = $1::uuid AND "public"."artifacts"."type" = CAST('BRANCH'::text AS "ArtifactType"))${ORDER_SUFFIX}`;

/**
 * A field sourced to ISSUE. Both subtype spellings, as
 * `SOURCE_ARTIFACT_SHAPES` emits them: FEA-3956 left existing rows persisted as
 * `FEATURE` while a skewed newer client can write `ISSUE`.
 */
const ISSUE_SOURCE_SQL = `${SELECT_PREFIX}("public"."artifacts"."organization_id" = $1::uuid AND "public"."artifacts"."type" = CAST('DOCUMENT'::text AS "ArtifactType") AND "public"."artifacts"."subtype" IN (CAST('FEATURE'::text AS "ArtifactSubtype"), CAST('ISSUE'::text AS "ArtifactSubtype")))${ORDER_SUFFIX}`;

/** A field sourced to SESSION and ISSUE: the disjunction arm. */
const MULTI_SOURCE_SQL = `${SELECT_PREFIX}("public"."artifacts"."organization_id" = $1::uuid AND ("public"."artifacts"."type" = CAST('SESSION'::text AS "ArtifactType") OR ("public"."artifacts"."type" = CAST('DOCUMENT'::text AS "ArtifactType") AND "public"."artifacts"."subtype" IN (CAST('FEATURE'::text AS "ArtifactSubtype"), CAST('ISSUE'::text AS "ArtifactSubtype")))))${ORDER_SUFFIX}`;

/**
 * The typed-text arm. Present in the equivalence check ONLY: its `ILIKE
 * '%term%'` is not btree-servable, the migrations record that it is accepted as
 * a scan within the bounded `take`, and asserting a plan for it here would
 * encode a planner choice these indexes deliberately do not make.
 */
const TYPED_TEXT_SQL = `${SELECT_PREFIX}("public"."artifacts"."organization_id" = $1::uuid AND ("public"."artifacts"."slug" ILIKE '%iss7804-1%' OR "public"."artifacts"."name" ILIKE '%iss7804-1%'))${ORDER_SUFFIX}`;

/**
 * One pinned statement per source a reference field can be scoped to, keyed on
 * the shared {@link ReferenceTargetSource} union.
 *
 * `Record` rather than a loose array so a FIFTH source added to that union
 * fails typecheck here until someone writes the shape it compiles to and finds
 * out whether either shipped index serves it. A new population reaching this
 * endpoint with no index behind it is the same defect ISS-7804 fixed, and an
 * array would have absorbed it silently.
 */
const SOURCE_SQL: Record<ReferenceTargetSource, string> = {
  [ReferenceTargetSource.Artifact]: ARTIFACT_SOURCE_SQL,
  [ReferenceTargetSource.Session]: SESSION_SOURCE_SQL,
  [ReferenceTargetSource.Branch]: BRANCH_SOURCE_SQL,
  [ReferenceTargetSource.Issue]: ISSUE_SOURCE_SQL,
};

/**
 * Every statement whose rows must not change when the indexes stop being used:
 * one per source, plus the two composite arms a real field produces.
 */
const EQUIVALENCE_SQL: readonly string[] = [
  ...Object.values(SOURCE_SQL),
  MULTI_SOURCE_SQL,
  TYPED_TEXT_SQL,
];

async function seedArtifacts(ctx: EphemeralDbContext): Promise<void> {
  // `createMany` rather than a `create` per org: these rows carry no nested
  // relation write, and a discarded `create` asks Postgres for `RETURNING *`
  // twelve times for a value nobody reads (`no-discarded-wide-prisma-write`).
  await ctx.prisma.organization.createMany({
    data: ALL_ORG_IDS.map((orgId) => ({
      id: orgId,
      clerkId: `iss7804-${orgId}`,
      name: `iss7804-${orgId}`,
      slug: `iss7804-${orgId}`,
    })),
  });

  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "artifacts"
       (id, organization_id, type, subtype, name, slug, status, created_at, updated_at)
     SELECT
       gen_random_uuid(),
       (CASE WHEN k.o < 24 THEN $1::uuid ELSE ($2::uuid[])[1 + (k.o % 11)] END),
       (CASE
          WHEN k.t < 70 THEN 'SESSION'
          WHEN k.t < 85 THEN 'BRANCH'
          WHEN k.t < 98 THEN 'DOCUMENT'
          ELSE 'DEPLOYMENT' END)::"ArtifactType",
       (CASE
          WHEN k.t < 85 OR k.t >= 98 THEN NULL
          WHEN k.s = 0 THEN 'PRD'
          WHEN k.s = 1 THEN 'IMPLEMENTATION_PLAN'
          WHEN k.s = 2 THEN 'DOC'
          WHEN k.s = 3 THEN 'FEATURE'
          ELSE 'ISSUE' END)::"ArtifactSubtype",
       'iss7804 artifact ' || g::text,
       'iss7804-' || g::text,
       'TODO',
       now() - (k.u * interval '1 minute'),
       now() - (k.u * interval '1 minute')
     FROM generate_series(1, $3::int) AS g,
          LATERAL (SELECT abs(hashtext('org' || g::text)) % 100 AS o,
                          abs(hashtext('type' || g::text)) % 100 AS t,
                          abs(hashtext('sub' || g::text)) % 5 AS s,
                          abs(hashtext('upd' || g::text)) % 900000 AS u) k`,
    ORG_ID,
    [...DECOY_ORG_IDS],
    TOTAL_ARTIFACTS
  );

  // Without fresh statistics the planner costs every shape against an empty
  // table and picks a sequential scan, which would make each plan assertion a
  // statement about the fixture rather than about the index.
  await ctx.prisma.$executeRawUnsafe(`ANALYZE ${ARTIFACTS_TABLE}`);
}

/**
 * The one `pg_indexes` row for `indexName`, or an error naming it.
 *
 * Throws rather than asserting, for the same reason the explain-plan readers do:
 * every assertion the callers make is a `toContain` over the returned text, and
 * those read vacuously — or crash on `undefined` with an unhelpful message —
 * against a missing index. Naming the absent index is what makes a deleted
 * `CREATE INDEX` line legible in the failure.
 */
async function indexDef(
  ctx: EphemeralDbContext,
  indexName: string
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
    "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
    ARTIFACTS_TABLE,
    indexName
  );
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one "${indexName}" index on "${ARTIFACTS_TABLE}", found ${rows.length}. Did its migration's CREATE INDEX statement survive, and did migrate deploy run against this database?`
    );
  }
  return rows[0].indexdef;
}

function explain(ctx: EphemeralDbContext, sql: string): Promise<string> {
  return explainWith(ctx.prisma, sql);
}

/**
 * EXPLAIN on any client — the suite's own, or the transaction inside
 * {@link compareWithAndWithout}, whose planner settings only exist there.
 */
async function explainWith(
  client: RawQueryClient,
  sql: string
): Promise<string> {
  const rows = await client.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
    ORG_ID
  );
  return requireNonEmptyPlan(
    rows.map((r) => Object.values(r)[0]).join("\n"),
    `EXPLAIN of the reference-target search: ${sql}`
  );
}

/**
 * The planner settings that take both indexes out of play for one transaction.
 *
 * WHY NOT `DROP INDEX`. Dropping is the obvious way to measure "without the
 * index", and this suite did it first, but a plain `DROP INDEX` takes an
 * ACCESS EXCLUSIVE lock on `artifacts` — and this suite runs against the SHARED
 * integration database, where that lock queues every other artifact test behind
 * it for as long as the comparison runs. `CONCURRENTLY` is not the way out
 * either: it cannot run inside a transaction block, so the drop could not be
 * rolled back and the indexes would not survive the test.
 *
 * `SET LOCAL` costs no lock at all, touches no shared schema, and is reverted
 * when the transaction ends however it ends. `enable_indexonlyscan` is listed
 * because a covering index can still be chosen when `enable_indexscan` alone is
 * off, which would leave the "without" arm reading through the very index it is
 * supposed to be doing without.
 *
 * These are cost penalties rather than hard prohibitions, which is why the
 * caller asserts the resulting plan really is a sequential scan instead of
 * trusting that they took.
 */
const UNINDEXED_PLANNER_SETTINGS: readonly string[] = [
  "SET LOCAL enable_indexscan = off",
  "SET LOCAL enable_indexonlyscan = off",
  "SET LOCAL enable_bitmapscan = off",
];

/**
 * Run every search twice inside ONE transaction — first as the migrated database
 * plans it, then with the planner barred from both indexes — and return the
 * pairs alongside the plan the second arm actually ran.
 *
 * One transaction for all shapes rather than one each: the settings are
 * transaction-scoped, so a transaction per shape would re-issue them for no
 * additional coverage.
 *
 * Nothing here writes, so the transaction is allowed to commit; `SET LOCAL`
 * reverts on commit exactly as it does on rollback.
 */
async function compareWithAndWithout(
  ctx: EphemeralDbContext,
  statements: readonly string[]
): Promise<{ comparisons: Comparison[]; unindexedPlan: string }> {
  return await ctx.prisma.$transaction(
    async (tx) => {
      const withIndexes: TargetRow[][] = [];
      for (const sql of statements) {
        withIndexes.push(await tx.$queryRawUnsafe<TargetRow[]>(sql, ORG_ID));
      }

      for (const setting of UNINDEXED_PLANNER_SETTINGS) {
        await tx.$executeRawUnsafe(setting);
      }

      const unindexedPlan = await explainWith(tx, statements[0]);

      const comparisons: Comparison[] = [];
      for (const [index, sql] of statements.entries()) {
        comparisons.push({
          sql,
          withIndexes: withIndexes[index],
          withoutIndexes: await tx.$queryRawUnsafe<TargetRow[]>(sql, ORG_ID),
        });
      }
      return { comparisons, unindexedPlan };
    },
    { timeout: 120_000 }
  );
}

/**
 * One `ORDER BY` entry rendered as the SQL Prisma compiles it to.
 *
 * Throws on a field {@link ORDER_BY_COLUMN} does not know, and on an entry that
 * is not exactly one field — both are shapes that would otherwise emit an
 * `ORDER BY` narrower than the endpoint's, which is the one an index can serve
 * without the sort node this suite exists to keep away.
 */
function orderEntryToSql(entry: Readonly<Record<string, string>>): string {
  const entries = Object.entries(entry);
  if (entries.length !== 1) {
    throw new Error(
      `REFERENCE_TARGET_SEARCH_ORDER_BY entry ${JSON.stringify(entry)} names ${entries.length} fields; each entry must name exactly one so the emitted ORDER BY matches the endpoint's.`
    );
  }
  const [field, direction] = entries[0];
  const column = ORDER_BY_COLUMN[field];
  if (!column) {
    throw new Error(
      `REFERENCE_TARGET_SEARCH_ORDER_BY orders by "${field}", which this suite cannot map to an "${ARTIFACTS_TABLE}" column. Add it to ORDER_BY_COLUMN and re-check that the shipped indexes still serve the new order without a sort.`
    );
  }
  return `"public"."${ARTIFACTS_TABLE}"."${column}" ${direction.toUpperCase()}`;
}
