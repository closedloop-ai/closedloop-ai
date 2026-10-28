import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import {
  ROWS_REMOVED_BY_FILTER_LABEL,
  requireIndexPredicate,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import { makePlannerDecoyOrgIds } from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeSessionListPlannerTables,
  purgeSessionListPlannerFixture,
  SessionListPlannerDetail,
  seedSessionListPlannerFixture,
} from "@/__tests__/support/agent-sessions/session-list-planner.test-fixtures";
import {
  explainCapturedStatement,
  explainWithoutLeadingIndexes,
  IndexDependentPolicy,
} from "@/__tests__/support/captured-statement-plan.test-helpers";
import {
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import type { AgentSessionListQuery } from "../validators";
import { findDisplayValueSortedPage } from "./list-page-fetch";
import { buildWhere } from "./query-builder";
import { SESSION_CANDIDATE_CHUNK_SIZE } from "./session-candidate-stream";

/**
 * ISS-9627 (whitlockk review, thread 3962329212) — the org-scoped keyset walk must
 * never read another tenant's artifacts.
 *
 * WHY THE DDL TEST IS NOT ENOUGH. `iss9627-artifacts-org-id-index-migration.test.ts`
 * proves the index's SHAPE: right table, right key order, btree, not partial,
 * built concurrently. None of that is evidence about the PLAN the keyset walk
 * gets. A change to the query shape (`buildWhere` scoping through a different
 * relation, a projection that turns the join into a subquery, an added ORDER BY
 * term) or to the statistics can push `organization_id` out of the index
 * condition and down into a post-scan Filter — every DDL assertion still green
 * while the scan reads every tenant's rows and discards the ones that do not
 * match. The amplification factor on that is the platform's tenant count, which
 * is why it gets a standing guard instead of a one-off EXPLAIN pasted into a
 * migration.
 *
 * WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. The durable property is
 * "the org predicate narrowed the scan": it appears in an `Index Cond`, and the
 * artifacts scan discards no rows. That is the security-relevant half and it
 * holds for ANY org-leading index the planner picks. This suite does NOT pin
 * `artifacts_org_id_idx` by name, because which org-leading index the planner
 * reaches for is a cost decision that moves with the corpus — measured on this
 * fixture it picks a different one, and on a 200,000-row fixture it picks this
 * one. Pinning the winner would make the assertion a statement about the
 * fixture, which is the failure mode the whole review thread is about.
 *
 * AND THE GUARD PROVES IT CAN FAIL. The last case drops every org-leading index
 * on `artifacts` inside a transaction, re-plans the SAME captured statements,
 * and asserts the cross-tenant scan comes back with its discarded-row count —
 * then rolls back. Without that arm, "the plan is good" is indistinguishable
 * from "these readers never matched anything", which is the ISS-6211 fail-open
 * `explain-plan.ts` exists to prevent.
 *
 * THE STATEMENTS ARE CAPTURED, NOT TRANSCRIBED. They come out of a real
 * `findDisplayValueSortedPage` through the pg driver, with the parameters Prisma
 * bound, so a query-shape change is not something this suite has to be taught:
 * the EXPLAIN follows whatever the production read now emits.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ARTIFACTS_TABLE = "artifacts";

const ORG_ID = randomUUID();
/**
 * Nineteen decoy tenants beside the one under test, for the reason every planner
 * guard in this repo seeds them: scan choice is costed against the TABLE's size
 * and the org predicate's SELECTIVITY, not against the tenant's row count. A
 * two-org fixture makes the org predicate merely halve a small table, which is
 * the profile where a cost-based planner prefers a sequential scan however good
 * the index is — the plan assertions would then be describing the fixture.
 *
 * Ids come from `gen_random_uuid()`, so the tenants' rows are interleaved
 * throughout the primary key's space. That interleave IS the defect being
 * guarded: it is what makes an unqualified id-ordered scan read twenty rows to
 * keep one.
 */
const DECOY_ORG_IDS: readonly string[] = makePlannerDecoyOrgIds(19);
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];

