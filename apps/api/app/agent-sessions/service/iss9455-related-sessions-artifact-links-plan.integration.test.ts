import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX,
} from "@repo/api/src/types/branch-list-contract";
import {
  RELATED_SESSIONS_DISPLAY_CAP,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
} from "@repo/api/src/types/related-session";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { median } from "@repo/api/src/utils/math";
import { ArtifactType, withDb } from "@repo/database";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import {
  analyzeTables,
  PLANNER_DECOY_ORG_COUNT,
  purgeFixtureOrganizations,
} from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  matching,
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import { hasDisposableDatabase } from "@/__tests__/support/integration/migration-upgrade-harness";
import { withFixtureRawClient } from "@/__tests__/utils/fixture-db";
import { readSessionUsageLinks } from "@/app/branches/branch-read-service/session-usage-link-read";
import { listRelatedSessionsForArtifacts } from "./related-sessions";

const describeIfDb = hasDisposableDatabase() ? describe : describe.skip;

const ARTIFACT_LINKS_TABLE = "artifact_links";
const ARTIFACTS_TABLE = "artifacts";
const SESSION_DETAIL_TABLE = "session_detail";
const FIXTURE_CLERK_PREFIX = "iss9455_planner_";
const FIXTURE_ORG_SELECTOR =
  "SELECT id FROM organizations WHERE clerk_id LIKE $1";
const FIXTURE_ORG_LIKE = `${FIXTURE_CLERK_PREFIX}%`;
const APPROVED_COMPLETE_TARGETS = 500;
const APPROVED_DEFAULT_TARGETS = 20;
const APPROVED_DISPLAY_LIMIT = 8;
const APPROVED_SOURCE_ARTIFACTS = 4000;
const TARGETS_PER_ORGANIZATION = RELATED_SESSIONS_PAGE_ARTIFACT_CAP;
const SOURCES_PER_ORGANIZATION = APPROVED_SOURCE_ARTIFACTS;
const HOT_TARGET_LINKS = 4000;
const OTHER_TARGET_LINKS = 13_000;
const NON_HOT_TARGETS = TARGETS_PER_ORGANIZATION - 1;
const NON_HOT_LINK_QUOTIENT = Math.floor(OTHER_TARGET_LINKS / NON_HOT_TARGETS);
const NON_HOT_LINK_REMAINDER = OTHER_TARGET_LINKS % NON_HOT_TARGETS;
const LINKS_PER_ORGANIZATION = HOT_TARGET_LINKS + OTHER_TARGET_LINKS;
const RELATED_SESSIONS_DISPLAY_LIMIT = RELATED_SESSIONS_DISPLAY_CAP;
const DEFAULT_PAGE_TARGETS = BRANCH_LIST_SERVER_PAGE_SIZE;
const WARM_SAMPLE_COUNT = 6;
const POSTGRES_BIND_LIMIT = 65_535;
const MAXIMUM_HYDRATION_IDS =
  TARGETS_PER_ORGANIZATION * RELATED_SESSIONS_DISPLAY_LIMIT;

const FixtureArtifactKind = {
  Session: "session",
  Target: "target",
} as const;
type FixtureArtifactKind =
  (typeof FixtureArtifactKind)[keyof typeof FixtureArtifactKind];

const TARGET_ORGANIZATION_ID = "2e5e12b9-c1f6-4886-b6c2-27b28df271fe";
const DECOY_ORGANIZATION_IDS = Array.from(
  { length: PLANNER_DECOY_ORG_COUNT },
  (_, index) => fixtureOrganizationId(index + 1)
);
const ALL_ORGANIZATION_IDS = [
  TARGET_ORGANIZATION_ID,
  ...DECOY_ORGANIZATION_IDS,
] as const;
const COMPLETE_TARGET_IDS = targetIdsFor(TARGETS_PER_ORGANIZATION);
const DEFAULT_TARGET_IDS = COMPLETE_TARGET_IDS.slice(0, DEFAULT_PAGE_TARGETS);
const HOT_TARGET_IDS = COMPLETE_TARGET_IDS.slice(0, 1);

