import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { median } from "@repo/api/src/utils/math";
import { ArtifactType, withDb } from "@repo/database";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeFixture,
  COMPLETE_TARGET_IDS,
  cleanupFixture,
  compactPlannerTables,
  EXPECTED_ORGANIZATION_COUNT,
  type FixtureAbsence,
  type FixtureCardinality,
  LEGACY_LINKS_PER_ORGANIZATION,
  LINKS_PER_ORGANIZATION,
  purgeFixture,
  type RawClient,
  REVIEWED_LINKS_PER_ORGANIZATION,
  requireApprovedDatabase,
  requireCompleteTargetSet,
  requireFixtureAbsence,
  requireFixtureCardinality,
  seedFixture,
  TARGET_ORGANIZATION_ID,
  TARGETS_PER_ORGANIZATION,
  WRITE_ONLY_LINKS_PER_ORGANIZATION,
  WROTE_LINKS_PER_ORGANIZATION,
} from "@/__tests__/support/branches/iss10826-session-usage-links-plan.test-harness";
import {
  matching,
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import { hasDisposableDatabase } from "@/__tests__/support/integration/migration-upgrade-harness";
import {
  readSessionUsageLinks,
  SESSION_USAGE_BRANCH_ID_CHUNK_SIZE,
  type SessionUsageLink,
} from "./session-usage-link-read";

const describeIfDb = hasDisposableDatabase() ? describe : describe.skip;
const measurementArtifactPath = absoluteMeasurementArtifactPath(
  process.env.ISS10826_MEASUREMENT_ARTIFACT
);

const ARTIFACT_LINKS_TABLE = "artifact_links";
const POSTGRES_BIND_LIMIT = 65_535;
const WARM_SAMPLE_COUNT = 6;
const REVIEWED_BIND_COUNT = 1011;
const WRITE_ONLY_BIND_COUNT = 1010;
const REVIEWED_STATEMENT_SHA256 =
  "63710866902f019789dd25d5504ca30b8501e207899c10f7b9598c83218d1f2c";
const WRITE_ONLY_STATEMENT_SHA256 =
  "84b7fa43f8a9df9849a0f036a7bc445d88271fd1ba735c76bac48d8900c3d406";
const RAW_STATEMENT_PATTERN = /\bFROM\s+artifact_links\s+al\b/i;
const PRISMA_STATEMENT_PATTERN = /\bFROM\s+"public"\."artifact_links"/i;
const SQL_WHITESPACE_PATTERN = /\s+/g;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EXECUTION_TIME_PATTERN = /Execution Time:\s+([0-9.]+)\s+ms/i;
const SEQUENTIAL_SCAN_PATTERN = /\bSeq Scan\b/i;
const FILTER_LINE_PATTERN = /\bFilter:/i;
const BUFFER_PATTERN = /\bBuffers:/i;
const INDEX_SCAN_NAME_PATTERN =
  /\bIndex(?: Only)? Scan using "?([^"\s]+)"? on artifact_links\b/i;
const BITMAP_INDEX_SCAN_NAME_PATTERN = /\bBitmap Index Scan on "?([^"\s]+)"?/i;
const TARGET_INDEX_COLUMNS = [
  "organization_id",
  "target_id",
  "link_type",
] as const;
const FIXTURE_LAYOUT_CAVEAT =
  "The deterministic org-major seed is physically clustered and guards only the complete-set exact-1,000 population; timings and buffers are synthetic evidence, not production latency.";

const ParticipationVariant = {
  Reviewed: "reviewed",
  WriteOnly: "write-only",
} as const;
type ParticipationVariant =
  (typeof ParticipationVariant)[keyof typeof ParticipationVariant];

type ProductionCapture = {
  result: SessionUsageLink[];
  statement: ObservedStatement;
  variant: ParticipationVariant;
};

type PlanSample = {
  bufferLines: string[];
  executionMs: number;
  indexCondition: string;
  indexName: string;
  planShape: string;
  scanType: string;
  targetFilter: boolean;
};