/**
 * Sessions per organization — twenty tenants, so 10,000 artifacts, the tenant
 * under test holding a twentieth of them.
 *
 * SIZED FROM A MEASURED FLOOR, not from a guess, and deliberately not from the
 * corpus the PR's own before/after was measured on — a regression guard needs
 * the smallest fixture on which the counterfactual still discriminates, and the
 * tier's 30s hook bound (`vitest.config.integration.mts`, enforced by
 * `__tests__/integration-suite-timeout-budget.test.ts`) is the reason that
 * matters rather than being merely tidy.
 *
 * Swept on a VACUUMed table, the org predicate reaches an `Index Cond` and the
 * counterfactual below still produces a filtering scan at every size down to
 * 20 orgs x 25 rows (500 total); it collapses to a Seq Scan in BOTH arms — the
 * arm and its counterfactual becoming indistinguishable — at 12 x 25 and 8 x 50.
 * 500 is therefore the floor, and this sits twenty times above it so a planner
 * that costs slightly differently under another PostgreSQL build does not land
 * on the boundary.
 *
 * The sweep had to be run on a VACUUMed table to mean anything: measured against
 * a bloated `artifacts` (20 MB of heap for 1,000 live rows, left by the sweep's
 * own repeated deletes) the planner costs the scan against the physical size and
 * the floor reads far lower than it is. Extra ambient rows from other suites on
 * the shared integration database only make the org predicate MORE selective,
 * which is the safe direction for both arms.
 *
 * Below {@link SESSION_CANDIDATE_CHUNK_SIZE}, so the walk resolves the org in a
 * single chunk. The per-request clamp and the multi-chunk statement count are
 * asserted where they are cheap — `session-candidate-stream.test.ts` and
 * `cost-sorted-page-read-budget.test.ts` — rather than bought here with a
 * fixture forty times this size.
 */
const SESSIONS_PER_ORG = 500;

/**
 * The keyset chunk statements: they read `session_detail`, join `artifacts` for
 * the org predicate, and take a bounded page. The `count(where)` beside them has
 * no LIMIT and Prisma emits the relation projections separately, so the LIMIT is
 * what tells the three apart.
 */
const KEYSET_CHUNK_PATTERN =
  /FROM\s+"?public"?\."?session_detail"?[\s\S]*\bLIMIT\b/i;

const LIST_FILTERS = {
  sortBy: "duration",
  sortDir: "desc",
} as AgentSessionListQuery;

/** Every fixture organization's `clerk_id` prefix — what the purge keys on. */
const FIXTURE_CLERK_PREFIX = "org_iss9627_keyset_";

/** The index removal the counterfactual makes: every org-leading `artifacts` index. */
const ORG_LEADING_ARTIFACTS_INDEXES = {
  table: ARTIFACTS_TABLE,
  leadingColumn: "organization_id",
  dependents: IndexDependentPolicy.DropForeignKeys,
} as const;

const PLAN_DESCRIPTION = "sessions keyset chunk";

