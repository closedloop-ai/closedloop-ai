import { randomUUID } from "node:crypto";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { InsightsScope } from "@repo/api/src/types/insights";
import { GitHubPRState, withDb } from "@repo/database";
import {
  ROWS_REMOVED_BY_FILTER_LABEL,
  requireIndexPredicate,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import {
  analyzeTables,
  makePlannerDecoyOrgIds,
  purgeFixtureOrganizations,
} from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  explainCapturedStatement,
  explainWithoutLeadingIndexes,
  IndexDependentPolicy,
} from "@/__tests__/support/captured-statement-plan.test-helpers";
import {
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import { withFixtureRawClient } from "@/__tests__/utils/fixture-db";
import { fetchMergedPrs } from "@/app/insights/merged-pr-queries";
import type { InsightsScopeContext } from "@/app/insights/service/scope";

/**
 * ISS-6825 — the org-wide merged-PR reads must SEEK their tenant on the PR row,
 * not walk every tenant's merged history and throw the rest away.
 *
 * WHAT REGRESSED, AND WHY NO EXISTING TEST SAW IT. `PullRequestDetail` carries a
 * denormalized `organization_id` and an `(organization_id, pr_state, merged_at)`
 * index, but the Delivery statements scoped the org ONLY through the joined
 * branch artifact (`a.organization_id`). Nothing then constrained that index's
 * LEADING column, so the planner could not seek on it. Measured on this fixture
 * before the fix, the scan came back
 *   Index Cond: ((pr_state = 'MERGED') AND (merged_at >= ...) AND (merged_at <= ...))
 * with no `organization_id` — a full index walk that kept 44 rows, discarded 484
 * by Filter, and ran the org-merged membership SubPlan once per row it emitted
 * (4,208 buffers). With the PR's own org named, the same statement seeks all
 * three columns and reads 672 buffers, discarding nothing.
 *
 * Every value test in this repo was blind to that: the admitted SET is identical
 * either way — that is exactly why the added predicate is safe — so the counts,
 * the parity suites, and the cross-surface invariants all stayed green across
 * both plans. Only the plan tells them apart, which is why this is a standing
 * guard rather than an EXPLAIN pasted into the PR body.
 *
 * WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. The durable property is
 * "the org predicate narrowed the scan on the PR row": it appears in an
 * `Index Cond` and the scan discards nothing. That holds for ANY org-leading
 * index the planner picks, so the index is NOT pinned by name — which one wins
 * is a cost decision that moves with the corpus, and pinning the winner would
 * make the assertion a statement about this fixture. No timing and no buffer
 * threshold is asserted either: both are machine- and cache-dependent, and the
 * measured figures above belong in the PR body as evidence, not in a bound.
 *
 * AND IT PROVES IT CAN FAIL. The counterfactual drops the org-leading indexes on
 * `pull_request_detail` inside a rolled-back transaction and re-plans the SAME
 * captured statements, asserting the scan comes back discarding rows. Without
 * that arm, "the plan is good" is indistinguishable from "these statements
 * matched nothing" — the ISS-6211 fail-open `explain-plan.ts` exists to prevent.
 *
 * ISS-12408 SCOPE NOTE. The headline count, its prior window and the closed
 * count used to be separate org-wide statements planned here. They are now one
 * fold over the Product-eligible branch cohort (`delivery-pull-request-facts`),
 * and this suite does not capture it: only `fetchMergedPrs` is observed below,
 * so the headline count has no plan guard. The fold binds `p.organization_id`
 * in its `counting` CTE — the same conjunct asserted here — but no EXPLAIN of
 * it has been taken, so which index the planner picks for it is unmeasured.
 *
 * THE STATEMENTS ARE CAPTURED, NOT TRANSCRIBED. They come out of the real
 * `fetchMergedPrs` through the pg driver with the
 * parameters Prisma bound, so a query-shape change needs no edit here: the
 * EXPLAIN follows whatever the production read now emits.
 *
 * THE PREMISE IS NOW STRUCTURAL, AND IS NOT RE-CHECKED HERE. Seeking the tenant
 * on `p.organization_id` is only sound while that denormalized column agrees
 * with its branch artifact's. This suite used to assert that agreement itself,
 * with an injected violation beside it to prove the reader discriminated,
 * because nothing enforced it. ISS-10170 since made it a composite foreign key,
 * `pull_request_detail_branch_artifact_tenant_fkey`, so the violation that arm
 * constructed can no longer be written and the agreement is the database's to
 * keep rather than this fixture's to observe. What the constraint enforces is
 * covered against a real migrated Postgres by
 * `packages/database/__tests__/integration/iss10170-pull-request-detail-branch-tenant-fk.integration.test.ts`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * The node scanning the Delivery statements' own `pull_request_detail` alias.
 *
 * Scoped to the alias, not the bare relation: the org-merged membership
 * predicate scans the same table again as `sibling_pr` for its unique-branch
 * arm, and a bare relation name matches both nodes — which `requireScanNode`
 * rejects as ambiguous rather than picking one.
 */
const PR_SCAN_NODE = "pull_request_detail p";

const PR_TABLE = "pull_request_detail";
const ORG_COLUMN = "organization_id";

/** A STABLE marker on every organisation this suite creates, so a run killed
 *  before its teardown is reclaimed by the next one rather than costed against.
 */
const FIXTURE_CLERK_PREFIX = "org_iss6825_delivery_plan_";

const ORG_ID = randomUUID();
/** Decoys, so the tenant under test is a small fraction of the table. The count
 *  and the reasoning behind it live on {@link makePlannerDecoyOrgIds}. */
const DECOY_ORG_IDS = makePlannerDecoyOrgIds();
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];