type MeasurementSet = {
  bindCount: number;
  driverRows: number;
  label: string;
  populationRows: number;
  samples: PlanSample[];
  statementSha256: string;
  structuralSample: PlanSample;
  targetCardinality: number;
  medianMs?: number;
  spreadMs?: number;
};

describeIfDb(
  "readSessionUsageLinks raw plan at 1,000 targets (ISS-10826)",
  () => {
    let databaseApproved = false;
    let cleanupComplete = false;
    let databaseName = "";
    let postgresVersion = "";
    let fixtureCardinality: FixtureCardinality | null = null;
    let reviewedCapture: ProductionCapture | null = null;
    let writeOnlyCapture: ProductionCapture | null = null;
    let statementsApproved = false;
    let reviewedPlanApproved = false;
    let writeOnlyPlanApproved = false;
    let controlApproved = false;
    const measurements: MeasurementSet[] = [];
    const phaseDurationsMs: Record<string, number> = Object.create(null);

    beforeAll(async () => {
      await recordPhase(
        phaseDurationsMs,
        "admission_and_compaction",
        async () => {
          await withDb(async (db) => {
            const identity = await requireApprovedDatabase(
              db as unknown as RawClient
            );
            databaseName = identity.databaseName;
            postgresVersion = identity.version;
          });
          databaseApproved = true;
          await purgeFixture();
          await requireFixtureAbsence();
          await compactPlannerTables();
        }
      );
    });

    afterAll(async () => {
      if (!(databaseApproved && !cleanupComplete)) {
        return;
      }
      await cleanupFixture();
    });

    it("seeds one join-complete complete-set population and captures both raw statements", async () => {
      await recordPhase(phaseDurationsMs, "seed_and_capture", async () => {
        await withDb(async (db) => {
          const client = db as unknown as RawClient;
          await seedFixture(client);
          await requireCompleteTargetSet(client);
          fixtureCardinality = await requireFixtureCardinality(client);
          await analyzeFixture();
        });
        reviewedCapture = await captureProductionStatement(
          ParticipationVariant.Reviewed
        );
        writeOnlyCapture = await captureProductionStatement(
          ParticipationVariant.WriteOnly
        );
      });
    });

    it("pins statement identity, bind cardinality, results, and observable ordering", () => {
      expect(SESSION_USAGE_BRANCH_ID_CHUNK_SIZE).toBe(TARGETS_PER_ORGANIZATION);
      expect(COMPLETE_TARGET_IDS).toHaveLength(TARGETS_PER_ORGANIZATION);
      expect(new Set(COMPLETE_TARGET_IDS).size).toBe(TARGETS_PER_ORGANIZATION);
      expect(fixtureCardinality).toMatchObject({
        organizations: EXPECTED_ORGANIZATION_COUNT,
        decoyOrganizations: EXPECTED_ORGANIZATION_COUNT - 1,
        targetsPerOrganization: 1000,
        sourcesPerOrganization: 4000,
        sessionDetailsPerOrganization: 4000,
        linksPerOrganization: 17_000,
        hotTargetLinks: 4000,
        reviewedLinksPerOrganization: 1700,
        wroteLinksPerOrganization: 13_600,
        legacyLinksPerOrganization: 1700,
        writeOnlyLinksPerOrganization: 15_300,
        totalTargets: 12_000,
        totalSessionArtifacts: 48_000,
        totalSessionDetails: 48_000,
        totalHotTargetLinks: 48_000,
        totalArtifactLinks: 204_000,
      });
      assertCapture(
        requireValue(reviewedCapture, "reviewed capture is unavailable"),
        REVIEWED_STATEMENT_SHA256,
        REVIEWED_BIND_COUNT,
        LINKS_PER_ORGANIZATION
      );
      assertCapture(
        requireValue(writeOnlyCapture, "write-only capture is unavailable"),
        WRITE_ONLY_STATEMENT_SHA256,
        WRITE_ONLY_BIND_COUNT,
        WRITE_ONLY_LINKS_PER_ORGANIZATION
      );
      statementsApproved = true;
    });

    it("keeps the reviewed-participation raw statement on one stable organization-scoped plan", async () => {
      await recordPhase(phaseDurationsMs, "reviewed_plan", async () => {
        requireCondition(
          statementsApproved,
          "Reviewed plan measurement requires approved statement captures"
        );
        if (measurementArtifactPath) {
          await requireFixtureCardinality();
          await analyzeFixture();
        }
        const capture = requireValue(
          reviewedCapture,
          "reviewed capture is unavailable"
        );
        measurements.push(
          await collectPlanSamples(
            capture.variant,
            capture.statement,
            (sample) => assertPlanShape(sample, capture.variant)
          )
        );
        reviewedPlanApproved = true;
      });
    });

    it("keeps the write-only raw statement on one stable organization-scoped plan", async () => {
      await recordPhase(phaseDurationsMs, "write_only_plan", async () => {
        requireCondition(
          statementsApproved && reviewedPlanApproved,
          "Write-only plan measurement requires approved statements and reviewed plan"
        );
        if (measurementArtifactPath) {
          await requireFixtureCardinality();
          await analyzeFixture();
        }
        const capture = requireValue(
          writeOnlyCapture,
          "write-only capture is unavailable"
        );
        measurements.push(
          await collectPlanSamples(
            capture.variant,
            capture.statement,
            (sample) => assertPlanShape(sample, capture.variant)
          )
        );
        writeOnlyPlanApproved = true;
      });
    });

    it("retains an unchanged organization-scoped control", async () => {
      await recordPhase(phaseDurationsMs, "organization_control", async () => {
        requireCondition(
          writeOnlyPlanApproved,
          "Control measurement requires both approved production plans"
        );
        if (measurementArtifactPath) {
          await requireFixtureCardinality();
          await analyzeFixture();
        }
        measurements.push(await measureControl());
        controlApproved = true;
      });
    });

    it("writes private evidence and leaves compact planner tables", async () => {
      const cleanupState: { absence: FixtureAbsence | null } = {
        absence: null,
      };
      await recordPhase(phaseDurationsMs, "cleanup", async () => {
        cleanupState.absence = await cleanupFixture();
        cleanupComplete = true;
      });
      requireCondition(
        statementsApproved &&
          reviewedPlanApproved &&
          writeOnlyPlanApproved &&
          controlApproved &&
          measurements.length === 3,
        "ISS-10826 evidence requires approved statements, both plans, and the control"
      );
      if (measurementArtifactPath) {
        await writeMeasurementArtifact({
          cleanupAbsence: requireValue(
            cleanupState.absence,
            "cleanup absence evidence is unavailable"
          ),
          databaseName,
          fixtureCardinality: requireValue(
            fixtureCardinality,
            "fixture cardinality is unavailable"
          ),
          measurements,
          phaseDurationsMs,
          postgresVersion,
        });
      }
    });
  }
);

