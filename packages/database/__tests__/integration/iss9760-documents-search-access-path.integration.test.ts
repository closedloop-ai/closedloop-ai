import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactSubtype,
  ArtifactType,
  DocumentStatus,
  FeatureStatus,
} from "../../generated/enums";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "../test-helpers/explain-plan";
import {
  analyzeTables,
  makePlannerDecoyOrgIds,
  purgeFixtureOrganizations,
} from "../test-helpers/planner-fixture";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-9760 — the access path behind the Documents index's server-side search.
 *
 * ISS-9724 moved that search onto `GET /documents`, where
 * `buildDocumentSearchFilter` emits `ILIKE '%' || $1 || '%'` over
 * `Artifact.name` OR `Artifact.slug`. A leading wildcard cannot use a B-tree,
 * which is why the ticket asked whether an index was owed before the
 * `documents-index-server-search` flag is enabled.
 *
 * WHOSE QUERY THIS IS, traced rather than assumed (whitlockk review). `GET /documents`
 * has exactly two product callers and they send different predicates:
 *
 *   • The Documents index — when ISS-9760 shipped, `documents-index-view.tsx`
 *     built `{ type: DOC, unassignedProject: true, ...search }` and read it
 *     through `useDocuments`, which passes NO `limit` and NO `includeTotal`.
 *     That is the read this suite measures. Since ISS-12858 the index sends no
 *     project filter, so this predicate is now issued only by API callers that
 *     pass `unassignedProject=true`; the index's own read has no access-path
 *     guard until PRD-798 rebuilds the list.
 *   • My Tasks — `my-tasks/page.tsx` builds `buildArtifactListParams(...)`
 *     (`assigneeId` + `limit` + `offset`, optionally a recency window) and reads
 *     it through `useDocumentsPage`, which forces `includeTotal` on. It sets
 *     neither `type` nor `unassignedProject`, so it is a DIFFERENT predicate over
 *     a different index, and nothing about it is measured here.
 *
 * An earlier revision asserted a page+count pair built from the Documents-index
 * predicate under a `LIMIT`. No caller sends that: the index passes no limit, and
 * `includeTotal` cannot be requested without one. That case is gone rather than
 * re-scoped — see the PR body for the My Tasks pair measured on its own, which
 * behaves differently enough (its `LIMIT 50` IS served by an ordered index scan
 * on `artifacts_org_assignee_created_id_idx` at production scale) that folding
 * the two surfaces into one assertion described neither.
 *
 * WHAT THE MEASUREMENT FOUND, and what this suite therefore pins: the term adds
 * NO access path. The request carries no `limit`, so the read is unbounded and
 * already draws the whole `(organization, project-less, DOCUMENT, DOC)`
 * population, and the term is evaluated as a post-scan `Filter` over exactly
 * those rows. Measured on a swept, `VACUUM FULL`ed, freshly-`ANALYZE`d table the
 * searched and unsearched arms read the IDENTICAL heap. The search is free, and
 * no index is owed before the flag is enabled.
 *
 * WHERE THE BASE PREDICATE MOVED (ISS-9776). Before that migration the bitmap
 * came from `artifacts_organization_id_type_status_idx` and `subtype` plus
 * `project_id IS NULL` were themselves post-scan `Filter` predicates, so the
 * unsearched control reported a nonzero `Rows Removed by Filter` and the term
 * merely joined that existing `Filter`. The partial covering index ISS-9776
 * ships — `artifacts_org_type_subtype_created_id_idx ... WHERE project_id IS
 * NULL` — serves the whole base conjunction from the index, so the control now
 * carries NO `Filter:` line at all and EXPLAIN omits the metric rather than
 * printing a zero. The contract is unchanged and the evidence for it is sharper:
 * the control discards nothing, the searched arm discards 238 of the same 262
 * rows, and both read the identical 226 heap blocks. The case below therefore
 * asserts the control's filter ABSENCE directly rather than reading a number
 * through `requireRowsRemovedByFilter`, which fails closed on a missing line
 * precisely so no caller can coerce it back to `0`.
 *
 * SO THE ASSERTION IS SAMENESS, not a bound. A guard that only checked "the
 * searched arm is fast enough" would be green on a plan that had quietly grown a
 * second scan; what must not come back is the term becoming its own index
 * lookup, or the two arms diverging in the heap they touch. Both are asserted
 * against the unsearched arm as the control, so the comparison cannot drift with
 * the fixture's size.
 *
 * A `pg_trgm` GIN pair on `name`/`slug` WAS built and measured on a 500,000-row
 * corpus. It does cut this arm's buffers there, but it is deliberately not
 * shipped: migration 20260827130000 records the same two indexes making the
 * reference typeahead's ARTIFACT arm 7x worse on a differently-shaped corpus,
 * and — the reason that trade never has to be taken — nothing here needs them,
 * because the term is already free.
 *
 * WHICH CASES BELOW ARE CAUSALLY PROVEN, stated plainly because the answer is
 * not "all of them". Dropping the search conjunct from {@link searchedPageSql}
 * reddens the two cases that assert the term does work (the filter comparison
 * and the population-narrowing check) — those are proven. Building the trigram
 * pair against THIS fixture does NOT redden anything: the tenant's project-less
 * DOC population is ~260 rows, the org bitmap is already cheap, and the planner
 * declines the GIN index at that size. So the `Index Cond` assertions are a
 * TRIPWIRE whose counterfactual only reproduces at production scale. They are
 * kept because that is the shape worth noticing, not because this fixture can
 * force it.
 */

