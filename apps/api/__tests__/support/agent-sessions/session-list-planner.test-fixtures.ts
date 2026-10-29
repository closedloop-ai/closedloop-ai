import { Harness } from "@repo/api/src/types/agent-component";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, Priority } from "@repo/database";
import {
  analyzeTables,
  compactTables,
  purgeFixtureOrganizations,
} from "@repo/database/__tests__/test-helpers/planner-fixture";
import { withFixtureRawClient } from "@/__tests__/utils/fixture-db";

/**
 * A multi-tenant Sessions population for the planner guards that EXPLAIN the
 * Sessions list reads: organizations → users → compute targets → SESSION
 * artifacts → `session_detail`, inserted set-based so twenty tenants of five
 * hundred sessions are a handful of statements rather than 10,000 round trips.
 *
 * Extracted on the second copy (ISS-9478 beside ISS-9627's keyset suite). Every
 * organization's `clerk_id` starts with the caller's prefix, which is what the
 * purge keys on, so residue a killed run left behind is reclaimed by the next
 * run's pre-seed purge instead of skewing every later planner guard's costs.
 */

/** The narrow client slice this fixture needs. */
type RawExecutor = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/**
 * `Uniform` is the ISS-9627 keyset population exactly: every session inactive,
 * every timestamp `NOW()`, every sort column at its default.
 *
 * `Varied` is a population the Sessions sorts can be walked over: every
 * non-unique sort column carries heavy ties, every nullable sort column carries
 * NULLs, and `last_activity_at` spreads over {@link VARIED_ACTIVITY_SPAN_DAYS}
 * days so a recent date window keeps a fraction of each tenant.
 */
export const SessionListPlannerDetail = {
  Uniform: "uniform",
  Varied: "varied",
} as const;
export type SessionListPlannerDetail =
  (typeof SessionListPlannerDetail)[keyof typeof SessionListPlannerDetail];

/** Days the varied population's `last_activity_at` is spread across, one per session modulo. */
export const VARIED_ACTIVITY_SPAN_DAYS = 90;

export const SESSION_LIST_PLANNER_TABLES = [
  "artifacts",
  "session_detail",
] as const;

export type SessionListPlannerFixture = {
  orgIds: readonly string[];
  sessionsPerOrg: number;
  clerkPrefix: string;
  detail: SessionListPlannerDetail;
};

export async function seedSessionListPlannerFixture(
  db: RawExecutor,
  fixture: SessionListPlannerFixture
): Promise<void> {
  const { orgIds, sessionsPerOrg, clerkPrefix, detail } = fixture;
  const orgs = [...orgIds];
  await db.$executeRawUnsafe(
    `INSERT INTO "organizations" (id, clerk_id, name, slug, updated_at)
     SELECT org_id, $2 || org_id, $2 || org_id, replace($2, '_', '-') || org_id, NOW()
       FROM unnest($1::uuid[]) AS org_id`,
    orgs,
    clerkPrefix
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "users" (id, clerk_id, organization_id, email, updated_at)
     SELECT gen_random_uuid(), 'user_' || $2 || org_id, org_id,
            replace($2, '_', '-') || org_id || '@example.test', NOW()
       FROM unnest($1::uuid[]) AS org_id`,
    orgs,
    clerkPrefix
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "compute_targets" (id, organization_id, user_id, machine_name, platform, updated_at)
     SELECT gen_random_uuid(), u.organization_id, u.id, $2, 'darwin', NOW()
       FROM "users" AS u
      WHERE u.organization_id = ANY($1::uuid[])`,
    orgs,
    clerkPrefix
  );
  if (detail === SessionListPlannerDetail.Uniform) {
    await seedUniformSessions(db, orgs, sessionsPerOrg, clerkPrefix);
    return;
  }
  await seedVariedSessions(db, orgs, sessionsPerOrg, clerkPrefix);
}

/**
 * Delete every organization whose `clerk_id` carries the prefix, and everything
 * hanging off it, leaves first. Call it BEFORE seeding as well as after.
 *
 * Runs on the fixture connection because the purge compacts the tables it
 * empties, which is owner work (ISS-5978). `session_detail` is deleted
 * explicitly even though the `artifacts` delete would cascade to it: the purge
 * only compacts tables a statement names (ISS-11155).
 */
export function purgeSessionListPlannerFixture(
  clerkPrefix: string
): Promise<void> {
  const selector = "SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%'";
  const scope = `(${selector})`;
  return withFixtureRawClient("the session-list planner fixture purge", (c) =>
    purgeFixtureOrganizations(c, {
      selector,
      leafDeletes: [
        `DELETE FROM session_detail WHERE artifact_id IN (
           SELECT id FROM artifacts WHERE organization_id IN ${scope})`,
        `DELETE FROM artifacts WHERE organization_id IN ${scope}`,
        `DELETE FROM compute_targets WHERE organization_id IN ${scope}`,
        `DELETE FROM users WHERE organization_id IN ${scope}`,
      ],
      values: [clerkPrefix],
      label: `${clerkPrefix} session-list planner fixture sweep failed`,
    })
  );
}