async function captureProductionStatement(
  variant: ParticipationVariant
): Promise<ProductionCapture> {
  const includeReviewedParticipation =
    variant === ParticipationVariant.Reviewed;
  const capture = await observeStatements(() =>
    withDb((db) =>
      readSessionUsageLinks(db, TARGET_ORGANIZATION_ID, COMPLETE_TARGET_IDS, {
        includeReviewedIdentityEvidence: includeReviewedParticipation,
      })
    )
  );
  const rawStatements = matching(capture.statements, RAW_STATEMENT_PATTERN);
  const prismaStatements = matching(
    capture.statements,
    PRISMA_STATEMENT_PATTERN
  );
  requireCondition(
    rawStatements.length === 1,
    `${variant} captured ${rawStatements.length} raw artifact_links statements instead of one`
  );
  requireCondition(
    prismaStatements.length === 0,
    `${variant} unexpectedly executed ${prismaStatements.length} sub-threshold Prisma statements`
  );
  return {
    result: capture.result,
    statement: rawStatements[0] as ObservedStatement,
    variant,
  };
}

function assertCapture(
  capture: ProductionCapture,
  expectedSha256: string,
  expectedBindCount: number,
  expectedRowCount: number
): void {
  const fingerprint = statementFingerprint(capture.statement.sql);
  requireCondition(
    fingerprint === expectedSha256,
    `${capture.variant} statement changed: expected=${expectedSha256}, captured=${fingerprint}. Re-run the isolated author measurement and obtain approval before re-baselining.`
  );
  const boundTargets = uuidsIn(capture.statement.values).filter((value) =>
    COMPLETE_TARGET_IDS.includes(value)
  );
  requireCondition(
    boundTargets.length === TARGETS_PER_ORGANIZATION &&
      new Set(boundTargets).size === TARGETS_PER_ORGANIZATION,
    `${capture.variant} did not carry exactly ${TARGETS_PER_ORGANIZATION} unique target binds`
  );
  requireCondition(
    capture.statement.values.length === expectedBindCount &&
      capture.statement.values.length < POSTGRES_BIND_LIMIT,
    `${capture.variant} used ${capture.statement.values.length} binds, expected ${expectedBindCount}`
  );
  assertExactStatementValues(capture);
  requireCondition(
    capture.statement.rows === expectedRowCount &&
      capture.result.length === expectedRowCount,
    `${capture.variant} returned driver=${capture.statement.rows}, mapped=${capture.result.length}, expected=${expectedRowCount}`
  );
  assertResultShapeAndOrder(capture.result, capture.variant);
}