const ARTIFACTS_TABLE = "artifacts";
const ORG_ID = randomUUID();

/** The clerk-id prefix every row this fixture writes is reachable by. */
const FIXTURE_PREFIX = "iss9760-";

/**
 * Decoy tenants; the count and why they exist live on
 * {@link makePlannerDecoyOrgIds}, shared with the other planner guards.
 */
const DECOY_ORG_IDS = makePlannerDecoyOrgIds();
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];

/**
 * 60,000 artifacts, the tenant under test holding ~24%, in the live type mix.
 * Scaled from the 500,000-row slice the numbers in the header were taken on;
 * the ratios are what the planner costs against, and the assertions here were
 * re-verified at this size rather than assumed to survive the reduction.
 *
 * EVERY DRAW COMES FROM ITS OWN `hashtext`, and that is not incidental. Written
 * first with the org and the type both derived from `g % n`, the two correlated:
 * the tenant under test came out 100% SESSION/BRANCH, with ZERO DOCUMENT rows,
 * so the Documents predicate matched nothing and every plan assertion below
 * would have been describing an empty scan. A fixture that cannot reproduce the
 * population shape makes the whole measurement worthless, so the independence of
 * these draws is load-bearing and the first case below asserts the resulting
 * spread before any plan is read.
 */
const TOTAL_ARTIFACTS = 60_000;

/**
 * Share of DOCUMENT rows given a project, out of 100.
 *
 * Not cosmetic: `project_id IS NULL` is half the Documents-index predicate, and
 * a fixture where EVERY row is project-less makes it a no-op that discards
 * nothing — which is a different query from the one production runs, and it
 * moves which index the planner picks. Documents are the parented type in
 * practice (the create paths require a project); SESSIONs and desktop-captured
 * BRANCHes are the unparented ones, matching the `Artifact.projectId` docstring.
 */
const PARENTED_DOCUMENT_SHARE = 65;

/**
 * A term drawn from the seeded title vocabulary, matching a middling share of
 * the population.
 *
 * Not a term matching everything and not one matching nothing: both are
 * degenerate for a filter assertion — one discards no rows and the other
 * discards all of them, and each would satisfy a `Rows Removed by Filter`
 * comparison for the wrong reason.
 */
const SEARCH_TERM = "Runbook";

type DocumentRow = { id: string };

