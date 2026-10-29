/**
 * ISS-9905 — the LOC/$ coverage statement's query PLAN, pinned.
 *
 * ISS-9754 was two regressions wearing one ticket. An unwindowed `base` CTE in
 * `sessionLocCoverageCounts.sql` drew the numerator from a population the page's
 * date range does not select (the semantic half, fixed and covered by
 * `apps/api/__tests__/integration/usage-typed-sql-statements.integration.test.ts`)
 * AND it collapsed the plan: the statement stopped seeking on
 * `session_detail_last_activity_at_idx` and started sequentially scanning every
 * organisation's rows, so its cost became a function of total platform tenancy
 * rather than of the caller's window.
 *
 * Only the first half was guarded. The measurement lived as prose on the ticket
 * and in the PR body, which means a future edit that makes the predicate
 * non-sargable — wrapping `last_activity_at` in a function, restructuring
 * `base`, or removing the window again — restores the sequential scan with every
 * test in the repo green. That is the same "revertible with everything green"
 * hole the sibling suite was written to close, one level down.
 *
 * WHY THE FIXTURE IS THIS BIG, since it is the expensive part. A planner picks a
 * sequential scan on a small table no matter how good the index is, so a fixture
 * that is too small measures the fixture rather than the statement and the
 * assertion below would pass on a broken predicate. The org under test also has
 * to be a small FRACTION of the table — the org predicate must be selective, not
 * merely halve a two-org table — which is the same reasoning
 * `agent-components-pack-id-index.integration.test.ts` records for its eleven
 * decoy organisations.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. Not timings, not buffer counts: both are
 * machine- and cache-dependent, and a threshold on either is a flake generator.
 * The assertion is the SHAPE — which relation is scanned how, and whether the
 * window predicate reached an index — which is the property that actually
 * regressed.
 */
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
import {
  analyzeTables,
  makePlannerDecoyOrgIds,
  purgeFixtureOrganizations,
} from "../test-helpers/planner-fixture";
import { settleAll } from "../test-helpers/settle-all";

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * A STABLE marker on every organisation this suite creates.
 *
 * The ids themselves are random per run, which was the problem: a timeout or a
 * killed worker left 25,500 rows behind that the next run had no way to find,
 * and the run after that was costed against the residue (davetho on #6972).
 * Sweeping on this prefix before seeding makes the fixture self-healing rather
 * than relying on every run reaching its own teardown.
 */
const FIXTURE_CLERK_PREFIX = "org_iss9905_plan_guard_";

/** The org whose window the plan is measured for. */
const ORG_ID = randomUUID();

/**
 * Decoy tenants, so the org under test is a small fraction of the table.
 *
 * The count and the reasoning behind it live on {@link makePlannerDecoyOrgIds},
 * shared with the other planner guards rather than re-derived here.
 */
const DECOY_ORG_IDS = makePlannerDecoyOrgIds();

/**
 * The org under test is deliberately LARGE, and the decoys small.
 *
 * The regression is scale-dependent, which is the thing this file learned the
 * hard way. Below roughly ten thousand sessions in one organisation the planner
 * drives from `artifacts` on the org predicate and probes `session_detail` by
 * primary key, applying the window as a post-lookup Filter — a plan that is
 * bounded by the ORG whether or not the window is there, so windowed and
 * unwindowed read the same rows and no assertion can tell them apart. Only when
 * the org's own slice is large enough does the date index beat the org path,
 * which is the shape ISS-9754 actually measured.
 */
const SESSIONS_IN_TARGET_ORG = 20_000;
const SESSIONS_PER_DECOY_ORG = 500;

/** Sessions are spread across this many days, so a 7-day window is selective. */
const SPREAD_DAYS = 730;

/**
 * The tables this fixture grows, and therefore the ones whose stats it owns.
 *
 * `pull_request_detail` is here because the numerator's merged-PR EXISTS reads
 * it (ISS-9904). Left to whatever statistics the shared database last recorded
 * (never analyzed on a fresh one, or an earlier suite's since-deleted fixture),
 * the planner drives the numerator from it into the org's 20,000 delivery
 * links, probes `session_detail` by primary key, and applies the window as a
 * post-lookup Filter: the ISS-9754 shape, which the floor below reads as
 * `windowed = 0`. Only an autoanalyze landing between attempts turned that
 * green, which is why CI's retries sometimes passed (ISS-9965).
 */
const SEEDED_TABLES = [
  "artifacts",
  "session_detail",
  "artifact_links",
  "pull_request_detail",
] as const;

/** Plan-text readers, hoisted per `lint/performance/useTopLevelRegex`. */
const ACTUAL_ROWS = /actual rows=([\d.]+)/;
const LOOPS = /loops=(\d+)/;
const SEQ_SCAN = /Seq Scan/;

const WINDOW_START = new Date("2026-06-01T00:00:00Z");
const WINDOW_END = new Date("2026-06-08T00:00:00Z");

/**
 * The statement under test, read from its SSOT rather than restated.
 *
 * `check:typed-sql-generated` separately proves this file and the committed
 * generated module agree, so reading the `.sql` is reading what ships. Restating
 * the SQL here would let the guard drift away from the statement it guards,
 * which is the failure this whole file exists to prevent.
 */
const COVERAGE_SQL = readFileSync(
  join(import.meta.dirname, "../../prisma/sql/sessionLocCoverageCounts.sql"),
  "utf8"
);

/**
 * The 25-slot facet tuple, every dimension relaxed. Only the window varies.
 *
 * THIS GUARD DEPENDS ON UNNAMED PREPARED STATEMENTS, which nothing else records
 * (davetho on #6972). `packages/database/index.ts` builds `PrismaPg` with no
 * `pgOptions.statementNameGenerator`, so `@prisma/adapter-pg` passes
 * `name: undefined` and PostgreSQL plans every execution against the ACTUAL
 * bound values. That is what lets the planner prove the `IS NULL` disjunct false
 * for a bounded window and push the range into an index.
 *
 * Add server-side statement caching and PostgreSQL's generic-plan fallback
 * cannot exploit per-call NULL-ness: the bounded window would silently regress
 * to a worse plan, and this suite is the thing that would notice. A future
 * query-path refactor should read this before assuming the guard still means
 * what it says.
 */
function facetArgs(start: Date | null, end: Date | null): unknown[] {
  return [
    ORG_ID,
    start,
    end,
    [], // $4 ownerUserIds
    null, // $5 completedAfter
    [], // $6 repositories
    [], // $7 harnesses
    [], // $8 models
    [], // $9 projectIds
    null, // $10 teamId
    [], // $11 changePresence
    [], // $12 prAssociation
    [], // $13 autonomyLowerBounds
    [], // $14 autonomyUpperBounds
    false, // $15 autonomyIncludesNull
    // $16 statuses (ISS-10753) — NULL, not `[]`. Empty is a real selection on
    // this parameter (every requested value was display-only, so nothing may
    // match); NULL is the no-narrowing case every case in this file wants.
    null,
    null, // $17 projectId
    null, // $18 qualityMode (ISS-10150)
    [], // $19 costBucketLowerBounds (ISS-10753)
    [], // $20 costBucketUpperBounds (ISS-10753)
    false, // $21 costBucketIncludesUnknown (ISS-10753)
    [], // $22 subscriptionBillingModes (ISS-10753) — inert here: the known/unknown
    // predicate short-circuits on cardinality($19)=0 AND NOT $21, so this value
    // is never read for the "no cost narrowing" case every case in this file uses.
    [], // $23 priorityMembers (ISS-10332)
    false, // $24 priorityIncludesUnset (ISS-10332)
    [], // $25 creatorUserIds (ISS-12251)
  ];
}

/**
 * The statement with its `base` window NEUTRALISED — the ISS-9754 shape.
 *
 * The predicate is disabled rather than deleted so all twenty-four parameters
 * stay referenced; a raw statement that binds more parameters than it uses is
 * a protocol error, not a plan difference.
 */
const UNWINDOWED_SQL = neutralizeBound(
  neutralizeBound(
    COVERAGE_SQL,
    "AND ($2::timestamp IS NULL OR sd.last_activity_at >= $2)"
  ),
  "AND ($3::timestamp IS NULL OR sd.last_activity_at < $3)"
);

/**
 * Disable one window bound by disjunction, FAILING when the predicate moved.
 *
 * `String.replace` returns the input untouched on no match, so a reformat or a
 * rename in `sessionLocCoverageCounts.sql` would silently make `UNWINDOWED_SQL`
 * identical to `COVERAGE_SQL` — and the comparison below would then be the
 * windowed plan against itself, reading `unwindowed > windowed * 10` as false
 * and failing for an unrelated-looking reason, or (had the assertion been an
 * inequality the other way) passing vacuously. Throwing here names the drift
 * instead (davetho on #6972).
 */
function neutralizeBound(sql: string, predicate: string): string {
  const neutralized = sql.replace(
    predicate,
    `${predicate.slice(0, -1)} OR TRUE)`
  );
  if (neutralized === sql) {
    throw new Error(
      `ISS-9905 plan guard cannot build its ISS-9754 comparison: sessionLocCoverageCounts.sql no longer contains the window predicate ${predicate}. Update this file to match the statement — leaving it would compare the windowed plan against itself.`
    );
  }
  return neutralized;
}

/**
 * Rows the `session_detail` scan actually touched, loops included.
 *
 * `EXPLAIN ANALYZE` reports per-loop rows, so a nested loop that probes once per
 * outer row reads `rows=1 loops=2000` — the same 2,000 rows a single-pass node
 * would report as `rows=2000 loops=1`. Multiplying is what makes the two plan
 * shapes comparable, and comparing them is the whole point: the property that
 * regressed is how much of the table the statement reads, not which access path
 * the planner happened to pick to read it.
 */
function rowsTouched(plan: string): number {
  const node = requireScanNode(plan, "session_detail");
  const rows = node.match(ACTUAL_ROWS);
  const loops = node.match(LOOPS);
  if (!(rows && loops)) {
    throw new Error(
      `No "actual rows"/"loops" on the session_detail scan node, so this cannot fail closed.\n${node}`
    );
  }
  return Number(rows[1]) * Number(loops[1]);
}

async function explainSql(
  ctx: EphemeralDbContext,
  sql: string,
  start: Date | null,
  end: Date | null
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
    ...facetArgs(start, end)
  );
  return requireNonEmptyPlan(
    rows.map((r) => Object.values(r)[0]).join("\n"),
    `EXPLAIN of sessionLocCoverageCounts for window ${String(start)}..${String(end)}`
  );
}