function assertResultShapeAndOrder(
  links: readonly SessionUsageLink[],
  variant: ParticipationVariant
): void {
  const targetIds = new Set(COMPLETE_TARGET_IDS);
  const participationCounts = new Map<string | null, number>();
  let previous = "";
  for (const link of links) {
    requireCondition(
      targetIds.has(link.targetId),
      `Unexpected target ${link.targetId}`
    );
    participationCounts.set(
      link.branchParticipation,
      (participationCounts.get(link.branchParticipation) ?? 0) + 1
    );
    requireCondition(
      link.source.session !== null,
      "Session detail was not joined"
    );
    requireCondition(
      typeof link.metadata === "object" && link.metadata !== null,
      "Link metadata was not projected"
    );
    const tuple = `${link.targetId}:${link.sourceId}`;
    requireCondition(
      tuple >= previous,
      `Result ordering regressed at ${tuple}`
    );
    previous = tuple;
  }
  const expectedReviewed =
    variant === ParticipationVariant.Reviewed
      ? REVIEWED_LINKS_PER_ORGANIZATION
      : 0;
  requireCondition(
    participationCounts.get(BranchParticipationKind.Wrote) ===
      WROTE_LINKS_PER_ORGANIZATION &&
      (participationCounts.get(null) ?? 0) === LEGACY_LINKS_PER_ORGANIZATION &&
      (participationCounts.get(BranchParticipationKind.Reviewed) ?? 0) ===
        expectedReviewed,
    `${variant} participation population changed: ${JSON.stringify(Object.fromEntries(participationCounts))}`
  );
}

async function measureControl(): Promise<MeasurementSet> {
  const result = await withDb((db) =>
    (db as unknown as RawClient).$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*)::bigint AS count FROM artifact_links WHERE organization_id = $1::uuid",
      TARGET_ORGANIZATION_ID
    )
  );
  const statement: ObservedStatement = {
    sql: "SELECT count(*)::bigint AS count FROM artifact_links WHERE organization_id = $1::uuid",
    values: [TARGET_ORGANIZATION_ID],
    rows: result.length,
  };
  return collectPlanSamples(
    "organization-control",
    statement,
    assertControlPlan,
    Number(result[0]?.count ?? 0n)
  );
}