describe.skipIf(!process.env.DATABASE_URL)(
  "Documents server-side search access path (ISS-9760)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      // `setupEphemeralDb` is not schema-isolated despite the name: this writes
      // into the SHARED integration database, and `afterAll` does not run if the
      // worker is killed or the run times out. A crashed run therefore leaves
      // 60,000 rows behind whose organization ids exist only in that dead
      // process, so nothing can ever address them again — and this fixture
      // `ANALYZE`s the table, so every later planner guard costs its scan choice
      // against that residue. Sweep first, keyed on the `iss9760-` clerk-id
      // prefix, exactly as the ISS-6756 fixture does (whitlockk review).
      //
      // DELETE alone does not give the pages back: repeated seed/purge cycles
      // grew `artifacts` from 1,001 to 4,029 pages for the same 60,000 live
      // rows on this box, and the planner costs against `relpages`, not the
      // live count. The purge rewrites the tables it deletes from, so the seed
      // lands in a table sized to its live rows.
      await purgeFixtureOrgs(
        ctx,
        `SELECT "id" FROM "organizations" WHERE "clerk_id" LIKE '${FIXTURE_PREFIX}%'`
      );
      await seedArtifacts(ctx);
    }, 300_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      await settleAll(
        [
          // The purge also gives the pages back and refreshes the statistics,
          // so the next suite does not plan against a 60,000-row `artifacts`
          // that no longer exists.
          () =>
            purgeFixtureOrgs(
              ctx,
              `SELECT "id" FROM "organizations" WHERE "id" = ANY('{${ALL_ORG_IDS.join(",")}}'::uuid[])`
            ),
          () => teardownEphemeralDb(ctx),
        ],
        "documents search access-path suite teardown failed"
      );
    }, 300_000);

    it("seeds a tenant that actually holds the Documents population", async () => {
      const [row] = await ctx.prisma.$queryRawUnsafe<
        { documents: bigint; matching: bigint; parented: bigint }[]
      >(
        `SELECT count(*) FILTER (WHERE type = $2::"ArtifactType" AND subtype = $3::"ArtifactSubtype" AND project_id IS NULL) AS documents,
                count(*) FILTER (WHERE type = $2::"ArtifactType" AND subtype = $3::"ArtifactSubtype" AND project_id IS NULL AND (name ILIKE $4 OR slug ILIKE $4)) AS matching,
                count(*) FILTER (WHERE project_id IS NOT NULL) AS parented
           FROM "artifacts" WHERE organization_id = $1::uuid`,
        ORG_ID,
        ArtifactType.DOCUMENT,
        ArtifactSubtype.DOC,
        `%${SEARCH_TERM}%`
      );

      // The correlated-draw defect this fixture was written around produced a
      // tenant with zero of these. Both bounds matter: no rows makes every plan
      // assertion vacuous, and a term matching the whole population makes the
      // filter comparison vacuous in the other direction.
      expect(Number(row.documents)).toBeGreaterThan(100);
      expect(Number(row.matching)).toBeGreaterThan(0);
      expect(Number(row.matching)).toBeLessThan(Number(row.documents));
      // And `project_id IS NULL` must discard something, or the predicate the
      // plans below are read from is not the one production runs.
      expect(Number(row.parented)).toBeGreaterThan(0);
    });

    it("reaches the table through the same index with and without a term", async () => {
      const unsearched = await explain(ctx, unsearchedPageSql());
      const searched = await explain(ctx, searchedPageSql());

      // ONE index predicate on each arm, and the same one. `requireIndexPredicate`
      // throws rather than choosing when an access path exposes several, so a
      // plan that grew a BitmapAnd over a second index fails this case instead
      // of quietly satisfying a `toContain`. See the header for why this is a
      // tripwire rather than a counterfactually-proven assertion.
      const unsearchedCond = requireIndexPredicate(unsearched, ARTIFACTS_TABLE);
      const searchedCond = requireIndexPredicate(searched, ARTIFACTS_TABLE);
      expect(searchedCond).toBe(unsearchedCond);

      // The term must not be what the index is looked up by. A leading-wildcard
      // ILIKE cannot be, today; this is the assertion that notices if a future
      // change makes it one.
      expect(searchedCond).not.toContain("name");
      expect(searchedCond).not.toContain("slug");
    });

    it("evaluates the term as a filter on rows the unsearched read already draws", async () => {
      const unsearched = requireScanNode(
        await explain(ctx, unsearchedPageSql()),
        ARTIFACTS_TABLE
      );
      const searched = requireScanNode(
        await explain(ctx, searchedPageSql()),
        ARTIFACTS_TABLE
      );

      // The heap is the cost, and the two arms must touch the same amount of it:
      // that identity IS the finding that the flag is free to enable. Compared
      // against the unsearched arm rather than pinned to a literal, so the
      // assertion does not drift with the fixture's size.
      expect(heapBlocksOf(searched)).toBe(heapBlocksOf(unsearched));

      // The control applies no post-scan filter at all since ISS-9776 (see the
      // header), so what is asserted of it is that ABSENCE — the stronger of
      // the two statements, and the one the plan can actually report.
      requireNoFilterLine(unsearched);

      // And the term is genuinely doing work on that scan — a plan where the
      // ILIKE had been dropped would keep the heap identity above while leaving
      // this arm exactly as filterless as the control.
      expect(requireRowsRemovedByFilter(searched)).toBeGreaterThan(0);
      expect(filterOf(searched)).toContain(CASE_INSENSITIVE_LIKE_OPERATOR);
    });

    it("narrows the unsearched population rather than drawing a different one", async () => {
      const unsearched = await rows(ctx, unsearchedPageSql());
      const searched = await rows(ctx, searchedPageSql());

      // Non-vacuity first: two empty arrays satisfy a subset check trivially.
      expect(searched.length).toBeGreaterThan(0);
      expect(searched.length).toBeLessThan(unsearched.length);

      const population = new Set(unsearched.map((row) => row.id));
      expect(searched.filter((row) => !population.has(row.id))).toEqual([]);
    });
  }
);