describeIfDb("sessions keyset walk plan (ISS-9627)", () => {
  let chunkStatements: ObservedStatement[];

  // No trailing timeout on either hook. The tier owns that number
  // (`vitest.config.integration.mts`), and restating it here is what
  // `integration-suite-timeout-budget.test.ts` calls a bound the tier already
  // holds — its ledger is shrink-only and takes no new entries, so the fixture
  // is sized to fit the tier instead.
  beforeAll(async () => {
    await seed();
    chunkStatements = await captureKeysetChunkStatements();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("captures the keyset chunk the production read issued, bound and non-trivial", () => {
    // The rest of this file plans a statement that has to have come from
    // somewhere. If the capture ever stopped matching, an EXPLAIN of `""` would
    // fail closed inside `requireNonEmptyPlan` with a message about EXPLAIN
    // rather than about the capture — so the capture is asserted on its own
    // terms first.
    expect(chunkStatements).toHaveLength(1);
    // The org fits inside one chunk, so the single read returned all of it —
    // which is what makes the scan below the whole org-scoped population rather
    // than a clamped prefix of it.
    expect(SESSIONS_PER_ORG).toBeLessThan(SESSION_CANDIDATE_CHUNK_SIZE);
    expect(chunkStatements[0].rows).toBe(SESSIONS_PER_ORG);
    for (const statement of chunkStatements) {
      expect(statement.sql).toContain(ARTIFACTS_TABLE);
      expect(statement.values).toContain(ORG_ID);
    }
  });

  it("pushes the org predicate into an index and discards no other tenant's rows", async () => {
    for (const [index, statement] of chunkStatements.entries()) {
      const plan = await explainCapturedStatement(statement, PLAN_DESCRIPTION);
      const scan = requireScanNode(plan, ARTIFACTS_TABLE);

      // The predicate reached an INDEX rather than a post-scan filter. This is
      // what separates "an index is named in the plan" — true of the regressed
      // plan too, which names `artifacts_pkey` — from "the org predicate
      // narrowed the scan".
      expect(
        requireIndexPredicate(plan, ARTIFACTS_TABLE),
        `chunk ${index}`
      ).toContain("organization_id");
      // And the number the amplification is measured in. PostgreSQL omits the
      // line entirely when nothing was discarded, so its ABSENCE is the pass;
      // `requireRowsRemovedByFilter` would fail closed on it, which is correct
      // for a bound but wrong for this claim (see the counterfactual below,
      // where the line is present and that reader is the one used).
      expect(scan, `chunk ${index}`).not.toContain(
        ROWS_REMOVED_BY_FILTER_LABEL
      );
    }
  });

  it("regresses to a cross-tenant scan when no org-leading index can serve it", async () => {
    const plans = await explainWithoutLeadingIndexes(
      chunkStatements,
      ORG_LEADING_ARTIFACTS_INDEXES,
      PLAN_DESCRIPTION
    );

    for (const [index, plan] of plans.entries()) {
      const scan = requireScanNode(plan, ARTIFACTS_TABLE);
      // The org predicate is now a Filter over rows the scan already read, and
      // the rows it throws away are the other tenants'. Measured on this fixture
      // at 40,000 discarded to keep 8,000; asserted as a lower bound rather than
      // that figure, because which fallback plan the planner picks is its
      // business and the claim is only that rows WERE discarded.
      expect(scan, `chunk ${index}`).toContain(ROWS_REMOVED_BY_FILTER_LABEL);
      expect(
        requireRowsRemovedByFilter(scan),
        `chunk ${index}`
      ).toBeGreaterThan(SESSIONS_PER_ORG);
    }
  });
});

/**
 * The SQL and bound parameters of every keyset chunk a real Sessions read
 * issued.
 *
 * `findDisplayValueSortedPage` rather than a hand-built `findMany`: the whole
 * point is that nothing here re-declares the query. The `where` comes from the
 * production `buildWhere`, the order and the chunk size from
 * `selectOrderedSessionWindow`, the projection from the production select.
 */
async function captureKeysetChunkStatements(): Promise<ObservedStatement[]> {
  const where = await buildWhere({ organizationId: ORG_ID }, LIST_FILTERS);
  const { statements } = await observeStatements(() =>
    findDisplayValueSortedPage({
      organizationId: ORG_ID,
      where,
      idleWhere: null,
      offset: 0,
      limit: 10,
      filters: LIST_FILTERS,
    })
  );
  const chunks = statements.filter((statement) =>
    KEYSET_CHUNK_PATTERN.test(statement.sql)
  );
  if (chunks.length === 0) {
    throw new Error(
      `No keyset chunk statement was captured from the production read, so every assertion below would be about nothing. The capture pattern no longer describes the query this suite plans.\n${statements
        .map((statement) => statement.sql)
        .join("\n---\n")}`
    );
  }
  return chunks;
}

/**
 * Twenty tenants' worth of SESSION artifacts and their `session_detail` rows,
 * from the shared set-based fixture, after a prefix purge that reclaims anything
 * a killed run left behind.
 *
 * The closing `ANALYZE` is load-bearing: without fresh statistics the planner
 * costs the join against whatever these tables last looked like and can pick any
 * plan at all, which would make the assertions a statement about the fixture.
 */
async function seed(): Promise<void> {
  await purgeSessionListPlannerFixture(FIXTURE_CLERK_PREFIX);
  await withDb(async (db) => {
    await seedSessionListPlannerFixture(db, {
      orgIds: ALL_ORG_IDS,
      sessionsPerOrg: SESSIONS_PER_ORG,
      clerkPrefix: FIXTURE_CLERK_PREFIX,
      detail: SessionListPlannerDetail.Uniform,
    });
  });
  await analyzeSessionListPlannerTables();
}

/**
 * The fixture's statistics outlive its rows, and this database is shared with
 * the repo's other planner guards, whose scan choices are costed against exactly
 * those numbers — so the purge compacts the tables it empties.
 */
async function cleanup(): Promise<void> {
  await purgeSessionListPlannerFixture(FIXTURE_CLERK_PREFIX);
}