async function collectPlanSamples(
  label: string,
  statement: ObservedStatement,
  assertShape: (sample: PlanSample) => void,
  populationRows: number = statement.rows
): Promise<MeasurementSet> {
  const structuralSample = await explain(statement);
  assertShape(structuralSample);
  const samples: PlanSample[] = [];
  if (measurementArtifactPath) {
    for (let index = 0; index < WARM_SAMPLE_COUNT; index++) {
      const sample = await explain(statement);
      assertShape(sample);
      samples.push(sample);
    }
    requireCondition(
      new Set(samples.map((sample) => sample.planShape)).size === 1,
      `${label} varied plan shape across retained samples`
    );
  }
  const timings = samples.map((sample) => sample.executionMs);
  return {
    label,
    targetCardinality:
      label === "organization-control" ? 0 : TARGETS_PER_ORGANIZATION,
    driverRows: statement.rows,
    populationRows,
    statementSha256: statementFingerprint(statement.sql),
    bindCount: statement.values.length,
    structuralSample,
    samples,
    ...(timings.length > 0
      ? {
          medianMs: requireValue(
            median(timings),
            "retained samples have no median"
          ),
          spreadMs: Math.max(...timings) - Math.min(...timings),
        }
      : {}),
  };
}

async function explain(statement: ObservedStatement): Promise<PlanSample> {
  const plan = await withDb(async (db) => {
    const rows = await (db as unknown as RawClient).$queryRawUnsafe<
      Record<string, string>[]
    >(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, ...statement.values);
    return requireNonEmptyPlan(
      rows.map((row) => Object.values(row)[0]).join("\n"),
      "ISS-10826 production statement"
    );
  });
  return planSample(plan);
}

function planSample(plan: string): PlanSample {
  const scan = requireScanNode(plan, ARTIFACT_LINKS_TABLE);
  const scanType = scan.split("\n")[0]?.trim() ?? "";
  requireCondition(
    !SEQUENTIAL_SCAN_PATTERN.test(scan),
    `artifact_links reached a sequential scan: ${scanType}`
  );
  const indexCondition = requireIndexPredicate(plan, ARTIFACT_LINKS_TABLE);
  const targetFilter = scan
    .split("\n")
    .some(
      (line) => FILTER_LINE_PATTERN.test(line) && line.includes("target_id")
    );
  const executionMatch = plan.match(EXECUTION_TIME_PATTERN);
  requireCondition(
    Boolean(executionMatch),
    `EXPLAIN exposed no execution time:\n${plan}`
  );
  return {
    executionMs: Number(executionMatch?.[1]),
    bufferLines: plan.split("\n").filter((line) => BUFFER_PATTERN.test(line)),
    indexName: chosenIndexName(plan, scanType, indexCondition),
    scanType,
    indexCondition,
    targetFilter,
    planShape: classifyPlan(indexCondition, targetFilter),
  };
}

function assertPlanShape(
  sample: PlanSample,
  variant: ParticipationVariant
): void {
  requireCondition(
    sample.planShape !== "unsupported",
    `${variant} did not use an approved organization-scoped logical shape: condition=${sample.indexCondition}; scan=${sample.scanType}; index=${sample.indexName}; targetFilter=${sample.targetFilter}`
  );
}

function assertControlPlan(sample: PlanSample): void {
  requireCondition(
    sample.indexCondition.includes("organization_id"),
    `Control exposed no organization index condition: ${sample.indexCondition}`
  );
}

function classifyPlan(indexCondition: string, targetFilter: boolean): string {
  const targetLeading =
    hasOrderedColumns(indexCondition, TARGET_INDEX_COLUMNS) &&
    sourceFollowsTargetKeys(indexCondition) &&
    !targetFilter;
  if (targetLeading) {
    return "organization-target-link-type";
  }
  return "unsupported";
}