/**
 * The statement the Documents index makes Prisma emit, CAPTURED rather than
 * transcribed.
 *
 * Taken by driving `prisma.artifact.findMany` with the `where` that
 * `buildDocumentListWhere` returns for the index's own params, the
 * `documentIncludeWithContext` include, and the `[createdAt desc, id desc]`
 * ordering `findAllDocuments` applies, then reading Prisma's `query` event.
 * The earlier revision of this file hand-wrote `SELECT "artifacts"."id"`, which
 * is not what runs: the read projects every artifact column, because the list
 * returns whole rows.
 *
 * Bound to literals here because `@repo/database` cannot import `apps/api`,
 * where the predicate builder lives. The enum VALUES come from the generated
 * client rather than being spelled out, so a renamed member fails typecheck here
 * instead of silently emitting a predicate that matches nothing.
 */
const SELECT_PREFIX = `SELECT "public"."artifacts"."id", "public"."artifacts"."organization_id", "public"."artifacts"."project_id", "public"."artifacts"."type"::text, "public"."artifacts"."subtype"::text, "public"."artifacts"."template_for_type"::text, "public"."artifacts"."name", "public"."artifacts"."slug", "public"."artifacts"."assignee_id", "public"."artifacts"."status", "public"."artifacts"."priority"::text, "public"."artifacts"."due_date", "public"."artifacts"."external_url", "public"."artifacts"."sort_order", "public"."artifacts"."created_at", "public"."artifacts"."created_by_id", "public"."artifacts"."updated_at" FROM "public"."artifacts" WHERE `;

/** `ORDER BY created_at DESC, id DESC` — the list read's stable page order. */
const ORDER_SUFFIX = ` ORDER BY "public"."artifacts"."created_at" DESC, "public"."artifacts"."id" DESC OFFSET 0`;

/** The org/project/type/subtype conjunction both arms share. */
function basePredicate(): string {
  return `"public"."artifacts"."organization_id" = $1::uuid AND "public"."artifacts"."project_id" IS NULL AND "public"."artifacts"."subtype" = CAST('${ArtifactSubtype.DOC}'::text AS "public"."ArtifactSubtype") AND "public"."artifacts"."type" = CAST('${ArtifactType.DOCUMENT}'::text AS "public"."ArtifactType")`;
}

/** The free-text conjunct `buildDocumentSearchFilter` contributes. */
function searchPredicate(): string {
  return `("public"."artifacts"."name" ILIKE ('%' || '${SEARCH_TERM}' || '%') OR "public"."artifacts"."slug" ILIKE ('%' || '${SEARCH_TERM}' || '%'))`;
}

/** The flag-OFF read: the whole project-less DOC population, unbounded. */
function unsearchedPageSql(): string {
  return `${SELECT_PREFIX}(${basePredicate()})${ORDER_SUFFIX}`;
}

/** The flag-ON read: the same population, narrowed by the term. */
function searchedPageSql(): string {
  return `${SELECT_PREFIX}(${basePredicate()} AND ${searchPredicate()})${ORDER_SUFFIX}`;
}

/**
 * This suite's leaf tables, in the order the foreign keys demand: `users`
 * RESTRICTs and `projects` is what artifacts point at, so deleting the
 * organizations alone fails on a foreign key and leaves the fixture behind.
 * {@link purgeFixtureOrganizations} appends that organizations delete and owns
 * the run-every-statement behaviour.
 */