const BRANCH_STATEMENT_PATTERN = /\bFROM\s+"?public"?\."?artifact_links"?/i;
const RELATED_STATEMENT_PATTERN = /\bWITH\s+candidate_links\s+AS\s*\(/i;
const SQL_WHITESPACE_PATTERN = /\s+/g;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EXECUTION_TIME_PATTERN = /Execution Time:\s+([0-9.]+)\s+ms/i;
const SEQUENTIAL_SCAN_PATTERN = /\bSeq Scan\b/i;
const FILTER_LINE_PATTERN = /\bFilter:/i;
const SHARED_BUFFER_PATTERN = /\bBuffers:/i;
const LEADING_PATH_SLASH_PATTERN = /^\/+/;
const INDEX_SCAN_NAME_PATTERN =
  /\bIndex(?: Only)? Scan using "?([^"\s]+)"? on artifact_links\b/i;
const BITMAP_INDEX_SCAN_NAME_PATTERN = /\bBitmap Index Scan on "?([^"\s]+)"?/i;
const SOURCE_INDEX_COLUMNS = [
  "organization_id",
  "source_id",
  "link_type",
] as const;
const TARGET_INDEX_COLUMNS = [
  "organization_id",
  "target_id",
  "link_type",
] as const;

const SEEDED_TABLES = [
  ARTIFACTS_TABLE,
  SESSION_DETAIL_TABLE,
  ARTIFACT_LINKS_TABLE,
] as const;

// An author-side measurement run may set this test's read site to an absolute
// private path. When absent, every assertion runs and no artifact is written.
const measurementArtifactPath = absoluteMeasurementArtifactPath(
  process.env.ISS9455_MEASUREMENT_ARTIFACT
);
const FIXTURE_LAYOUT_CAVEAT =
  "The deterministic org-major seed is physically clustered, so PostgreSQL correlation and timing/buffer values describe this synthetic layout, not production's interleaved write history.";

type RawClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const ScenarioKind = {
  Complete: "complete",
  Selective: "selective",
} as const;
type ScenarioKind = (typeof ScenarioKind)[keyof typeof ScenarioKind];

const StatementKind = {
  Branches: "branches",
  RelatedSessions: "related-sessions",
} as const;
type StatementKind = (typeof StatementKind)[keyof typeof StatementKind];

type Scenario = {
  branchStatementSha256: string;
  label: string;
  kind: ScenarioKind;
  relatedStatementSha256: string;
  targetIds: readonly string[];
  expectedBranchRows: number;
  expectedRelatedItems: number;
};

type ScenarioCapture = {
  scenario: Scenario;
  branch: ProductionCapture;
  related: ProductionCapture;
};

type ProductionCapture = {
  statement: ObservedStatement;
  resultRows: number;
};

type PlanSample = {
  executionMs: number;
  bufferLines: string[];
  indexName: string;
  scanType: string;
  indexCondition: string;
  targetFilter: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  {
    branchStatementSha256:
      "d4da59934310910112761bcf012b59ff02f574069bee112644b6f3ecf55a98e5",
    label: "complete-500",
    kind: ScenarioKind.Complete,
    relatedStatementSha256:
      "02abd3dc23f55ce7e38e9c06c07965788518593f58122b82f8ea44c3f991d255",
    targetIds: COMPLETE_TARGET_IDS,
    expectedBranchRows: LINKS_PER_ORGANIZATION,
    expectedRelatedItems:
      TARGETS_PER_ORGANIZATION * RELATED_SESSIONS_DISPLAY_LIMIT,
  },
  {
    branchStatementSha256:
      "08b2de7abefedf1d77867008102e7e89bb56b354c262a13209e9b1bb7a8522b2",
    label: "default-page-20",
    kind: ScenarioKind.Selective,
    relatedStatementSha256:
      "02abd3dc23f55ce7e38e9c06c07965788518593f58122b82f8ea44c3f991d255",
    targetIds: DEFAULT_TARGET_IDS,
    expectedBranchRows: expectedLinkRowsForTargetCount(DEFAULT_PAGE_TARGETS),
    expectedRelatedItems: DEFAULT_PAGE_TARGETS * RELATED_SESSIONS_DISPLAY_LIMIT,
  },
  {
    branchStatementSha256:
      "1e28bb180fad7b2e9e03d40800390a662c8c4d46db8e9410fc1171e6657d73a3",
    label: "hot-target-4000",
    kind: ScenarioKind.Selective,
    relatedStatementSha256:
      "02abd3dc23f55ce7e38e9c06c07965788518593f58122b82f8ea44c3f991d255",
    targetIds: HOT_TARGET_IDS,
    expectedBranchRows: HOT_TARGET_LINKS,
    expectedRelatedItems: RELATED_SESSIONS_DISPLAY_LIMIT,
  },
] as const;

