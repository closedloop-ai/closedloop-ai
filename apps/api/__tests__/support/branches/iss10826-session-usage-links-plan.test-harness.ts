import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import {
  analyzeTables,
  PLANNER_DECOY_ORG_COUNT,
  purgeFixtureOrganizations,
} from "@repo/database/__tests__/test-helpers/planner-fixture";
import { settleAll } from "@repo/database/__tests__/test-helpers/settle-all";
import { keys } from "@repo/database/keys";
import { hasDisposableDatabase } from "@/__tests__/support/integration/migration-upgrade-harness";

export const TARGET_ORGANIZATION_ID = "3e5e12b9-c1f6-4886-b6c2-27b28df271fe";
export const TARGETS_PER_ORGANIZATION = 1000;
export const SOURCES_PER_ORGANIZATION = 4000;
export const HOT_TARGET_LINKS = 4000;
export const OTHER_TARGET_LINKS = 13_000;
export const LINKS_PER_ORGANIZATION = HOT_TARGET_LINKS + OTHER_TARGET_LINKS;
export const REVIEWED_LINKS_PER_ORGANIZATION = LINKS_PER_ORGANIZATION / 10;
export const LEGACY_LINKS_PER_ORGANIZATION = LINKS_PER_ORGANIZATION / 10;
export const WROTE_LINKS_PER_ORGANIZATION =
  LINKS_PER_ORGANIZATION -
  REVIEWED_LINKS_PER_ORGANIZATION -
  LEGACY_LINKS_PER_ORGANIZATION;
export const WRITE_ONLY_LINKS_PER_ORGANIZATION =
  LINKS_PER_ORGANIZATION - REVIEWED_LINKS_PER_ORGANIZATION;
export const EXPECTED_ORGANIZATION_COUNT = PLANNER_DECOY_ORG_COUNT + 1;

export const SEEDED_TABLES = [
  "artifacts",
  "session_detail",
  "artifact_links",
] as const;

const FIXTURE_CLERK_PREFIX = "iss10826_planner_";
const FIXTURE_ORG_SELECTOR =
  "SELECT id FROM organizations WHERE starts_with(clerk_id, $1)";
const FIXTURE_SESSION_PREFIX = "iss10826-";
const NON_HOT_TARGETS = TARGETS_PER_ORGANIZATION - 1;
const LEADING_PATH_SLASH_PATTERN = /^\/+/;

const FixtureArtifactKind = {
  Session: "session",
  Target: "target",
} as const;
type FixtureArtifactKind =
  (typeof FixtureArtifactKind)[keyof typeof FixtureArtifactKind];

export const COMPLETE_TARGET_IDS = targetIdsFor(TARGETS_PER_ORGANIZATION);

const DECOY_ORGANIZATION_IDS = Array.from(
  { length: PLANNER_DECOY_ORG_COUNT },
  (_, index) => fixtureOrganizationId(index + 1)
);
const ALL_ORGANIZATION_IDS = [
  TARGET_ORGANIZATION_ID,
  ...DECOY_ORGANIZATION_IDS,
] as const;

/** The raw PostgreSQL surface used by the fixture and plan guard. */
export type RawClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** Persisted counts that prove every planner population is join-complete. */
export type FixtureCardinality = {
  decoyOrganizations: number;
  hotTargetLinks: number;
  legacyLinksPerOrganization: number;
  linksPerOrganization: number;
  organizations: number;
  reviewedLinksPerOrganization: number;
  sessionDetailsPerOrganization: number;
  sourcesPerOrganization: number;
  targetsPerOrganization: number;
  totalArtifactLinks: number;
  totalHotTargetLinks: number;
  totalSessionArtifacts: number;
  totalSessionDetails: number;
  totalTargets: number;
  writeOnlyLinksPerOrganization: number;
  wroteLinksPerOrganization: number;
};

/** Zero counts that prove no ISS-10826 fixture row survived teardown. */
export type FixtureAbsence = {
  artifactLinks: number;
  artifacts: number;
  computeTargets: number;
  organizations: number;
  sessionDetails: number;
  users: number;
};

/** PostgreSQL identity proven before any setup or teardown mutation. */
export type DatabaseIdentity = {
  databaseName: string;
  version: string;
  versionNumber: number;
};

