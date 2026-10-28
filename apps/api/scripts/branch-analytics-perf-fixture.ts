/**
 * Seed and benchmark a local Branch analytics corpus.
 *
 * Usage from the repo root after starting and migrating the local database:
 *   just db-start
 *   just db-migrate
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/closedloop_ai \
 *   pnpm -C apps/api exec tsx --conditions=react-server \
 *     scripts/branch-analytics-perf-fixture.ts --branches 1500 --iterations 6
 *
 * The fixture owns one synthetic organization slug and deletes only rows under
 * that organization before reseeding.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  LinkType,
  Priority,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { selectBranchServerRows } from "@repo/lib/branches/branch-list-page";
import { apiKeysService } from "@/app/api-keys/service";
import { getBranchCandidateSnapshots } from "@/app/branches/branch-candidate-read";
import { projectBranchListRows } from "@/app/branches/branch-list-projection";
import type { BranchListOperationQuery } from "@/app/branches/branch-list-query";
import {
  getBranchAnalyticsRows,
  getBranchRowsById,
} from "@/app/branches/branch-read-service/persisted-row-read";
import { getBranchServerAnalyticsRows } from "@/app/branches/branch-server-analytics-cohort";
import { toBranchServerPageQuery } from "@/app/branches/branch-server-page-query";
import {
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
  BRANCH_ANALYTICS_PERF_FIXTURE_SLUG,
  checkBranchAnalyticsPerfDatabaseUrl,
  checkBranchAnalyticsPerfFixtureOrganization,
} from "./branch-analytics-perf-fixture-guards";

const FIXTURE_SLUG = BRANCH_ANALYTICS_PERF_FIXTURE_SLUG;
const REPOSITORY_FULL_NAME = "closedloop-ai/branch-analytics-perf-fixture";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const DEFAULT_BRANCH_COUNT = 1500;
const DEFAULT_SESSIONS_PER_BRANCH = 2;
const DEFAULT_EVENTS_PER_SESSION = 12;
const DEFAULT_SEGMENTS_PER_SESSION = 4;
const DEFAULT_FILE_CHANGES_PER_BRANCH = 8;
const CHUNK_SIZE = 1000;
const PERF_API_KEY_NAME = "Branch analytics perf fixture";

type FixtureOptions = {
  branches: number;
  sessionsPerBranch: number;
  eventsPerSession: number;
  segmentsPerSession: number;
  fileChangesPerBranch: number;
  iterations: number;
};

type SeededIdentity = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

type FixtureCredentials = {
  apiBearer: string;
  organizationId: string;
  userId: string;
};

type BenchResult = {
  label: string;
  samplesMs: number[];
  detail: string;
};

async function main() {
  await runBranchAnalyticsPerfFixtureScript();
}

/** Run the fixture CLI behind injectable process boundaries for guard tests. */
export async function runBranchAnalyticsPerfFixtureScript({
  argv = process.argv.slice(2),
  env = process.env,
  runWithDb = runWithProductionDb,
  logger = console,
}: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  runWithDb?: (fn: (db: unknown) => Promise<void> | void) => Promise<void>;
  logger?: Pick<typeof console, "log">;
} = {}) {
  const args = parseArgs({
    args: [...argv],
    options: {
      seed: { type: "boolean", default: false },
      bench: { type: "boolean", default: false },
      cleanup: { type: "boolean", default: false },
      "credentials-out": { type: "string" },
      branches: { type: "string", default: String(DEFAULT_BRANCH_COUNT) },
      "sessions-per-branch": {
        type: "string",
        default: String(DEFAULT_SESSIONS_PER_BRANCH),
      },
      "events-per-session": {
        type: "string",
        default: String(DEFAULT_EVENTS_PER_SESSION),
      },
      "segments-per-session": {
        type: "string",
        default: String(DEFAULT_SEGMENTS_PER_SESSION),
      },
      "file-changes-per-branch": {
        type: "string",
        default: String(DEFAULT_FILE_CHANGES_PER_BRANCH),
      },
      iterations: { type: "string", default: "6" },
    },
  });
  const options = parseFixtureOptions(args.values);
  const shouldSeed =
    args.values.seed || !(args.values.bench || args.values.cleanup);
  const shouldBench =
    args.values.bench || !(args.values.seed || args.values.cleanup);

  const databaseGuard = checkBranchAnalyticsPerfDatabaseUrl(env.DATABASE_URL);
  if (!databaseGuard.ok) {
    throw new Error(databaseGuard.error.message);
  }

  await runWithDb(async (db) => {
    const client = db as TransactionClient;
    let seededIdentity: SeededIdentity | null = null;
    if (args.values.cleanup || shouldSeed) {
      await cleanupFixture(client);
    }
    if (shouldSeed) {
      seededIdentity = await seedFixture(client, options);
    }
    if (args.values["credentials-out"]) {
      const identity =
        seededIdentity ?? (await readFixtureIdentityForCredentials(client));
      const credentialsPath = await writeCredentialsFile(
        args.values["credentials-out"],
        await mintFixtureApiBearer(identity)
      );
      logger.log(
        `[branch-analytics-perf] wrote ${credentialsPath} (mode 0600). Contents are secret - do not echo.`
      );
    }
    if (shouldBench) {
      await benchmarkFixture(client, options, logger);
    }
    if (args.values.cleanup && !shouldSeed) {
      logger.log("[branch-analytics-perf] cleanup complete");
    }
  });
}