/**
 * Every organisation is the same size, so the tenant under test holds ~1/12 of
 * the table.
 *
 * That ratio is the fixture's whole job. Scan choice is costed against the
 * table's size AND the org predicate's SELECTIVITY, so a tenant holding most of
 * the rows makes the predicate narrow nothing — the first version of this
 * fixture gave the target org 64% of the table and the planner's answer said
 * nothing about production. A real org is a small slice of the platform's PR
 * table, which is the shape measured here.
 */
const PRS_PER_ORG = 2000;

/** PRs are spread across this many days, so a one-month window is selective. */
const SPREAD_DAYS = 730;

const WINDOW_START = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-31T23:59:59.999Z");

const CTX: InsightsScopeContext = {
  organizationId: ORG_ID,
  userId: ORG_ID,
  scope: InsightsScope.Org,
};

const SEEDED_TABLES = [
  "organizations",
  "artifacts",
  "session_detail",
  "pull_request_detail",
  "artifact_links",
];

type RawClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

describeIfDb("ISS-6825 delivery org-scope plan", () => {
  let statements: ObservedStatement[];

  beforeAll(async () => {
    await sweep();
    await seed();
    statements = await captureMergedPrStatements();
  });

  afterAll(async () => {
    await sweep();
  });

  it("captures bound, non-trivial merged-PR statements from the production reads", () => {
    // Everything below plans a statement that has to have come from somewhere,
    // and bounds a scan that has to have matched something. A capture that
    // stopped matching would EXPLAIN nothing and fail closed inside
    // `requireNonEmptyPlan` with a message about EXPLAIN rather than about the
    // capture, so the capture is asserted on its own terms first.
    expect(statements.length).toBeGreaterThan(0);
    expect(
      mergedCountHolder.value,
      "the seeded window admitted no merged PRs, so every plan below describes a statement that finds nothing"
    ).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.sql).toContain(PR_TABLE);
      expect(statement.values).toContain(ORG_ID);
    }
  });

  it("issues exactly one org-scoped PR statement per merged-PR read", () => {
    // The other half of the ISS-6825 acceptance: the plan improvement must come
    // from a better ACCESS PATH, not from more concurrency. Naming the PR row's
    // own org column adds a conjunct to statements that already existed, so each
    // read still issues exactly one statement against that scan — a rewrite that
    // had split the read, or added a probe beside it, moves these numbers even
    // though every plan assertion below would still pass.
    expect(prStatementCounts.scan).toBe(1);
  });

  it("seeks the tenant on the PR row and discards no other tenant's rows", async () => {
    for (const [index, statement] of statements.entries()) {
      const plan = await explainCapturedStatement(statement, PLAN_DESCRIPTION);

      // The predicate reached an INDEX rather than a post-scan filter. This is
      // what separates "an index is named in the plan" — true of the regressed
      // plan too, which named this very index while seeking only `pr_state` and
      // `merged_at` — from "the org predicate narrowed the scan".
      expect(
        requireIndexPredicate(plan, PR_SCAN_NODE),
        `statement ${index}`
      ).toContain(ORG_COLUMN);

      // And the number the amplification is measured in. PostgreSQL omits the
      // line entirely when nothing was discarded, so its ABSENCE is the pass;
      // `requireRowsRemovedByFilter` fails closed on an absent line, which is
      // right for a bound and wrong for this claim (the counterfactual below is
      // where that reader belongs).
      expect(
        requireScanNode(plan, PR_SCAN_NODE),
        `statement ${index}`
      ).not.toContain(ROWS_REMOVED_BY_FILTER_LABEL);
    }
  });

  it("regresses to discarding other tenants' rows with no org-leading PR index", async () => {
    const plans = await explainWithoutLeadingIndexes(
      statements,
      ORG_LEADING_PR_INDEXES,
      PLAN_DESCRIPTION
    );

    for (const [index, plan] of plans.entries()) {
      const scan = requireScanNode(plan, PR_SCAN_NODE);
      // The rows thrown away are the other tenants'. Asserted as a lower bound
      // rather than the measured figure, because which fallback plan the planner
      // picks is its business — the claim is only that rows WERE discarded,
      // which is precisely what the shipped predicate removes.
      expect(scan, `statement ${index}`).toContain(
        ROWS_REMOVED_BY_FILTER_LABEL
      );
      expect(
        requireRowsRemovedByFilter(scan),
        `statement ${index}`
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * The `pull_request_detail` statements a real Delivery read issued, with the
 * parameters Prisma bound.
 *
 * Nothing here re-declares the query: the scope predicate, the window and the
 * org-merged membership all come from the production `merged-pr-queries`
 * module. Statements that do not read the table (the id-keyed projection
 * `fetchMergedPrs` issues second) are dropped, because they plan a different
 * access path and would make the shared assertions ambiguous.
 */
async function captureMergedPrStatements(): Promise<ObservedStatement[]> {
  const scan = await observeStatements(() =>
    fetchMergedPrs(CTX, WINDOW_START, WINDOW_END)
  );
  mergedCountHolder.value = scan.result.length;
  const orgScopedPrStatements = (observed: readonly ObservedStatement[]) =>
    observed.filter(
      (statement) =>
        statement.sql.includes(PR_SCAN_NODE) &&
        statement.values.includes(ORG_ID)
    );
  prStatementCounts.scan = orgScopedPrStatements(scan.statements).length;
  const captured = orgScopedPrStatements(scan.statements);
  if (captured.length === 0) {
    throw new Error(
      `No org-scoped ${PR_TABLE} statement was captured from the production reads, so every assertion below would be about nothing. The capture pattern no longer describes the queries this suite plans.\n${scan.statements
        .map((statement) => statement.sql)
        .join("\n---\n")}`
    );
  }
  return captured;
}

/** Carries the captured population out of `beforeAll` into the floor assertion. */
const mergedCountHolder: { value: number } = { value: 0 };

/**
 * Statements each merged-PR read issued against the aliased PR scan.
 *
 * ISS-6825 acceptance: a better plan must not have been bought by fanning the
 * read out into more round trips. Counted per read rather than in aggregate so
 * a statement moving from one read to the other is still visible.
 */
const prStatementCounts: { scan: number } = { scan: 0 };

const PLAN_DESCRIPTION = "iss6825 delivery statement";

/**
 * The capability the counterfactual removes: every org-leading index on
 * `pull_request_detail`.
 *
 * An org-leading index that another object DEPENDS on is deliberately left in
 * place. A foreign key depends on `pull_request_detail_org_id_key` — a plain
 * unique index rather than a constraint, so `DROP INDEX` on it fails 2BP01 and
 * removing it would need a CASCADE that took unrelated schema with it, making
 * this arm evidence about something wider than the predicate under test. The
 * drop set is therefore selected by DEPENDENCY, not by constraint-ness: an
 * earlier revision filtered on `pg_constraint` and did not exclude this index at
 * all. That leaves the counterfactual
 * NARROWER than "no org index at all" — and still decisive, because with only
 * `(organization_id, id)` available the planner can still locate the tenant but
 * must apply `pr_state` and `merged_at` AFTER the scan, which is exactly the
 * discarded-row regression asserted below.
 */
const ORG_LEADING_PR_INDEXES = {
  table: PR_TABLE,
  leadingColumn: ORG_COLUMN,
  dependents: IndexDependentPolicy.KeepDependentIndexes,
} as const;

function branchPrefixFor(orgId: string): string {
  return `${orgId.slice(0, 8)}-0000-4000-8001-`;
}

function sessionPrefixFor(orgId: string): string {
  return `${orgId.slice(0, 8)}-0000-4000-8000-`;
}

function targetIdFor(orgId: string): string {
  return `00000000-0000-4000-8002-${orgId.replaceAll("-", "").slice(0, 12)}`;
}

async function seed(): Promise<void> {
  await withDb(async (db) => {
    const client = db as unknown as RawClient;
    await client.$executeRawUnsafe(
      `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
       SELECT org_id, $2::text || org_id, 'iss6825 ' || org_id,
              'iss6825-' || org_id, NOW()
         FROM unnest($1::uuid[]) AS org_id`,
      [...ALL_ORG_IDS],
      FIXTURE_CLERK_PREFIX
    );
    await client.$executeRawUnsafe(
      `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
       SELECT org_id, 'user_iss6825_' || org_id, org_id,
              'iss6825-' || org_id || '@example.test', NOW()
         FROM unnest($1::uuid[]) AS org_id`,
      [...ALL_ORG_IDS]
    );
    for (const orgId of ALL_ORG_IDS) {
      await seedOrg(client, orgId);
    }
  });
  // Without fresh statistics the planner costs every shape against an empty
  // table and picks a sequential scan, which would make each assertion a
  // statement about the fixture rather than about the access path. Outside the
  // seeding `withDb` because ANALYZE is owner-only and silently skips a table
  // the caller does not own.
  await withFixtureRawClient("the planner-fixture seed ANALYZE", (client) =>
    analyzeTables(client, SEEDED_TABLES)
  );
}

async function seedOrg(client: RawClient, orgId: string): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, 'iss6825', 'darwin', NOW())`,
    targetIdFor(orgId),
    orgId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_by_id, created_at, updated_at)
     SELECT ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $2::uuid, 'BRANCH',
            'iss6825-branch-' || g, 'ACTIVE', $2::uuid,
            TIMESTAMP '2026-08-15' - ((g % $3::int) * INTERVAL '1 day'), NOW()
       FROM generate_series(1, $4::int) AS g`,
    branchPrefixFor(orgId),
    orgId,
    SPREAD_DAYS,
    PRS_PER_ORG
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_by_id, created_at, updated_at)
     SELECT ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $2::uuid, 'SESSION',
            'iss6825-session-' || g, 'inactive', $2::uuid, NOW(), NOW()
       FROM generate_series(1, $3::int) AS g`,
    sessionPrefixFor(orgId),
    orgId,
    PRS_PER_ORG
  );
  await client.$executeRawUnsafe(
    `INSERT INTO session_detail
       (artifact_id, compute_target_id, external_session_id, harness,
        session_started_at, session_updated_at, updated_at, last_activity_at,
        estimated_cost)
     SELECT ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $2::uuid,
            'ext-' || $1::text || g::text, 'claude_code',
            NOW(), NOW(), NOW(), NOW(), 1.5
       FROM generate_series(1, $3::int) AS g`,
    sessionPrefixFor(orgId),
    targetIdFor(orgId),
    PRS_PER_ORG
  );
  // Exactly ONE pull request per branch, which is what lets the
  // `{"linkKind":"session_pr"}` link below admit through the unique-branch
  // fallback arm of `orgMergedPullRequestMembershipSql`. A row the population
  // does not admit is filtered out before the plan says anything useful.
  await client.$executeRawUnsafe(
    `INSERT INTO pull_request_detail
       (id, organization_id, branch_artifact_id, number, repository_full_name,
        pr_state, merged_at, additions, deletions, is_current, last_verified_at)
     SELECT gen_random_uuid(), $2::uuid,
            ($1::text || lpad(to_hex(g), 12, '0'))::uuid, g,
            'acme/iss6825-' || $3::text,
            $4::"GitHubPRState",
            TIMESTAMP '2026-08-15' - ((g % $5::int) * INTERVAL '1 day'),
            40, 2, true, NOW()
       FROM generate_series(1, $6::int) AS g`,
    branchPrefixFor(orgId),
    orgId,
    orgId.slice(0, 8),
    GitHubPRState.MERGED,
    SPREAD_DAYS,
    PRS_PER_ORG
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifact_links
       (id, organization_id, source_id, target_id, link_type, metadata, branch_participation, created_at)
     SELECT gen_random_uuid(), $3::uuid,
            ($1::text || lpad(to_hex(g), 12, '0'))::uuid,
            ($2::text || lpad(to_hex(g), 12, '0'))::uuid,
            'RELATES_TO', '{"linkKind":"session_pr"}'::jsonb, $5::text, NOW()
       FROM generate_series(1, $4::int) AS g`,
    sessionPrefixFor(orgId),
    branchPrefixFor(orgId),
    orgId,
    PRS_PER_ORG,
    BranchParticipationKind.Wrote
  );
}