async function writeMeasurementArtifact(input: {
  cleanupAbsence: FixtureAbsence;
  databaseName: string;
  fixtureCardinality: FixtureCardinality;
  measurements: readonly MeasurementSet[];
  phaseDurationsMs: Record<string, number>;
  postgresVersion: string;
}): Promise<void> {
  const artifactPath = requireValue(
    measurementArtifactPath,
    "measurement artifact path is unavailable"
  );
  const sourcePath = path.join(
    import.meta.dirname,
    "session-usage-link-read.ts"
  );
  const source = await readFile(sourcePath);
  const sourceRevision = readGitRevision("HEAD", true);
  const originMainRevision = readGitRevision("origin/main", false);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        schema: "ISS-10826 planner evidence v1",
        measuredAt: new Date().toISOString(),
        databaseName: input.databaseName,
        postgresVersion: input.postgresVersion,
        sourceRevision,
        originMainRevision,
        originMainRevisionCaveat:
          "This is the local tracking ref at measurement time; the execution workflow, not this test, proves fetch freshness.",
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        fixture: input.fixtureCardinality,
        fixturePopulation:
          "Complete-set exact-1,000 only; no 1,000-of-N claim.",
        fixtureLayoutCaveat: FIXTURE_LAYOUT_CAVEAT,
        constants: {
          targetCardinality: TARGETS_PER_ORGANIZATION,
          reviewedBindCount: REVIEWED_BIND_COUNT,
          writeOnlyBindCount: WRITE_ONLY_BIND_COUNT,
          postgresBindLimit: POSTGRES_BIND_LIMIT,
        },
        productStages: {
          reviewed: "Branch identity and provenance hydration",
          writeOnly: "Branch full-corpus usage and cost hydration",
        },
        databaseMonitoring:
          "The integration process has no DBM client. The execution result must record the exact DBM query/window/values or the precise access/signature/truncation gap.",
        phaseDurationsMs: input.phaseDurationsMs,
        measurements: input.measurements,
        cleanup: {
          fixtureAbsence: input.cleanupAbsence,
          fixturePurged: true,
          plannerTablesCompacted: true,
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  await chmod(artifactPath, 0o600);
}

function readGitRevision(ref: string, required: true): string;
function readGitRevision(ref: string, required: false): string | null;
function readGitRevision(ref: string, required: boolean): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }).trim();
  } catch (error) {
    if (required) {
      throw error;
    }
    return null;
  }
}

function assertExactStatementValues(capture: ProductionCapture): void {
  const expected = [
    TARGET_ORGANIZATION_ID,
    ArtifactType.SESSION,
    TARGET_ORGANIZATION_ID,
    ArtifactType.BRANCH,
    TARGET_ORGANIZATION_ID,
    ...COMPLETE_TARGET_IDS,
    LinkType.RelatesTo,
    SessionArtifactLinkKind.SessionPr,
    SessionArtifactLinkKind.SessionBranch,
    SessionArtifactLinkKind.SessionPrSet,
    BranchParticipationKind.Wrote,
    ...(capture.variant === ParticipationVariant.Reviewed
      ? [BranchParticipationKind.Reviewed]
      : []),
  ];
  requireCondition(
    expected.length === capture.statement.values.length,
    `${capture.variant} expected ${expected.length} positional binds, captured ${capture.statement.values.length}`
  );
  for (const [index, value] of expected.entries()) {
    requireCondition(
      Object.is(capture.statement.values[index], value),
      `${capture.variant} positional bind ${index + 1} changed`
    );
  }
}

async function recordPhase<T>(
  durations: Record<string, number>,
  label: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    durations[label] = performance.now() - startedAt;
  }
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
    } else if (typeof value === "string") {
      uuids.push(
        ...(value.match(UUID_PATTERN) ?? []).map((uuid) => uuid.toLowerCase())
      );
    }
  }
  return uuids;
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

function absoluteMeasurementArtifactPath(
  value: string | undefined
): string | null {
  if (!value) {
    return null;
  }
  requireCondition(
    path.isAbsolute(value),
    "ISS10826_MEASUREMENT_ARTIFACT must be an absolute private path"
  );
  return value;
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