/** Prove the pointed-at database is disposable PostgreSQL 16. */
export async function requireApprovedDatabase(
  client: RawClient
): Promise<DatabaseIdentity> {
  requireCondition(
    hasDisposableDatabase(),
    "ISS-10826 requires the repository disposable-database contract"
  );
  const databaseUrl = requireValue(
    keys().DATABASE_URL,
    "ISS-10826 requires DATABASE_URL"
  );
  const expectedDatabaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(LEADING_PATH_SLASH_PATTERN, "")
  );
  const identity = await client.$queryRawUnsafe<DatabaseIdentity[]>(
    `SELECT current_database() AS "databaseName",
            version() AS version,
            current_setting('server_version_num')::int AS "versionNumber"`
  );
  const current = requireValue(
    identity[0],
    "PostgreSQL identity returned no row"
  );
  requireCondition(
    current.versionNumber >= 160_000 && current.versionNumber < 170_000,
    `ISS-10826 requires PostgreSQL 16; received ${current.version}`
  );
  requireCondition(
    current.databaseName === expectedDatabaseName,
    `DATABASE_URL names ${expectedDatabaseName}, but PostgreSQL connected to ${current.databaseName}`
  );
  return current;
}

/** Compact planner tables so this suite neither inherits nor leaves dead tuples. */
export function compactPlannerTables(): Promise<number> {
  return withDb((db) =>
    (db as unknown as RawClient).$executeRawUnsafe(
      `VACUUM (FULL, ANALYZE) ${SEEDED_TABLES.join(", ")}`
    )
  );
}

/** Seed the complete-set, twelve-organization ISS-10826 fixture. */
export async function seedFixture(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     SELECT org_id, $2::text || ordinality::text,
            'ISS-10826 planner ' || ordinality::text,
            $2::text || ordinality::text, now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(org_id, ordinality)`,
    [...ALL_ORGANIZATION_IDS],
    FIXTURE_CLERK_PREFIX
  );
  await client.$executeRawUnsafe(
    `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
     SELECT md5(org_id::text || ':user')::uuid,
            $2::text || 'user_' || ordinality::text, org_id,
            $2::text || ordinality::text || '@example.test', now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(org_id, ordinality)`,
    [...ALL_ORGANIZATION_IDS],
    FIXTURE_CLERK_PREFIX
  );
  await client.$executeRawUnsafe(
    `INSERT INTO compute_targets
       (id, organization_id, user_id, machine_name, platform, updated_at)
     SELECT md5(org_id::text || ':compute')::uuid,
            org_id, md5(org_id::text || ':user')::uuid,
            'iss10826-planner', 'darwin', now()
       FROM unnest($1::uuid[]) AS fixture(org_id)`,
    [...ALL_ORGANIZATION_IDS]
  );
  await insertArtifacts(client);
  await insertSessionDetails(client);
  await insertLinks(client, true);
  await insertLinks(client, false);
}

/** Assert the requested targets are the fixture tenant's complete population. */
export async function requireCompleteTargetSet(
  client: RawClient
): Promise<void> {
  const rows = await client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id
       FROM artifacts
      WHERE organization_id = $1::uuid
        AND type = $2::"ArtifactType"`,
    TARGET_ORGANIZATION_ID,
    ArtifactType.BRANCH
  );
  const actual = new Set(rows.map((row) => row.id));
  requireCondition(
    actual.size === TARGETS_PER_ORGANIZATION,
    `Fixture tenant has ${actual.size} targets, expected ${TARGETS_PER_ORGANIZATION}`
  );
  requireCondition(
    COMPLETE_TARGET_IDS.every((targetId) => actual.has(targetId)),
    "The exact-1,000 request is not the fixture tenant's complete target set"
  );
}

/** Read and validate persisted fixture counts for every organization. */
export function requireFixtureCardinality(
  client?: RawClient
): Promise<FixtureCardinality> {
  if (client) {
    return requireFixtureCardinalityFromClient(client);
  }
  return withDb((db) =>
    requireFixtureCardinalityFromClient(db as unknown as RawClient)
  );
}

/** Prove every persisted relation owned by this fixture is empty. */
export function requireFixtureAbsence(
  client?: RawClient
): Promise<FixtureAbsence> {
  if (client) {
    return requireFixtureAbsenceFromClient(client);
  }
  return withDb((db) =>
    requireFixtureAbsenceFromClient(db as unknown as RawClient)
  );
}