async function purgeFixtureOrgs(
  ctx: EphemeralDbContext,
  selector: string
): Promise<void> {
  await purgeFixtureOrganizations(ctx.prisma, {
    selector,
    leafDeletes: [
      `DELETE FROM "artifacts" WHERE "organization_id" IN (${selector})`,
      `DELETE FROM "projects" WHERE "organization_id" IN (${selector})`,
      `DELETE FROM "users" WHERE "organization_id" IN (${selector})`,
    ],
    label: `iss9760 fixture purge failed for ${selector}`,
  });
}

async function seedArtifacts(ctx: EphemeralDbContext): Promise<void> {
  // One org, one user, one project apiece: `projects.created_by_id` is NOT NULL
  // and references a user, and a project is what makes `project_id IS NULL`
  // discard anything.
  for (const orgId of ALL_ORG_IDS) {
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "created_at", "updated_at")
       VALUES ($1::uuid, '${FIXTURE_PREFIX}' || $1::text, '${FIXTURE_PREFIX}' || $1::text, '${FIXTURE_PREFIX}' || $1::text, NOW(), NOW())`,
      orgId
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "created_at", "updated_at")
       VALUES ($1::uuid, '${FIXTURE_PREFIX}u-' || $1::text, $1::uuid, $1::text || '@iss9760.test', NOW(), NOW())`,
      orgId
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "projects" ("id", "organization_id", "name", "slug", "created_by_id", "settings", "created_at", "updated_at")
       VALUES ($1::uuid, $1::uuid, '${FIXTURE_PREFIX}' || $1::text, '${FIXTURE_PREFIX}' || $1::text, $1::uuid, '{}'::jsonb, NOW(), NOW())`,
      orgId
    );
  }

  // `artifacts.status` carries a DIFFERENT vocabulary per artifact type and is
  // not bound to a DB enum, so no single literal is legal for all of them
  // (codex P1). A SESSION's lifecycle set is exactly SESSION_STATUS — three
  // values — and raw SQL is precisely the path that bypasses the TypeScript
  // SSOT, so an unconditional `TODO` here would write thousands of illegal
  // session rows into the shared integration database.
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "artifacts"
       (id, organization_id, project_id, type, subtype, name, slug, status, created_at, updated_at)
     SELECT
       gen_random_uuid(),
       o.org,
       (CASE WHEN k.t >= 85 AND k.t < 98 AND k.p < ${PARENTED_DOCUMENT_SHARE} THEN o.org ELSE NULL END),
       (CASE
          WHEN k.t < 70 THEN '${ArtifactType.SESSION}'
          WHEN k.t < 85 THEN '${ArtifactType.BRANCH}'
          WHEN k.t < 98 THEN '${ArtifactType.DOCUMENT}'
          ELSE '${ArtifactType.DEPLOYMENT}' END)::"ArtifactType",
       (CASE
          WHEN k.t < 85 OR k.t >= 98 THEN NULL
          WHEN k.s < 40 THEN '${ArtifactSubtype.DOC}'
          WHEN k.s < 55 THEN '${ArtifactSubtype.PRD}'
          WHEN k.s < 70 THEN '${ArtifactSubtype.IMPLEMENTATION_PLAN}'
          WHEN k.s < 85 THEN '${ArtifactSubtype.FEATURE}'
          ELSE '${ArtifactSubtype.ISSUE}' END)::"ArtifactSubtype",
       (ARRAY['${SEARCH_TERM}','Postmortem','Design','Migration','Rollout','Onboarding',
              'Security','Telemetry','Billing','Ingest','Gateway','Scheduler'])[1 + k.w]
         || ' ' ||
       (ARRAY['notes','plan','review','spec','checklist','summary'])[1 + k.v]
         || ' ' || g::text,
       '${FIXTURE_PREFIX}' || g::text,
       (CASE
          WHEN k.t < 70 THEN '${SESSION_STATUS.ACTIVE}'
          WHEN k.t < 85 THEN '${BranchStatus.Open}'
          WHEN k.t >= 98 THEN '${DEPLOYMENT_SEED_STATE}'
          WHEN k.s < 70 THEN '${DocumentStatus.DRAFT}'
          ELSE '${FeatureStatus.TODO}' END),
       now() - (k.c * interval '1 minute'),
       now() - (k.c * interval '1 minute')
     FROM generate_series(1, $3::int) AS g,
          LATERAL (SELECT abs(hashtext('org' || g::text)) % 100 AS o,
                          abs(hashtext('type' || g::text)) % 100 AS t,
                          abs(hashtext('sub' || g::text)) % 100 AS s,
                          abs(hashtext('proj' || g::text)) % 100 AS p,
                          abs(hashtext('word' || g::text)) % 12 AS w,
                          abs(hashtext('verb' || g::text)) % 6 AS v,
                          abs(hashtext('made' || g::text)) % 900000 AS c) k,
          LATERAL (SELECT CASE WHEN k.o < 24 THEN $1::uuid
                               ELSE ($2::uuid[])[1 + (k.o % 11)] END AS org) o`,
    ORG_ID,
    [...DECOY_ORG_IDS],
    TOTAL_ARTIFACTS
  );

  // Without fresh statistics the planner costs every shape against an empty
  // table and picks a sequential scan, which would make each assertion a
  // statement about the fixture rather than about the access path.
  await analyzeTables(ctx.prisma, [ARTIFACTS_TABLE]);
}