async function explainCoverage(
  ctx: EphemeralDbContext,
  start: Date | null,
  end: Date | null
): Promise<string> {
  return await explainSql(ctx, COVERAGE_SQL, start, end);
}

describeIfDb("LOC/$ coverage query plan (ISS-9905)", () => {
  let ctx: EphemeralDbContext;

  beforeAll(async () => {
    ctx = await setupEphemeralDb();

    // Residue from a run that never reached its teardown. Swept BEFORE seeding,
    // so a killed worker costs the next run nothing.
    await sweepFixtureOrgs(ctx);

    for (const orgId of [ORG_ID, ...DECOY_ORG_IDS]) {
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        orgId,
        `${FIXTURE_CLERK_PREFIX}${orgId.slice(0, 8)}`,
        `plan-guard-${orgId.slice(0, 8)}`,
        `plan-guard-${orgId.slice(0, 8)}`
      );
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO compute_targets
           (id, organization_id, user_id, machine_name, platform, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'darwin', now())`,
        targetIdFor(orgId),
        orgId,
        ctx.userId,
        `plan-guard-${orgId.slice(0, 8)}`
      );

      // Artifacts and their session_detail rows in two bulk statements, with
      // `last_activity_at` spread over SPREAD_DAYS so the window is selective.
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
         SELECT ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $2::uuid,
                'SESSION', 'plan-guard-' || g::text, 'ACTIVE', now()
         FROM generate_series(1, $3::int) AS g`,
        artifactPrefixFor(orgId),
        orgId,
        sessionsFor(orgId)
      );
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO session_detail
           (artifact_id, compute_target_id, external_session_id, harness,
            session_started_at, session_updated_at, updated_at, last_activity_at,
            estimated_cost)
         SELECT ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $2::uuid,
                'ext-' || $1::text || g::text, 'claude_code',
                now(), now(), now(),
                TIMESTAMP '2025-01-01' + ((g % $3::int) * INTERVAL '1 day'),
                1.5
         FROM generate_series(1, $4::int) AS g`,
        artifactPrefixFor(orgId),
        targetIdFor(orgId),
        SPREAD_DAYS,
        sessionsFor(orgId)
      );

      // DELIVERY LINKS, without which this fixture measures nothing. The
      // `numerator` CTE filters `base` by an EXISTS over `artifact_links`; with
      // no links that subquery is empty, the planner short-circuits, and the
      // session_detail node comes back "(never executed)". The first version of
      // this suite seeded no links and read exactly that.
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
         VALUES ($1::uuid, $2::uuid, 'BRANCH', $3, 'ACTIVE', now())`,
        branchIdFor(orgId),
        orgId,
        `plan-guard-branch-${orgId.slice(0, 8)}`
      );
      // A MERGED pull request on each branch. The numerator requires one since
      // ISS-9904 (#6969); without it the cohort is empty, and a plan guard over
      // an empty cohort measures nothing.
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO pull_request_detail
           (id, organization_id, branch_artifact_id, number, repository_full_name,
            pr_state, merged_at, additions, deletions, is_current, last_verified_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, $3,
                 'MERGED', now(), 40, 2, true, now())`,
        orgId,
        branchIdFor(orgId),
        `acme/plan-guard-${orgId.slice(0, 8)}`
      );
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO artifact_links
           (id, organization_id, source_id, target_id, link_type, metadata, created_at)
         SELECT gen_random_uuid(), $2::uuid,
                ($1::text || lpad(to_hex(g), 12, '0'))::uuid, $3::uuid,
                'RELATES_TO', '{"linkKind":"session_pr"}'::jsonb, now()
         FROM generate_series(1, $4::int) AS g`,
        artifactPrefixFor(orgId),
        orgId,
        branchIdFor(orgId),
        sessionsFor(orgId)
      );
    }

    // Without fresh statistics the planner is choosing from stale estimates and
    // the assertion measures the ANALYZE that did not happen.
    await analyzeTables(ctx.prisma, SEEDED_TABLES);
  });

  afterAll(async () => {
    if (!ctx) {
      return;
    }
    // EVERY STEP RUNS, even when an earlier one rejects (whitlockk on #6972). A bare
    // sequence of awaits stops at the first failed DELETE and the pool close
    // never happens, which leaves a shared database holding a partial fixture —
    // the opposite of what a cleanup is for. Same reason `teardownEphemeralDb`
    // uses this helper internally.
    await settleAll(
      [
        // The sweep compacts what it deletes, because the statistics from setup
        // outlive the deletes and would cost the NEXT planner suite against a
        // 25,500-row fixture that no longer exists (whitlockk on #6972, ISS-11155).
        () => sweepFixtureOrgs(ctx),
        () => teardownEphemeralDb(ctx),
      ],
      "ISS-9905 plan-guard teardown failed"
    );
  });

  it("reads only the window, not the organisation's whole history", async () => {
    // THE REGRESSION, as the property that actually regressed rather than as one
    // particular access path. ISS-9754's unwindowed `base` made the statement's
    // cost a function of how much history exists; the windowed form reads the
    // window.
    //
    // Deliberately NOT asserted as "uses session_detail_last_activity_at_idx":
    // with the org predicate available the planner may legitimately drive from
    // `artifacts` and probe `session_detail` by primary key, which is equally
    // bounded and sometimes cheaper. Pinning the index would pin a planner
    // choice and fail on a healthy plan.
    const windowedPlan = await explainCoverage(ctx, WINDOW_START, WINDOW_END);
    const windowed = rowsTouched(windowedPlan);
    const unwindowed = rowsTouched(
      await explainSql(ctx, UNWINDOWED_SQL, WINDOW_START, WINDOW_END)
    );

    // FLOOR FIRST, because everything below it is a ratio (marisolashgrove on
    // #6972). An in-window cohort of zero — a fixture whose dates stopped
    // landing inside WINDOW_START..WINDOW_END, a numerator CTE whose EXISTS
    // stopped matching — reads `windowed = 0`, and then `unwindowed > 0` is
    // satisfied by any non-zero number at all while the Index Cond assertion
    // still passes on the empty plan. Green guard, nothing measured. Both halves
    // are pinned: the SCAN emitted rows, and the STATEMENT returned a cohort.
    expect(
      windowed,
      "the windowed scan touched no rows, so the comparison below measures nothing"
    ).toBeGreaterThan(0);
    expect(
      await windowedNumeratorCount(ctx),
      "the in-window cohort is empty, so this suite is guarding the plan of a query that finds nothing"
    ).toBeGreaterThan(0);

    // A 7-day window over a SPREAD_DAYS-day spread is ~1/104 of the org, so the
    // gap is two orders of magnitude. An order of magnitude is asserted instead,
    // which is far outside planner noise while leaving no room for the broken
    // shape to pass.
    expect(
      unwindowed,
      "the unwindowed shape must read materially more, or this fixture is too small to tell the two apart"
    ).toBeGreaterThan(windowed * 10);

    const plan = windowedPlan;

    // Never a whole-table read, which is what the original measurement's
    // sequential scan was.
    expect(requireScanNode(plan, "session_detail")).not.toMatch(SEQ_SCAN);

    // AND THE WINDOW MUST BE PUSHED INTO THE INDEX, not merely bounded some
    // other way (davetho on #6972). Rows-touched alone cannot see this:
    // `actual rows` is rows EMITTED, so an org-driven nested loop that probes
    // every session by primary key and applies `last_activity_at` as a
    // post-lookup Filter reports 0 emitted rows across 20,000 loops — which
    // sails through the comparison above while reading the whole org.
    //
    // The INDEX NAME is deliberately not pinned. `requireIndexPredicate` scopes
    // to the session_detail access path (including a bitmap scan's index
    // children) and throws when it is ambiguous, so asserting the COLUMN proves
    // the pushdown without freezing which index serves it.
    expect(requireIndexPredicate(plan, "session_detail")).toContain(
      "last_activity_at"
    );
  });

  it("returns the whole organisation when BOTH bounds are null", async () => {
    // Runs the SHIPPED statement. An earlier version reimplemented a simpler
    // `session_detail` count here, which meant a regression in the real
    // statement's null guards, numerator CTE, delivery-link predicate or
    // projection left this green (davetho on #6972) — a guard that tested a
    // paraphrase of the thing it was guarding.
    //
    // `($2::timestamp IS NULL OR ...)` is what makes an unbounded read a real
    // request rather than one matching nothing; `sessionMergedPrLoc.sql` records
    // that regression having shipped once.
    //
    // Asserted on the RESULT, not the plan: with no window the planner's best
    // access path legitimately differs, so pinning a scan shape here would pin a
    // choice rather than a contract.
    const rows = await ctx.prisma.$queryRawUnsafe<
      { numerator_session_count: bigint }[]
    >(COVERAGE_SQL, ...facetArgs(null, null));

    expect(Number(rows[0]?.numerator_session_count)).toBe(
      SESSIONS_IN_TARGET_ORG
    );
  });
});