/** Refresh statistics after a fixture population change. */
export function analyzeFixture(): Promise<void> {
  return withDb((db) =>
    analyzeTables(db as unknown as RawClient, SEEDED_TABLES)
  );
}

/** Remove this fixture without touching any neighboring test population. */
export function purgeFixture(): Promise<void> {
  return withDb((db) =>
    purgeFixtureOrganizations(db as unknown as RawClient, {
      selector: FIXTURE_ORG_SELECTOR,
      values: [FIXTURE_CLERK_PREFIX],
      label: "ISS-10826 planner fixture purge",
      leafDeletes: [
        `DELETE FROM artifact_links WHERE organization_id IN (${FIXTURE_ORG_SELECTOR})`,
        `DELETE FROM session_detail WHERE artifact_id IN (
           SELECT id FROM artifacts WHERE organization_id IN (${FIXTURE_ORG_SELECTOR})
         )`,
        `DELETE FROM artifacts WHERE organization_id IN (${FIXTURE_ORG_SELECTOR})`,
        `DELETE FROM compute_targets WHERE organization_id IN (${FIXTURE_ORG_SELECTOR})`,
        `DELETE FROM users WHERE organization_id IN (${FIXTURE_ORG_SELECTOR})`,
      ],
    })
  );
}

/** Purge, prove absence, and compact, attempting compaction after purge failure. */
export async function cleanupFixture(): Promise<FixtureAbsence> {
  const cleanupState: { absence: FixtureAbsence | null } = { absence: null };
  await settleAll(
    [
      async () => {
        await purgeFixture();
        cleanupState.absence = await requireFixtureAbsence();
      },
      () => compactPlannerTables(),
    ],
    "ISS-10826 plan-guard cleanup failed"
  );
  return requireValue(
    cleanupState.absence,
    "ISS-10826 cleanup produced no absence proof"
  );
}