/**
 * Delete this fixture's organisations and everything hanging off them.
 *
 * Keyed on {@link FIXTURE_CLERK_PREFIX} rather than on this run's ids, and
 * called BEFORE seeding as well as after, so a run killed before its teardown is
 * reclaimed rather than left for the next suite to be costed against. The purge
 * also compacts every table it empties, which is what the seed relies on for a
 * table sized to its live rows.
 */
async function sweep(): Promise<void> {
  await withFixtureRawClient("the ISS-6825 fixture sweep", async (client) => {
    const scope =
      "(SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%')";
    await purgeFixtureOrganizations(client, {
      selector: scope,
      leafDeletes: [
        `DELETE FROM artifact_links WHERE organization_id IN ${scope}`,
        `DELETE FROM pull_request_detail WHERE organization_id IN ${scope}`,
        `DELETE FROM session_detail WHERE artifact_id IN (
           SELECT id FROM artifacts WHERE organization_id IN ${scope})`,
        `DELETE FROM artifacts WHERE organization_id IN ${scope}`,
        `DELETE FROM compute_targets WHERE organization_id IN ${scope}`,
        `DELETE FROM users WHERE organization_id IN ${scope}`,
      ],
      values: [FIXTURE_CLERK_PREFIX],
      label: "ISS-6825 delivery plan-guard fixture sweep failed",
    });
  });
}