/**
 * This suite's leaf tables, handed to the shared purge.
 *
 * Keyed on {@link FIXTURE_CLERK_PREFIX} rather than on this run's ids, so it
 * reclaims residue from runs killed before their teardown; see
 * {@link purgeFixtureOrganizations} for why that matters and why every
 * statement runs.
 */
async function sweepFixtureOrgs(ctx: EphemeralDbContext): Promise<void> {
  const scope = "(SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%')";
  await purgeFixtureOrganizations(ctx.prisma, {
    selector: scope,
    leafDeletes: [
      `DELETE FROM artifact_links WHERE organization_id IN ${scope}`,
      `DELETE FROM pull_request_detail WHERE organization_id IN ${scope}`,
      `DELETE FROM session_detail WHERE artifact_id IN (
         SELECT id FROM artifacts WHERE organization_id IN ${scope})`,
      `DELETE FROM artifacts WHERE organization_id IN ${scope}`,
      `DELETE FROM compute_targets WHERE organization_id IN ${scope}`,
    ],
    values: [FIXTURE_CLERK_PREFIX],
    label: "ISS-9905 plan-guard fixture sweep failed",
  });
}

/** Sessions the SHIPPED statement admits for the measured window. */
async function windowedNumeratorCount(
  ctx: EphemeralDbContext
): Promise<number> {
  const rows = await ctx.prisma.$queryRawUnsafe<
    { numerator_session_count: bigint }[]
  >(COVERAGE_SQL, ...facetArgs(WINDOW_START, WINDOW_END));
  return Number(rows[0]?.numerator_session_count);
}

/** A stable per-org compute target id, so the seed needs no read-back. */
function targetIdFor(orgId: string): string {
  return `00000000-0000-4000-8000-${orgId.replace(/-/g, "").slice(0, 12)}`;
}

/** How many sessions an org gets: the target org is the large one. */
function sessionsFor(orgId: string): number {
  return orgId === ORG_ID ? SESSIONS_IN_TARGET_ORG : SESSIONS_PER_DECOY_ORG;
}

/** The single BRANCH artifact each org's session links point at. */
function branchIdFor(orgId: string): string {
  return `00000000-0000-4000-8001-${orgId.replace(/-/g, "").slice(0, 12)}`;
}

/** A stable per-org artifact id prefix, so ids never collide across orgs. */
function artifactPrefixFor(orgId: string): string {
  return `${orgId.slice(0, 8)}-0000-4000-8000-`;
}