describeIfDb("related sessions artifact_links plans (ISS-9455)", () => {
  let captures: ScenarioCapture[] = [];
  let databaseApproved = false;
  let databaseName = "";
  let fixtureCardinality: Awaited<
    ReturnType<typeof requireFixtureCardinality>
  > | null = null;
  let postgresVersion = "";

  beforeAll(async () => {
    await withDb(async (db) => {
      const client = db as unknown as RawClient;
      const current = await requireApprovedDatabase(client);
      databaseName = current.databaseName;
      postgresVersion = current.version;
      databaseApproved = true;
      await purgeFixture();
      await seed(client);
      await requireCompleteTargetSet(client);
      fixtureCardinality = await requireFixtureCardinality(client);
    });
    captures = [];
    for (const scenario of SCENARIOS) {
      captures.push(await captureScenario(scenario));
    }
  });

  afterAll(async () => {
    if (!databaseApproved) {
      return;
    }
    await purgeFixture();
  });

  it("captures both real production statements with exact cardinality and result shape", () => {
    expect(SOURCES_PER_ORGANIZATION).toBe(APPROVED_SOURCE_ARTIFACTS);
    expect(
      NON_HOT_LINK_QUOTIENT * NON_HOT_TARGETS + NON_HOT_LINK_REMAINDER
    ).toBe(OTHER_TARGET_LINKS);
    expect(new Set(COMPLETE_TARGET_IDS).size).toBe(TARGETS_PER_ORGANIZATION);
    expect(MAXIMUM_HYDRATION_IDS).toBe(4000);
    expect(MAXIMUM_HYDRATION_IDS).toBeLessThan(POSTGRES_BIND_LIMIT);
    expect(TARGETS_PER_ORGANIZATION).toBe(APPROVED_COMPLETE_TARGETS);
    expect(BRANCH_LIST_SERVER_PAGE_SIZE_MAX).toBe(APPROVED_COMPLETE_TARGETS);
    expect(DEFAULT_PAGE_TARGETS).toBe(APPROVED_DEFAULT_TARGETS);
    expect(RELATED_SESSIONS_DISPLAY_LIMIT).toBe(APPROVED_DISPLAY_LIMIT);
    expect(
      requireValue(fixtureCardinality, "fixture was not seeded")
    ).toMatchObject({
      organizations: 12,
      decoyOrganizations: 11,
      targetsPerOrganization: 500,
      sourcesPerOrganization: 4000,
      sessionDetailsPerOrganization: 4000,
      linksPerOrganization: 17_000,
      hotTargetLinks: 4000,
      totalTargets: 6000,
      totalSessionArtifacts: 48_000,
      totalSessionDetails: 48_000,
      totalHotTargetLinks: 48_000,
      totalArtifactLinks: 204_000,
    });

    for (const capture of captures) {
      assertStatementIdentity(
        capture.branch.statement,
        capture.scenario.branchStatementSha256,
        capture.scenario,
        `${capture.scenario.label} branches`,
        false
      );
      assertStatementIdentity(
        capture.related.statement,
        capture.scenario.relatedStatementSha256,
        capture.scenario,
        `${capture.scenario.label} related-sessions`,
        true
      );
      expect(capture.branch.statement.rows).toBe(
        capture.scenario.expectedBranchRows
      );
      expect(capture.branch.resultRows).toBe(
        capture.scenario.expectedBranchRows
      );
      expect(capture.related.statement.rows).toBe(
        capture.scenario.expectedRelatedItems
      );
      expect(capture.related.resultRows).toBe(
        capture.scenario.expectedRelatedItems
      );
    }
  });

  it("keeps the measured complete and selective artifact_links access paths", async () => {
    const measurements: Awaited<ReturnType<typeof measure>>[] = [];
    for (const capture of captures) {
      await analyzeFixture();
      fixtureCardinality = await requireFixtureCardinality();
      measurements.push(
        await measure(
          `${capture.scenario.label}-branches`,
          capture.scenario,
          capture.branch.statement,
          StatementKind.Branches
        ),
        await measure(
          `${capture.scenario.label}-related-sessions`,
          capture.scenario,
          capture.related.statement,
          StatementKind.RelatedSessions
        )
      );
    }
    await analyzeFixture();
    fixtureCardinality = await requireFixtureCardinality();
    measurements.push(await measureControl());

    if (measurementArtifactPath) {
      await writeFile(
        measurementArtifactPath,
        `${JSON.stringify(
          {
            schema: "ISS-9455 planner evidence v4",
            measuredAt: new Date().toISOString(),
            postgresVersion,
            databaseName,
            fixture: requireValue(
              fixtureCardinality,
              "fixture cardinality was not measured"
            ),
            fixtureLayoutCaveat: FIXTURE_LAYOUT_CAVEAT,
            constants: {
              defaultPageTargets: DEFAULT_PAGE_TARGETS,
              completePageTargets: TARGETS_PER_ORGANIZATION,
              relatedSessionsDisplayLimit: RELATED_SESSIONS_DISPLAY_LIMIT,
              maximumHydrationIds: MAXIMUM_HYDRATION_IDS,
              postgresBindLimit: POSTGRES_BIND_LIMIT,
            },
            mechanism:
              "Branches complete-500 remains target-leading; Related Sessions complete-500 may be target-leading or source-leading with target filtering; selective shapes remain target-leading.",
            measurements,
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
    }
  });
});

type DatabaseIdentity = {
  databaseName: string;
  version: string;
  versionNumber: number;
};

async function requireApprovedDatabase(
  client: RawClient
): Promise<DatabaseIdentity> {
  requireCondition(
    hasDisposableDatabase(),
    "ISS-9455 requires the repository disposable-database contract"
  );
  const databaseUrl = requireValue(
    keys().DATABASE_URL,
    "ISS-9455 requires DATABASE_URL"
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
    `ISS-9455 requires PostgreSQL 16; received ${current.version}`
  );
  requireCondition(
    current.databaseName === expectedDatabaseName,
    `DATABASE_URL names ${expectedDatabaseName}, but PostgreSQL connected to ${current.databaseName}`
  );
  return current;
}

function requireFixtureCardinality(client?: RawClient) {
  if (client) {
    return requireFixtureCardinalityFromClient(client);
  }
  return withDb((db) =>
    requireFixtureCardinalityFromClient(db as unknown as RawClient)
  );
}

async function requireFixtureCardinalityFromClient(client: RawClient) {
  const rows = await client.$queryRawUnsafe<
    {
      hotLinks: bigint;
      links: bigint;
      organizationId: string;
      sessionDetails: bigint;
      sources: bigint;
      targets: bigint;
    }[]
  >(
    `SELECT organization.id AS "organizationId",
            (SELECT count(*)::bigint FROM artifacts
              WHERE organization_id = organization.id AND type = $2::"ArtifactType"
                AND name LIKE 'iss9455-target-%') AS targets,
            (SELECT count(*)::bigint FROM artifacts
              WHERE organization_id = organization.id AND type = $3::"ArtifactType"
                AND name LIKE 'iss9455-session-%') AS sources,
            (SELECT count(*)::bigint
               FROM session_detail AS detail
               JOIN artifacts AS session ON session.id = detail.artifact_id
              WHERE session.organization_id = organization.id
                AND session.name LIKE 'iss9455-session-%') AS "sessionDetails",
            (SELECT count(*)::bigint FROM artifact_links
              WHERE organization_id = organization.id) AS links,
            (SELECT count(*)::bigint FROM artifact_links
              WHERE organization_id = organization.id
                AND target_id = (substring(replace(organization.id::text, '-', '') from 1 for 8) || '-0000-4000-8001-000000000001')::uuid) AS "hotLinks"
       FROM organizations AS organization
      WHERE organization.clerk_id LIKE $1
      ORDER BY organization.id`,
    FIXTURE_ORG_LIKE,
    ArtifactType.BRANCH,
    ArtifactType.SESSION
  );
  requireCondition(
    rows.length === ALL_ORGANIZATION_IDS.length,
    `Fixture contains ${rows.length} organizations, expected ${ALL_ORGANIZATION_IDS.length}`
  );
  for (const row of rows) {
    requireCondition(
      Number(row.targets) === TARGETS_PER_ORGANIZATION &&
        Number(row.sources) === SOURCES_PER_ORGANIZATION &&
        Number(row.sessionDetails) === SOURCES_PER_ORGANIZATION &&
        Number(row.links) === LINKS_PER_ORGANIZATION &&
        Number(row.hotLinks) === HOT_TARGET_LINKS,
      `Fixture cardinality drifted for organization ${row.organizationId}: targets=${row.targets}, sources=${row.sources}, sessionDetails=${row.sessionDetails}, links=${row.links}, hotLinks=${row.hotLinks}`
    );
  }
  return {
    organizations: rows.length,
    decoyOrganizations: rows.length - 1,
    targetsPerOrganization: TARGETS_PER_ORGANIZATION,
    sourcesPerOrganization: SOURCES_PER_ORGANIZATION,
    sessionDetailsPerOrganization: SOURCES_PER_ORGANIZATION,
    linksPerOrganization: LINKS_PER_ORGANIZATION,
    hotTargetLinks: HOT_TARGET_LINKS,
    totalArtifactLinks: rows.length * LINKS_PER_ORGANIZATION,
    totalHotTargetLinks: rows.length * HOT_TARGET_LINKS,
    totalSessionArtifacts: rows.length * SOURCES_PER_ORGANIZATION,
    totalSessionDetails: rows.length * SOURCES_PER_ORGANIZATION,
    totalTargets: rows.length * TARGETS_PER_ORGANIZATION,
  };
}

async function captureScenario(scenario: Scenario): Promise<ScenarioCapture> {
  assertScenarioCardinality(scenario);
  const branchCapture = await observeStatements(() =>
    withDb((db) =>
      readSessionUsageLinks(
        db,
        TARGET_ORGANIZATION_ID,
        [...scenario.targetIds],
        { includeReviewedIdentityEvidence: true }
      )
    )
  );
  const branchStatements = matching(
    branchCapture.statements,
    BRANCH_STATEMENT_PATTERN
  );
  requireCondition(
    branchStatements.length === 1,
    `Expected one Branches artifact_links statement, captured ${branchStatements.length}`
  );

  const relatedCapture = await observeStatements(() =>
    listRelatedSessionsForArtifacts(
      TARGET_ORGANIZATION_ID,
      scenario.targetIds,
      RELATED_SESSIONS_DISPLAY_LIMIT
    )
  );
  const relatedStatements = matching(
    relatedCapture.statements,
    RELATED_STATEMENT_PATTERN
  );
  requireCondition(
    relatedStatements.length === 1,
    `Expected one Related Sessions candidate_links statement, captured ${relatedStatements.length}`
  );
  const relatedItems = Object.values(relatedCapture.result).reduce(
    (total, result) => total + result.items.length,
    0
  );
  requireCondition(
    arraysEqual(Object.keys(relatedCapture.result), scenario.targetIds),
    `${scenario.label} Related Sessions result keys do not match the requested targets`
  );
  for (const [index, targetId] of scenario.targetIds.entries()) {
    const result = relatedCapture.result[targetId];
    const expectedTotal = expectedLinksForTarget(index + 1);
    requireCondition(
      result !== undefined,
      `${scenario.label} returned no result for ${targetId}`
    );
    requireCondition(
      result.items.length === RELATED_SESSIONS_DISPLAY_LIMIT,
      `${scenario.label} returned ${result.items.length} items for ${targetId}`
    );
    requireCondition(
      result.total === expectedTotal,
      `${scenario.label} returned total ${result.total} for target ${index + 1}; expected ${expectedTotal} from quotient=${NON_HOT_LINK_QUOTIENT}, remainder=${NON_HOT_LINK_REMAINDER}, nonHotTargets=${NON_HOT_TARGETS}`
    );
  }

  return {
    scenario,
    branch: {
      statement: branchStatements[0] as ObservedStatement,
      resultRows: branchCapture.result.length,
    },
    related: {
      statement: relatedStatements[0] as ObservedStatement,
      resultRows: relatedItems,
    },
  };
}

function assertScenarioCardinality(scenario: Scenario): void {
  requireCondition(
    new Set(scenario.targetIds).size === scenario.targetIds.length,
    `${scenario.label} contains duplicate target ids`
  );
  if (scenario.kind === ScenarioKind.Complete) {
    requireCondition(
      arraysEqual(scenario.targetIds, COMPLETE_TARGET_IDS),
      `${scenario.label} is not the fixture tenant's complete target set`
    );
    requireCondition(
      scenario.targetIds.length === TARGETS_PER_ORGANIZATION,
      `${scenario.label} must contain exactly ${TARGETS_PER_ORGANIZATION} targets`
    );
    return;
  }
  requireCondition(
    scenario.targetIds.length < TARGETS_PER_ORGANIZATION,
    `${scenario.label} is selective only below ${TARGETS_PER_ORGANIZATION} targets`
  );
}

function assertStatementIdentity(
  statement: ObservedStatement,
  expectedSha256: string,
  scenario: Scenario,
  label: string,
  expectsTargetArrayBind: boolean
): void {
  const fingerprint = statementFingerprint(statement.sql);
  requireCondition(
    fingerprint === expectedSha256,
    `${label} production statement changed; reviewed fingerprint is ${expectedSha256}, captured ${fingerprint}`
  );
  const boundTargets = uuidsIn(statement.values).filter((value) =>
    scenario.targetIds.includes(value)
  );
  requireCondition(
    new Set(boundTargets).size === scenario.targetIds.length,
    `${label} captured only ${new Set(boundTargets).size} of ${scenario.targetIds.length} requested targets`
  );
  requireCondition(
    statement.values.length < POSTGRES_BIND_LIMIT,
    `${label} used ${statement.values.length} binds, exceeding PostgreSQL's limit`
  );
  if (expectsTargetArrayBind) {
    requireCondition(
      targetBindCarrierCount(statement.values, scenario.targetIds) === 1,
      `${label} must carry the complete target set in exactly one uuid-array bind`
    );
  }
}

async function measure(
  label: string,
  scenario: Scenario,
  statement: ObservedStatement,
  statementKind: StatementKind
) {
  return {
    label,
    targetCardinality: scenario.targetIds.length,
    productionRows: statement.rows,
    statementSha256: statementFingerprint(statement.sql),
    bindCount: statement.values.length,
    ...(await collectPlanSamples(statement, (sample) =>
      assertPlanShape(sample, scenario, statementKind)
    )),
  };
}

async function measureControl() {
  const result = await withDb((db) =>
    (db as unknown as RawClient).$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*)::bigint AS count FROM artifact_links WHERE organization_id = $1::uuid",
      TARGET_ORGANIZATION_ID
    )
  );
  const statement: ObservedStatement = {
    sql: "SELECT count(*)::bigint AS count FROM artifact_links WHERE organization_id = $1::uuid",
    values: [TARGET_ORGANIZATION_ID],
    rows: Number(result[0]?.count ?? 0n),
  };
  return {
    label: "organization-control",
    targetCardinality: 0,
    productionRows: statement.rows,
    statementSha256: statementFingerprint(statement.sql),
    bindCount: statement.values.length,
    ...(await collectPlanSamples(statement, assertControlPlan)),
  };
}

async function collectPlanSamples(
  statement: ObservedStatement,
  assertShape: (sample: PlanSample) => void
) {
  const warmup = await explain(statement);
  assertShape(warmup);
  const samples: PlanSample[] = [];
  if (measurementArtifactPath) {
    for (let index = 0; index < WARM_SAMPLE_COUNT; index++) {
      const sample = await explain(statement);
      assertShape(sample);
      samples.push(sample);
    }
  }
  const timings = samples.map((sample) => sample.executionMs);
  return {
    warmup,
    samples,
    ...(timings.length > 0
      ? {
          medianMs: requireValue(
            median(timings),
            "warm samples have no median"
          ),
          spreadMs: Math.max(...timings) - Math.min(...timings),
        }
      : {}),
  };
}

function assertPlanShape(
  sample: PlanSample,
  scenario: Scenario,
  statementKind: StatementKind
): void {
  const targetLeading =
    hasOrderedColumns(sample.indexCondition, TARGET_INDEX_COLUMNS) &&
    sourceFollowsTargetKeys(sample.indexCondition);
  const sourceLeading =
    hasOrderedColumns(sample.indexCondition, SOURCE_INDEX_COLUMNS) &&
    !sample.indexCondition.includes("target_id");
  const evidence = `condition=${sample.indexCondition}; scan=${sample.scanType}; index=${sample.indexName}; targetFilter=${sample.targetFilter}`;
  if (scenario.kind === ScenarioKind.Selective) {
    requireCondition(
      targetLeading,
      `${scenario.label} ${statementKind} did not use target-leading access; ${evidence}`
    );
    return;
  }
  if (statementKind === StatementKind.Branches) {
    requireCondition(
      targetLeading && !sample.targetFilter,
      `${scenario.label} Branches must use target-leading access without a target filter; ${evidence}`
    );
    return;
  }
  requireCondition(
    (targetLeading && !sample.targetFilter) ||
      (sourceLeading && sample.targetFilter),
    `${scenario.label} Related Sessions must use target-leading access or source-leading access with a target filter; ${evidence}`
  );
}

function assertControlPlan(sample: PlanSample): void {
  requireCondition(
    sample.indexCondition.includes("organization_id"),
    `organization control did not expose an organization index condition; scan=${sample.scanType}; index=${sample.indexName}`
  );
}

async function explain(statement: ObservedStatement): Promise<PlanSample> {
  const plan = await withDb(async (db) => {
    const rows = await (db as unknown as RawClient).$queryRawUnsafe<
      Record<string, string>[]
    >(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, ...statement.values);
    return requireNonEmptyPlan(
      rows.map((row) => Object.values(row)[0]).join("\n"),
      "ISS-9455 production statement"
    );
  });
  return planSample(plan);
}

function planSample(plan: string): PlanSample {
  const scan = requireScanNode(plan, ARTIFACT_LINKS_TABLE);
  const scanType = scan.split("\n")[0]?.trim() ?? "";
  requireCondition(
    !SEQUENTIAL_SCAN_PATTERN.test(scan),
    `artifact_links reached a sequential scan before index-predicate extraction: ${scanType}`
  );
  const indexCondition = requireIndexPredicate(plan, ARTIFACT_LINKS_TABLE);
  const executionMatch = plan.match(EXECUTION_TIME_PATTERN);
  if (!executionMatch) {
    throw new Error(`EXPLAIN exposed no execution time:\n${plan}`);
  }
  return {
    executionMs: Number(executionMatch[1]),
    bufferLines: plan
      .split("\n")
      .filter((line) => SHARED_BUFFER_PATTERN.test(line)),
    indexName: chosenIndexName(plan, scanType, indexCondition),
    scanType,
    indexCondition,
    targetFilter: scan
      .split("\n")
      .some(
        (line) => FILTER_LINE_PATTERN.test(line) && line.includes("target_id")
      ),
  };
}

function chosenIndexName(
  plan: string,
  scanType: string,
  indexCondition: string
): string {
  const direct = scanType.match(INDEX_SCAN_NAME_PATTERN)?.[1];
  if (direct) {
    return direct;
  }
  const lines = plan.split("\n");
  const conditionLine = lines.indexOf(indexCondition);
  for (let index = conditionLine - 1; index >= 0; index--) {
    const bitmap = lines[index]?.match(BITMAP_INDEX_SCAN_NAME_PATTERN)?.[1];
    if (bitmap) {
      return bitmap;
    }
  }
  throw new Error(`No chosen index name was exposed for ${scanType}`);
}

async function seed(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     SELECT org_id, $2::text || ordinality::text,
            'ISS-9455 planner ' || ordinality::text,
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
            'iss9455-planner', 'darwin', now()
       FROM unnest($1::uuid[]) AS fixture(org_id)`,
    [...ALL_ORGANIZATION_IDS]
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     SELECT (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8001-' || lpad(to_hex(n), 12, '0'))::uuid,
            org_id, $2::"ArtifactType",
            'iss9455-target-' || lpad(n::text, 3, '0'),
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
             || '-0000-4000-8002-' || lpad(to_hex(n), 12, '0'))::uuid,
            org_id, $2::"ArtifactType",
            'iss9455-session-' || lpad(n::text, 4, '0'),
            $3::text, now()
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $4::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    ArtifactType.SESSION,
    SESSION_STATUS.INACTIVE,
    SOURCES_PER_ORGANIZATION
  );
  // ISS-11215: stale artifacts stats make each FK check below a full index scan
  await analyzeFixture();
  await client.$executeRawUnsafe(
    `INSERT INTO session_detail
       (artifact_id, compute_target_id, external_session_id, harness,
        session_started_at, session_updated_at, last_activity_at, updated_at)
     SELECT (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8002-' || lpad(to_hex(n), 12, '0'))::uuid,
            md5(org_id::text || ':compute')::uuid,
            'iss9455-' || org_id::text || '-' || n::text,
            'claude_code', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01',
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second',
            now()
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $2::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    SOURCES_PER_ORGANIZATION
  );
  await insertLinks(client, true);
  await insertLinks(client, false);
  await analyzeFixture();
}

async function requireCompleteTargetSet(client: RawClient): Promise<void> {
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
    "The approved complete-500 request is not the fixture tenant's complete target set"
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
     SELECT gen_random_uuid(),
            org_id,
            (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8002-' || lpad(to_hex(${sourceExpression}), 12, '0'))::uuid,
            (substring(replace(org_id::text, '-', '') from 1 for 8)
             || '-0000-4000-8001-' || lpad(to_hex(${targetExpression}), 12, '0'))::uuid,
            $2::"LinkType", $3::text,
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second',
            jsonb_build_object('linkKind', $4::text, 'confidence', 1,
                               'method', $5::text),
            TIMESTAMP '2026-01-01' + n * INTERVAL '1 second'
       FROM unnest($1::uuid[]) AS fixture(org_id),
            generate_series(1, $6::int) AS n`,
    [...ALL_ORGANIZATION_IDS],
    LinkType.RelatesTo,
    BranchParticipationKind.Wrote,
    SessionArtifactLinkKind.SessionBranch,
    ArtifactRefMethod.GitCommand,
    count
  );
}

async function purgeFixture(): Promise<void> {
  await withFixtureRawClient("the ISS-9455 planner fixture purge", (client) =>
    purgeFixtureOrganizations(client, {
      selector: FIXTURE_ORG_SELECTOR,
      values: [FIXTURE_ORG_LIKE],
      label: "ISS-9455 planner fixture purge",
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

/**
 * ANALYZE is owner-only maintenance and a non-owner does not fail: Postgres
 * SKIPS each table it does not own with a WARNING and reports success. On the
 * ISS-5978 runtime role this would quietly do nothing and every plan below
 * would be costed against whatever statistics happened to be there, so it runs
 * on the fixture connection.
 */
function analyzeFixture(): Promise<void> {
  return withFixtureRawClient("the ISS-9455 plan-guard ANALYZE", (client) =>
    analyzeTables(client, SEEDED_TABLES)
  );
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
  const family = kind === FixtureArtifactKind.Target ? "8001" : "8002";
  return `${prefix}-0000-4000-${family}-${ordinal.toString(16).padStart(12, "0")}`;
}

function fixtureOrganizationId(ordinal: number): string {
  return `${ordinal.toString(16).padStart(8, "0")}-0000-4000-9000-${ordinal.toString(16).padStart(12, "0")}`;
}

function expectedLinksForTarget(targetOrdinal: number): number {
  if (targetOrdinal === 1) {
    return HOT_TARGET_LINKS;
  }
  return (
    NON_HOT_LINK_QUOTIENT +
    (targetOrdinal - 1 <= NON_HOT_LINK_REMAINDER ? 1 : 0)
  );
}

function expectedLinkRowsForTargetCount(targetCount: number): number {
  const nonHotTargetCount = Math.max(0, targetCount - 1);
  return (
    (targetCount > 0 ? HOT_TARGET_LINKS : 0) +
    nonHotTargetCount * NON_HOT_LINK_QUOTIENT +
    Math.min(nonHotTargetCount, NON_HOT_LINK_REMAINDER)
  );
}

function statementFingerprint(sql: string): string {
  return createHash("sha256")
    .update(
      sql
        .replace(UUID_PATTERN, "<uuid>")
        .replace(SQL_WHITESPACE_PATTERN, " ")
        .trim()
    )
    .digest("hex");
}

function uuidsIn(values: readonly unknown[]): string[] {
  const uuids: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      uuids.push(...uuidsIn(value));
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    uuids.push(
      ...(value.match(UUID_PATTERN) ?? []).map((uuid) => uuid.toLowerCase())
    );
  }
  return uuids;
}

function targetBindCarrierCount(
  values: readonly unknown[],
  targetIds: readonly string[]
): number {
  return values.filter((value) => {
    const carried = new Set(uuidsIn([value]));
    return (
      carried.size === targetIds.length &&
      targetIds.every((targetId) => carried.has(targetId))
    );
  }).length;
}

function hasOrderedColumns(
  predicate: string,
  columns: readonly string[]
): boolean {
  let previous = -1;
  for (const column of columns) {
    const current = predicate.indexOf(column);
    if (current <= previous) {
      return false;
    }
    previous = current;
  }
  return true;
}

function sourceFollowsTargetKeys(predicate: string): boolean {
  const source = predicate.indexOf("source_id");
  const linkType = predicate.indexOf("link_type");
  return source === -1 || source > linkType;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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

function absoluteMeasurementArtifactPath(
  candidate: string | undefined
): string | undefined {
  if (!candidate) {
    return undefined;
  }
  requireCondition(
    path.isAbsolute(candidate),
    "ISS9455_MEASUREMENT_ARTIFACT must be an absolute private path"
  );
  return candidate;
}