async function insertArtifacts(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     SELECT (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8101-' || lpad(to_hex(n), 12, '0'))::uuid,
            org_id, $2::"ArtifactType",
            'iss10826-target-' || lpad(n::text, 4, '0'),
            $3::text, now()
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $4::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    ArtifactType.BRANCH,
    BranchStatus.Open,
    TARGETS_PER_ORGANIZATION
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     SELECT (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8102-' || lpad(to_hex(n), 12, '0'))::uuid,
            org_id, $2::"ArtifactType",
            'iss10826-session-' || lpad(n::text, 4, '0'),
            $3::text, now()
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $4::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    ArtifactType.SESSION,
    SESSION_STATUS.INACTIVE,
    SOURCES_PER_ORGANIZATION
  );
}

async function insertSessionDetails(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO session_detail
       (artifact_id, compute_target_id, external_session_id, harness,
        session_started_at, session_updated_at, last_activity_at, updated_at)
     SELECT (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8102-' || lpad(to_hex(n), 12, '0'))::uuid,
            md5(org_id::text || ':compute')::uuid,
            'iss10826-' || org_id::text || '-' || n::text,
            'claude_code', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01',
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second', now()
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $2::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    SOURCES_PER_ORGANIZATION
  );
}

async function insertLinks(client: RawClient, hot: boolean): Promise<void> {
  const count = hot ? HOT_TARGET_LINKS : OTHER_TARGET_LINKS;
  const targetExpression = hot ? "1" : `2 + ((n - 1) % ${NON_HOT_TARGETS})`;
  const sourceExpression = `1 + ((n - 1) % ${SOURCES_PER_ORGANIZATION})`;
  await client.$executeRawUnsafe(
    `INSERT INTO artifact_links
       (id, organization_id, source_id, target_id, link_type,
        branch_participation, last_contributed_at, metadata, created_at)
     SELECT gen_random_uuid(), org_id,
            (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8102-' || lpad(to_hex(${sourceExpression}), 12, '0'))::uuid,
            (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8101-' || lpad(to_hex(${targetExpression}), 12, '0'))::uuid,
            $2::"LinkType",
            CASE
              WHEN mod(n, 10) = 1 THEN $3::text
              WHEN mod(n, 10) = 2 THEN NULL
              ELSE $4::text
            END,
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second',
            jsonb_build_object('linkKind', $5::text, 'confidence', 1,
                               'method', $6::text),
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second'
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $7::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    LinkType.RelatesTo,
    BranchParticipationKind.Reviewed,
    BranchParticipationKind.Wrote,
    SessionArtifactLinkKind.SessionBranch,
    ArtifactRefMethod.GitCommand,
    count
  );
}

async function requireFixtureCardinalityFromClient(
  client: RawClient
): Promise<FixtureCardinality> {
  const rows = await client.$queryRawUnsafe<
    Array<{
      hotLinks: bigint;
      legacyLinks: bigint;
      links: bigint;
      organizationId: string;
      reviewedLinks: bigint;
      sessionDetails: bigint;
      sources: bigint;
      targets: bigint;
      wroteLinks: bigint;
    }>
  >(
    `WITH fixture_organizations AS (
       SELECT id
         FROM organizations
        WHERE starts_with(clerk_id, $1)
     ), artifact_counts AS (
       SELECT organization_id,
              count(*) FILTER (
                WHERE type = $2::"ArtifactType"
                  AND starts_with(name, 'iss10826-target-')
              )::bigint AS targets,
              count(*) FILTER (
                WHERE type = $3::"ArtifactType"
                  AND starts_with(name, 'iss10826-session-')
              )::bigint AS sources
         FROM artifacts
        WHERE organization_id IN (SELECT id FROM fixture_organizations)
        GROUP BY organization_id
     ), detail_counts AS (
       SELECT session.organization_id,
              count(*)::bigint AS "sessionDetails"
         FROM session_detail AS detail
         JOIN artifacts AS session ON session.id = detail.artifact_id
        WHERE session.organization_id IN (SELECT id FROM fixture_organizations)
          AND starts_with(session.name, 'iss10826-session-')
        GROUP BY session.organization_id
     ), link_counts AS (
       SELECT organization_id,
              count(*)::bigint AS links,
              count(*) FILTER (
                WHERE branch_participation = $4::text
              )::bigint AS "reviewedLinks",
              count(*) FILTER (
                WHERE branch_participation = $5::text
              )::bigint AS "wroteLinks",
              count(*) FILTER (
                WHERE branch_participation IS NULL
              )::bigint AS "legacyLinks",
              count(*) FILTER (
                WHERE target_id = (
                  substring(replace(organization_id::text, '-', '') from 1 for 8)
                  || '-0000-4000-8101-000000000001'
                )::uuid
              )::bigint AS "hotLinks"
         FROM artifact_links
        WHERE organization_id IN (SELECT id FROM fixture_organizations)
        GROUP BY organization_id
     )
     SELECT organization.id AS "organizationId",
            coalesce(artifact.targets, 0)::bigint AS targets,
            coalesce(artifact.sources, 0)::bigint AS sources,
            coalesce(detail."sessionDetails", 0)::bigint AS "sessionDetails",
            coalesce(link.links, 0)::bigint AS links,
            coalesce(link."reviewedLinks", 0)::bigint AS "reviewedLinks",
            coalesce(link."wroteLinks", 0)::bigint AS "wroteLinks",
            coalesce(link."legacyLinks", 0)::bigint AS "legacyLinks",
            coalesce(link."hotLinks", 0)::bigint AS "hotLinks"
       FROM fixture_organizations AS organization
       LEFT JOIN artifact_counts AS artifact
         ON artifact.organization_id = organization.id
       LEFT JOIN detail_counts AS detail
         ON detail.organization_id = organization.id
       LEFT JOIN link_counts AS link
         ON link.organization_id = organization.id
      ORDER BY organization.id`,
    FIXTURE_CLERK_PREFIX,
    ArtifactType.BRANCH,
    ArtifactType.SESSION,
    BranchParticipationKind.Reviewed,
    BranchParticipationKind.Wrote
  );
  requireCondition(
    rows.length === EXPECTED_ORGANIZATION_COUNT,
    `Fixture contains ${rows.length} organizations, expected ${EXPECTED_ORGANIZATION_COUNT}`
  );
  for (const row of rows) {
    requireCondition(
      Number(row.targets) === TARGETS_PER_ORGANIZATION &&
        Number(row.sources) === SOURCES_PER_ORGANIZATION &&
        Number(row.sessionDetails) === SOURCES_PER_ORGANIZATION &&
        Number(row.links) === LINKS_PER_ORGANIZATION &&
        Number(row.reviewedLinks) === REVIEWED_LINKS_PER_ORGANIZATION &&
        Number(row.wroteLinks) === WROTE_LINKS_PER_ORGANIZATION &&
        Number(row.legacyLinks) === LEGACY_LINKS_PER_ORGANIZATION &&
        Number(row.hotLinks) === HOT_TARGET_LINKS,
      `Fixture cardinality drifted for organization ${row.organizationId}: targets=${row.targets}, sources=${row.sources}, sessionDetails=${row.sessionDetails}, links=${row.links}, reviewedLinks=${row.reviewedLinks}, wroteLinks=${row.wroteLinks}, legacyLinks=${row.legacyLinks}, hotLinks=${row.hotLinks}`
    );
  }
  return {
    organizations: rows.length,
    decoyOrganizations: rows.length - 1,
    targetsPerOrganization: TARGETS_PER_ORGANIZATION,
    sourcesPerOrganization: SOURCES_PER_ORGANIZATION,
    sessionDetailsPerOrganization: SOURCES_PER_ORGANIZATION,
    linksPerOrganization: LINKS_PER_ORGANIZATION,
    reviewedLinksPerOrganization: REVIEWED_LINKS_PER_ORGANIZATION,
    wroteLinksPerOrganization: WROTE_LINKS_PER_ORGANIZATION,
    legacyLinksPerOrganization: LEGACY_LINKS_PER_ORGANIZATION,
    writeOnlyLinksPerOrganization: WRITE_ONLY_LINKS_PER_ORGANIZATION,
    hotTargetLinks: HOT_TARGET_LINKS,
    totalArtifactLinks: rows.length * LINKS_PER_ORGANIZATION,
    totalHotTargetLinks: rows.length * HOT_TARGET_LINKS,
    totalSessionArtifacts: rows.length * SOURCES_PER_ORGANIZATION,
    totalSessionDetails: rows.length * SOURCES_PER_ORGANIZATION,
    totalTargets: rows.length * TARGETS_PER_ORGANIZATION,
  };
}

async function requireFixtureAbsenceFromClient(
  client: RawClient
): Promise<FixtureAbsence> {
  const rows = await client.$queryRawUnsafe<
    Record<keyof FixtureAbsence, bigint>[]
  >(
    `SELECT
       (SELECT count(*)::bigint FROM organizations
         WHERE starts_with(clerk_id, $1)) AS organizations,
       (SELECT count(*)::bigint FROM users
         WHERE organization_id = ANY($2::uuid[])) AS users,
       (SELECT count(*)::bigint FROM compute_targets
         WHERE organization_id = ANY($2::uuid[])) AS "computeTargets",
       (SELECT count(*)::bigint FROM artifacts
         WHERE organization_id = ANY($2::uuid[])) AS artifacts,
       (SELECT count(*)::bigint FROM session_detail
         WHERE starts_with(external_session_id, $3)) AS "sessionDetails",
       (SELECT count(*)::bigint FROM artifact_links
         WHERE organization_id = ANY($2::uuid[])) AS "artifactLinks"`,
    FIXTURE_CLERK_PREFIX,
    [...ALL_ORGANIZATION_IDS],
    FIXTURE_SESSION_PREFIX
  );
  const counts = requireValue(rows[0], "Fixture absence query returned no row");
  const absence: FixtureAbsence = {
    organizations: Number(counts.organizations),
    users: Number(counts.users),
    computeTargets: Number(counts.computeTargets),
    artifacts: Number(counts.artifacts),
    sessionDetails: Number(counts.sessionDetails),
    artifactLinks: Number(counts.artifactLinks),
  };
  requireCondition(
    Object.values(absence).every((count) => count === 0),
    `ISS-10826 fixture cleanup left persisted rows: ${JSON.stringify(absence)}`
  );
  return absence;
}

function targetIdsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    fixtureUuid(TARGET_ORGANIZATION_ID, FixtureArtifactKind.Target, index + 1)
  );
}

function fixtureUuid(
  organizationId: string,
  kind: FixtureArtifactKind,
  ordinal: number
): string {
  const prefix = organizationId.replaceAll("-", "").slice(0, 8);
  const family = kind === FixtureArtifactKind.Target ? "8101" : "8102";
  return `${prefix}-0000-4000-${family}-${ordinal.toString(16).padStart(12, "0")}`;
}

function fixtureOrganizationId(ordinal: number): string {
  return `${ordinal.toString(16).padStart(8, "0")}-0000-4000-9100-${ordinal.toString(16).padStart(12, "0")}`;
}

function requireCondition(
  condition: boolean,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}