function parseFixtureOptions(
  values: ReturnType<typeof parseArgs>["values"]
): FixtureOptions {
  return {
    branches: positiveInteger(values.branches, "branches"),
    sessionsPerBranch: positiveInteger(
      values["sessions-per-branch"],
      "sessions-per-branch"
    ),
    eventsPerSession: positiveInteger(
      values["events-per-session"],
      "events-per-session"
    ),
    segmentsPerSession: positiveInteger(
      values["segments-per-session"],
      "segments-per-session"
    ),
    fileChangesPerBranch: positiveInteger(
      values["file-changes-per-branch"],
      "file-changes-per-branch"
    ),
    iterations: positiveInteger(values.iterations, "iterations"),
  };
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function cleanupFixture(db: TransactionClient) {
  const organization = await db.organization.findUnique({
    where: { slug: FIXTURE_SLUG },
    select: { clerkId: true, id: true, name: true },
  });
  if (!organization) {
    return;
  }
  const organizationGuard =
    checkBranchAnalyticsPerfFixtureOrganization(organization);
  if (!organizationGuard.ok) {
    throw new Error(organizationGuard.error.message);
  }
  const artifacts = await db.artifact.findMany({
    where: { organizationId: organization.id },
    select: { id: true, type: true },
  });
  const branchIds = artifacts
    .filter((artifact) => artifact.type === ArtifactType.BRANCH)
    .map((artifact) => artifact.id);
  const sessionIds = artifacts
    .filter((artifact) => artifact.type === ArtifactType.SESSION)
    .map((artifact) => artifact.id);
  await deleteManyForIdChunks(branchIds, (ids) =>
    db.branchFileChange.deleteMany({
      where: { branchArtifactId: { in: ids } },
    })
  );
  await db.branchActivityAtom.deleteMany({
    where: { organizationId: organization.id },
  });
  await deleteManyForIdChunks(sessionIds, (ids) =>
    db.agentSessionActivitySegment.deleteMany({
      where: { agentSessionId: { in: ids } },
    })
  );
  await deleteManyForIdChunks(sessionIds, (ids) =>
    db.agentSessionTokenEvent.deleteMany({
      where: { agentSessionId: { in: ids } },
    })
  );
  await db.artifactLink.deleteMany({
    where: { organizationId: organization.id },
  });
  await deleteManyForIdChunks(sessionIds, (ids) =>
    db.sessionDetail.deleteMany({
      where: { artifactId: { in: ids } },
    })
  );
  await deleteManyForIdChunks(branchIds, (ids) =>
    db.branchDetail.deleteMany({
      where: { artifactId: { in: ids } },
    })
  );
  await db.artifact.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.apiKey.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.publicRepository.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.project.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.computeTarget.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.user.deleteMany({
    where: { organizationId: organization.id },
  });
  await db.organization.delete({ where: { id: organization.id } });
}

async function seedFixture(
  db: TransactionClient,
  options: FixtureOptions
): Promise<SeededIdentity> {
  const organization = await db.organization.create({
    data: {
      clerkId: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
      name: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
      slug: FIXTURE_SLUG,
    },
    select: { id: true },
  });
  const user = await db.user.create({
    data: {
      clerkId: `user_${FIXTURE_SLUG}`,
      organizationId: organization.id,
      email: `${FIXTURE_SLUG}@example.test`,
      firstName: "Perf",
      lastName: "Fixture",
    },
    select: { id: true },
  });
  const project = await db.project.create({
    data: {
      organizationId: organization.id,
      createdById: user.id,
      name: "Branch analytics perf fixture",
      slug: FIXTURE_SLUG,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      machineName: FIXTURE_SLUG,
      platform: "darwin",
      isOnline: true,
    },
    select: { id: true },
  });
  await db.publicRepository.create({
    data: {
      organizationId: organization.id,
      githubRepoId: "branch-analytics-perf-fixture",
      fullName: REPOSITORY_FULL_NAME,
      owner: "closedloop-ai",
      name: "branch-analytics-perf-fixture",
      htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
      defaultBranchName: "main",
      defaultBranchAvailability: RepositoryDefaultAvailability.Available,
      defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
      defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
      defaultBranchMechanism: GitHubFetchMechanism.Rest,
      defaultBranchTrigger: GitHubFetchTrigger.Backfill,
      defaultBranchCredentialType: GitHubFetchCredentialType.Unauthenticated,
      defaultBranchObservationKey: FIXTURE_SLUG,
      defaultBranchObservedAt: NOW,
      defaultBranchEventAt: NOW,
    },
    select: { id: true },
  });

  const branchArtifacts: Prisma.ArtifactCreateManyInput[] = [];
  const sessionArtifacts: Prisma.ArtifactCreateManyInput[] = [];
  const branchDetails: Prisma.BranchDetailCreateManyInput[] = [];
  const sessionDetails: Prisma.SessionDetailCreateManyInput[] = [];
  const links: Prisma.ArtifactLinkCreateManyInput[] = [];
  const atoms: Prisma.BranchActivityAtomCreateManyInput[] = [];
  const tokenEvents: Prisma.AgentSessionTokenEventCreateManyInput[] = [];
  const segments: Prisma.AgentSessionActivitySegmentCreateManyInput[] = [];
  const fileChanges: Prisma.BranchFileChangeCreateManyInput[] = [];

  for (let branchIndex = 0; branchIndex < options.branches; branchIndex += 1) {
    const branchId = randomUUID();
    const activityAt = new Date(NOW.getTime() - branchIndex * 60_000);
    branchArtifacts.push({
      id: branchId,
      organizationId: organization.id,
      projectId: project.id,
      type: ArtifactType.BRANCH,
      name: `perf/branch-${branchIndex}`,
      slug: `${FIXTURE_SLUG}-branch-${branchIndex}`,
      status: branchStatusFor(branchIndex),
      priority: Priority.MEDIUM,
      createdById: user.id,
      createdAt: activityAt,
      updatedAt: activityAt,
    });
    branchDetails.push({
      artifactId: branchId,
      organizationId: organization.id,
      repositoryFullName: REPOSITORY_FULL_NAME,
      branchName: `perf/branch-${branchIndex}`,
      headSha: shaFor(branchIndex),
      headShaSource: "explicit_sync",
      headShaObservedAt: activityAt,
      lastActivityAt: activityAt,
      firstPushedAt: activityAt,
      pushSource: BranchPushSource.Session,
      fileCacheStatus: "fresh",
      fileCacheHeadSha: shaFor(branchIndex),
      fileCacheFileCount: options.fileChangesPerBranch,
      fileCachePatchBytes: options.fileChangesPerBranch * 80,
      fileCacheUpdatedAt: activityAt,
    });
    atoms.push({
      version: BranchActivityAtomVersion.V1,
      organizationId: organization.id,
      branchArtifactId: branchId,
      source: BranchActivitySource.GitHead,
      sourceEventId: `perf-activity-${branchIndex}`,
      occurredAt: activityAt,
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.Branch,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: activityAt,
    });
    for (
      let fileIndex = 0;
      fileIndex < options.fileChangesPerBranch;
      fileIndex += 1
    ) {
      fileChanges.push({
        branchArtifactId: branchId,
        headSha: shaFor(branchIndex),
        path: `src/perf-${branchIndex}-${fileIndex}.ts`,
        status: "modified",
        additions: 8 + (fileIndex % 5),
        deletions: 2 + (fileIndex % 3),
        changes: 10 + (fileIndex % 7),
        patchBytes: 80,
      });
    }
    for (
      let sessionIndex = 0;
      sessionIndex < options.sessionsPerBranch;
      sessionIndex += 1
    ) {
      const sessionId = randomUUID();
      const sessionStartedAt = new Date(activityAt.getTime() - 30 * 60_000);
      const sessionCost = options.eventsPerSession * 0.01;
      sessionArtifacts.push({
        id: sessionId,
        organizationId: organization.id,
        projectId: null,
        type: ArtifactType.SESSION,
        name: `Perf session ${branchIndex}-${sessionIndex}`,
        slug: `${FIXTURE_SLUG}-session-${branchIndex}-${sessionIndex}`,
        status: "inactive",
        priority: Priority.MEDIUM,
        createdById: user.id,
        createdAt: sessionStartedAt,
        updatedAt: activityAt,
      });
      sessionDetails.push({
        artifactId: sessionId,
        computeTargetId: computeTarget.id,
        externalSessionId: `${FIXTURE_SLUG}-${branchIndex}-${sessionIndex}`,
        harness: "codex",
        billingMode: "api",
        repositoryFullName: REPOSITORY_FULL_NAME,
        sessionStartedAt,
        sessionUpdatedAt: activityAt,
        lastActivityAt: activityAt,
        sessionEndedAt: activityAt,
        inputTokens: BigInt(options.eventsPerSession * 100),
        outputTokens: BigInt(options.eventsPerSession * 25),
        cacheReadTokens: BigInt(options.eventsPerSession * 10),
        cacheWriteTokens: BigInt(options.eventsPerSession * 5),
        estimatedCost: sessionCost,
        agentCount: 1,
        toolUseCount: options.eventsPerSession,
        metadata: {},
      });
      links.push({
        organizationId: organization.id,
        sourceId: sessionId,
        targetId: branchId,
        linkType: LinkType.RELATES_TO,
        branchParticipation: BranchParticipationKind.Wrote,
        branchParticipationMethod: "perf_fixture",
        branchParticipationObservedAt: activityAt,
        metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
      });
      for (
        let eventIndex = 0;
        eventIndex < options.eventsPerSession;
        eventIndex += 1
      ) {
        tokenEvents.push({
          agentSessionId: sessionId,
          externalEventId: `event-${eventIndex}`,
          model: "gpt-5-codex",
          inputTokens: 100n,
          outputTokens: 25n,
          cacheReadTokens: 10n,
          cacheWriteTokens: 5n,
          estimatedCost: 0.01,
          sourceIdentity: {
            availability: "available",
            scheme: "perf-fixture",
            sourceRecordIds: [`${branchIndex}-${sessionIndex}-${eventIndex}`],
          },
          costCompleteness: "complete",
          subscriptionEquivalentCost: 0,
          apiEstimatedCost: 0.01,
          eventCreatedAt: new Date(
            sessionStartedAt.getTime() + eventIndex * 60_000
          ),
        });
      }
      for (
        let segmentIndex = 0;
        segmentIndex < options.segmentsPerSession;
        segmentIndex += 1
      ) {
        const startMs = BigInt(
          sessionStartedAt.getTime() + segmentIndex * 60_000
        );
        segments.push({
          agentSessionId: sessionId,
          phase: segmentIndex % 2 === 0 ? "implement" : "verify",
          startMs,
          endMs: startMs + 45_000n,
          confidence: 0.92,
          evidenceLayers: ["declared"],
          classifierVersion: 1,
          workItemRef: `ISS-PERF-${branchIndex}`,
        });
      }
    }
  }

  await createManyInChunks(branchArtifacts, (data) =>
    db.artifact.createMany({ data })
  );
  await createManyInChunks(sessionArtifacts, (data) =>
    db.artifact.createMany({ data })
  );
  await createManyInChunks(branchDetails, (data) =>
    db.branchDetail.createMany({ data })
  );
  await createManyInChunks(sessionDetails, (data) =>
    db.sessionDetail.createMany({ data })
  );
  await createManyInChunks(links, (data) =>
    db.artifactLink.createMany({ data })
  );
  await createManyInChunks(atoms, (data) =>
    db.branchActivityAtom.createMany({ data })
  );
  await createManyInChunks(tokenEvents, (data) =>
    db.agentSessionTokenEvent.createMany({ data })
  );
  await createManyInChunks(segments, (data) =>
    db.agentSessionActivitySegment.createMany({ data })
  );
  await createManyInChunks(fileChanges, (data) =>
    db.branchFileChange.createMany({ data })
  );

  console.log(
    `[branch-analytics-perf] seeded org=${organization.id} branches=${options.branches} sessions=${sessionArtifacts.length} events=${tokenEvents.length} segments=${segments.length}`
  );
  return {
    organizationId: organization.id,
    userId: user.id,
    computeTargetId: computeTarget.id,
  };
}

async function readFixtureIdentityForCredentials(
  db: TransactionClient
): Promise<Pick<SeededIdentity, "organizationId" | "userId">> {
  const organization = await db.organization.findUniqueOrThrow({
    where: { slug: FIXTURE_SLUG },
    select: { id: true },
  });
  const user = await db.user.findFirstOrThrow({
    where: { organizationId: organization.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return { organizationId: organization.id, userId: user.id };
}

async function mintFixtureApiBearer(
  identity: Pick<SeededIdentity, "organizationId" | "userId">
): Promise<FixtureCredentials> {
  const apiKey = await apiKeysService.generate(
    identity.organizationId,
    identity.userId,
    { name: PERF_API_KEY_NAME }
  );
  return {
    apiBearer: apiKey.plaintext,
    organizationId: identity.organizationId,
    userId: identity.userId,
  };
}

async function writeCredentialsFile(
  path: string,
  credentials: FixtureCredentials
): Promise<string> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(resolved, 0o600);
  return resolved;
}

async function createManyInChunks<Row>(
  rows: Row[],
  createMany: (data: Row[]) => Promise<unknown>
) {
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    await createMany(rows.slice(start, start + CHUNK_SIZE));
  }
}

async function deleteManyForIdChunks(
  ids: string[],
  deleteMany: (ids: string[]) => Promise<unknown>
) {
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    await deleteMany(ids.slice(start, start + CHUNK_SIZE));
  }
}

async function benchmarkFixture(
  db: TransactionClient,
  options: FixtureOptions,
  logger: Pick<typeof console, "log">
) {
  const organization = await db.organization.findUniqueOrThrow({
    where: { slug: FIXTURE_SLUG },
    select: { id: true },
  });
  const query: BranchListOperationQuery = {
    pageMode: BranchListPageMode.Server,
    limit: 20,
    offset: 0,
    startDate: new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000),
    evaluationNow: NOW,
  };
  await oldProjectedServerAnalyticsRows(db, organization.id, query, NOW);
  await getBranchServerAnalyticsRows(
    db,
    organization.id,
    query,
    NOW.toISOString()
  );

  const projected = await measure(
    "projected server analytics rows",
    options.iterations,
    () => oldProjectedServerAnalyticsRows(db, organization.id, query, NOW),
    (rows) => rows.length
  );
  const direct = await measure(
    "direct server analytics rows",
    options.iterations,
    () =>
      getBranchServerAnalyticsRows(
        db,
        organization.id,
        query,
        NOW.toISOString()
      ),
    (rows) => rows.length
  );
  for (const result of [projected, direct]) {
    logger.log(
      `[branch-analytics-perf] ${result.label}: ${result.detail} avg=${average(
        result.samplesMs
      ).toFixed(1)}ms p50=${percentile(result.samplesMs, 0.5).toFixed(
        1
      )}ms samples=${result.samplesMs.map((sample) => sample.toFixed(1)).join(",")}`
    );
  }
}