/**
 * The GitHub deployment state a DEPLOYMENT artifact stores.
 *
 * A bare literal because there is no const to reference: `recordDeployment`
 * takes `state: string` straight from the provider payload, so this column's
 * vocabulary is GitHub's, not this repo's.
 */
const DEPLOYMENT_SEED_STATE = "success";

/**
 * How EXPLAIN renders `ILIKE`. Postgres prints the OPERATOR, not the keyword the
 * query was written with, so asserting on the string "ILIKE" reads vacuously
 * against a plan that is applying exactly the predicate under test.
 */
const CASE_INSENSITIVE_LIKE_OPERATOR = "~~*";

/** The scan node's own `Filter:` line, or an error naming what was read. */
function filterOf(scanNode: string): string {
  const line = scanNode
    .split("\n")
    .find((candidate) => candidate.includes(FILTER_LABEL));
  if (!line) {
    throw new Error(
      `The scan node exposes no "${FILTER_LABEL}" line, so the claim that the term is applied as a post-scan filter cannot be evaluated and fails closed. A plan that pushed the term into an index would land here.\nScan node:\n${scanNode}`
    );
  }
  return line;
}

const FILTER_LABEL = "Filter:";

/** `Heap Blocks: exact=N` for a scan node, or an error naming what was read. */
function heapBlocksOf(scanNode: string): number {
  const match = scanNode.match(HEAP_BLOCKS_RE);
  if (!match) {
    throw new Error(
      `The scan node exposes no "Heap Blocks: exact=" line, so the heap-identity comparison cannot be evaluated and fails closed rather than defaulting to zero — two zeroes would compare equal and report the sameness this suite exists to prove.\nScan node:\n${scanNode}`
    );
  }
  return Number.parseInt(match[1], 10);
}

const HEAP_BLOCKS_RE = /Heap Blocks: exact=(\d+)/;

async function explain(ctx: EphemeralDbContext, sql: string): Promise<string> {
  const planRows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
    ORG_ID
  );
  return requireNonEmptyPlan(
    planRows.map((row) => Object.values(row)[0]).join("\n"),
    `EXPLAIN of the Documents list read: ${sql}`
  );
}

async function rows(
  ctx: EphemeralDbContext,
  sql: string
): Promise<DocumentRow[]> {
  return await ctx.prisma.$queryRawUnsafe<DocumentRow[]>(sql, ORG_ID);
}

/**
 * Fails unless `scanNode` applies NO post-scan filter.
 *
 * The counterpart to {@link filterOf}, and the control half of the term-does-
 * work assertion: `requireRowsRemovedByFilter` fails closed on an absent line
 * rather than returning `0`, which is correct for the searched arm and wrong
 * for a control whose plan legitimately has nothing to report. Asserting the
 * absence is what that read cannot express, and it is stricter than the
 * inequality it replaces — a control that regrew a `Filter` fails here instead
 * of merely removing fewer rows than the searched arm.
 */
function requireNoFilterLine(scanNode: string): void {
  const line = scanNode
    .split("\n")
    .find((candidate) => candidate.includes(FILTER_LABEL));
  if (line) {
    throw new Error(
      `The unsearched control exposes a "${FILTER_LABEL}" line, so it is no longer the filterless population the searched arm is compared against and the term's own contribution can no longer be read off its \`Rows Removed by Filter\`. Re-read the base predicate's access path before adjusting this.\nScan node:\n${scanNode}`
    );
  }
}