/**
 * `ANALYZE` both tables on the fixture connection. ANALYZE is owner-only, and a
 * non-owner is not refused: Postgres skips the table with a WARNING and reports
 * success, so on the ISS-5978 runtime role the plans would be costed against
 * stale statistics.
 */
export function analyzeSessionListPlannerTables(): Promise<void> {
  return withFixtureRawClient("the session-list planner fixture ANALYZE", (c) =>
    analyzeTables(c, SESSION_LIST_PLANNER_TABLES)
  );
}

/**
 * Rewrite both tables so their physical size matches their live rows, and
 * refresh their statistics.
 *
 * FULL rather than plain VACUUM: plain vacuum marks dead tuples reusable but
 * does not shrink the relation, and the planner costs a scan against its pages.
 * Measured for ISS-9478 on a table left with 100,000 dead rows, the Sessions
 * list plan moved between three shapes depending on this alone.
 */
export async function compactSessionListPlannerTables(): Promise<void> {
  // Owner-only maintenance, so it runs on the fixture connection (ISS-5978).
  await withFixtureRawClient("the session-list planner compaction", (c) =>
    compactTables(c, SESSION_LIST_PLANNER_TABLES)
  );
}

async function seedUniformSessions(
  db: RawExecutor,
  orgs: string[],
  sessionsPerOrg: number,
  clerkPrefix: string
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "artifacts" (id, organization_id, type, name, status, updated_at)
     SELECT gen_random_uuid(), org_id, $3::"ArtifactType", $4 || n, $5, NOW()
       FROM unnest($1::uuid[]) AS org_id,
            generate_series(1, $2::int) AS n`,
    orgs,
    sessionsPerOrg,
    ArtifactType.SESSION,
    clerkPrefix,
    SESSION_STATUS.INACTIVE
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "session_detail" (
       artifact_id, compute_target_id, external_session_id,
       session_started_at, session_updated_at, last_activity_at, updated_at
     )
     SELECT a.id, ct.id, 'ext-' || a.id, NOW(), NOW(), NOW(), NOW()
       FROM "artifacts" AS a
       JOIN "compute_targets" AS ct ON ct.organization_id = a.organization_id
      WHERE a.organization_id = ANY($1::uuid[])`,
    orgs
  );
}

/**
 * Each column's value is a function of the session's ordinal `n` within its
 * tenant, with a different modulus per column, so every column ties heavily and
 * the columns do not tie on the same rows. The NULL arm of each nullable column
 * uses a modulus of its own for the same reason.
 */
async function seedVariedSessions(
  db: RawExecutor,
  orgs: string[],
  sessionsPerOrg: number,
  clerkPrefix: string
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "artifacts" (id, organization_id, type, name, status, priority, updated_at)
     SELECT gen_random_uuid(), org_id, $3::"ArtifactType", $4 || n,
            ($5::text[])[1 + n % cardinality($5::text[])],
            CASE WHEN n % 5 = 0 THEN NULL
                 ELSE ($6::text[])[1 + n % cardinality($6::text[])]::"Priority" END,
            NOW()
       FROM unnest($1::uuid[]) AS org_id,
            generate_series(1, $2::int) AS n`,
    orgs,
    sessionsPerOrg,
    ArtifactType.SESSION,
    clerkPrefix,
    Object.values(SESSION_STATUS),
    Object.values(Priority)
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "session_detail" (
       artifact_id, compute_target_id, external_session_id,
       session_started_at, session_updated_at, last_activity_at, updated_at,
       harness, model, repository_full_name, autonomy, estimated_cost
     )
     SELECT a.id, ct.id, 'ext-' || a.id,
            NOW() - make_interval(days => (a.n % $2::int)::int) - interval '2 hours',
            NOW(),
            NOW() - make_interval(days => (a.n % $2::int)::int),
            NOW(),
            ($3::text[])[1 + a.n % cardinality($3::text[])],
            CASE WHEN a.n % 11 = 0 THEN NULL ELSE 'model-' || (a.n % 5) END,
            CASE WHEN a.n % 13 = 0 THEN NULL ELSE 'acme/repo-' || (a.n % 8) END,
            CASE WHEN a.n % 7 = 0 THEN NULL ELSE a.n % 4 END,
            CASE WHEN a.n % 9 = 0 THEN NULL ELSE (a.n % 50) * 0.1 END
       FROM (
         SELECT art.id, art.organization_id,
                row_number() OVER (PARTITION BY art.organization_id ORDER BY art.id) AS n
           FROM "artifacts" AS art
          WHERE art.organization_id = ANY($1::uuid[])
       ) AS a
       JOIN "compute_targets" AS ct ON ct.organization_id = a.organization_id`,
    orgs,
    VARIED_ACTIVITY_SPAN_DAYS,
    [Harness.Claude, Harness.Codex]
  );
}