async function oldProjectedServerAnalyticsRows(
  db: TransactionClient,
  organizationId: string,
  query: BranchListOperationQuery,
  now: Date
) {
  const candidates = await getBranchCandidateSnapshots(
    db,
    organizationId,
    query
  );
  const rows = await getBranchRowsById(
    db,
    organizationId,
    candidates.map((candidate) => candidate.id),
    candidates
  );
  const projected = await projectBranchListRows(
    db,
    organizationId,
    rows,
    query,
    undefined,
    { includeAttributedCost: false }
  );
  const selected = selectBranchServerRows(
    projected.items,
    toBranchServerPageQuery(query),
    now.toISOString()
  );
  return getBranchAnalyticsRows(
    db,
    organizationId,
    selected.map((row) => row.id),
    candidates
  );
}

async function measure<Row>(
  label: string,
  iterations: number,
  callback: () => Promise<Row>,
  rowCountFor: (result: Row) => number
): Promise<BenchResult> {
  const samplesMs: number[] = [];
  let detail = "";
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    const result = await callback();
    samplesMs.push(performance.now() - start);
    detail = `rows=${rowCountFor(result)}`;
  }
  return { label, samplesMs, detail };
}

function branchStatusFor(index: number): BranchStatus {
  if (index % 9 === 0) {
    return BranchStatus.Merged;
  }
  if (index % 7 === 0) {
    return BranchStatus.Review;
  }
  return BranchStatus.Open;
}

function shaFor(index: number): string {
  return index.toString(16).padStart(40, "0").slice(0, 40);
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)] ?? 0;
}

function runWithProductionDb(
  fn: (db: unknown) => Promise<void> | void
): Promise<void> {
  return withDb((db) => fn(db));
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(realpathSync(resolve(process.argv[1]))).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[branch-analytics-perf] failed:", error);
    process.exitCode = 1;
  });
}
