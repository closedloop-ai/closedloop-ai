/**
 * Seed a small local-trusted Branches corpus into the web/API Postgres database.
 *
 * Usage from the repo root after starting/migrating the target Docker database:
 *   pnpm -C apps/api seed:branches-web -- --database-name symphony
 *   pnpm -C apps/api seed:branches-web -- \
 *     --database-url postgresql://postgres:postgres@localhost:5432/symphony
 *
 * The target is intentionally explicit. Ambient DATABASE_URL supplies only the
 * connection base for --database-name so concurrent worktrees cannot silently
 * seed the wrong local database.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import {
  ArtifactType,
  LinkType,
  Priority,
  type Prisma,
  ProjectStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { config as dotenvConfig } from "dotenv";
import { resolveBranchesWebSeedDatabaseTarget } from "./seed-branches-web-db-guards";

export const BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX = "branches-web-vqa-seed";

const DEFAULT_BRANCH_COUNT = 12;
const DEFAULT_UNAVAILABLE_BRANCH_COUNT = 2;
const CHUNK_SIZE = 500;
const REPOSITORY_FULL_NAME = "closedloop-ai/branches-web-vqa";
const REPOSITORY_GITHUB_ID = "branches-web-vqa";
const PROJECT_SLUG = "branches-web-vqa";
const PROJECT_NAME = "Branches Web VQA";
const COMPUTE_TARGET_MACHINE_NAME = "branches-web-vqa-local";
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export type SeedRepositoryAuthority = {
  owner: string;
  name: string;
  githubRepoId: string;
  defaultBranchName: string;
  observationKey: string;
};

const BRANCHES_WEB_SEED_REPOSITORY: SeedRepositoryAuthority = {
  owner: "closedloop-ai",
  name: "branches-web-vqa",
  githubRepoId: REPOSITORY_GITHUB_ID,
  defaultBranchName: "main",
  observationKey: BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX,
};

type BranchesWebSeedOptions = {
  branches: number;
  unavailableBranches: number;
};

type BranchesWebSeedIdentity = {
  organizationId: string;
  userId: string;
  projectId: string;
  computeTargetId: string;
};

type BranchesWebSeedSummary = {
  removedArtifacts: number;
  seededBranches: number;
  unavailableBranches: number;
  databaseName: string;
};

async function main() {
  await runBranchesWebSeedScript();
}

export async function runBranchesWebSeedScript({
  argv = process.argv.slice(2),
  env = process.env,
  runWithDb = runWithProductionDb,
  logger = console,
  loadEnv = true,
}: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  runWithDb?: (fn: (db: unknown) => Promise<void> | void) => Promise<void>;
  logger?: Pick<typeof console, "log">;
  loadEnv?: boolean;
} = {}): Promise<BranchesWebSeedSummary> {
  if (loadEnv) {
    loadApiLocalEnv();
  }
  const args = parseArgs({
    args: normalizeCliArgs(argv),
    options: {
      cleanup: { type: "boolean", default: false },
      branches: { type: "string", default: String(DEFAULT_BRANCH_COUNT) },
      "unavailable-branches": {
        type: "string",
        default: String(DEFAULT_UNAVAILABLE_BRANCH_COUNT),
      },
      "database-name": { type: "string" },
      "database-url": { type: "string" },
    },
  });
  const target = resolveBranchesWebSeedDatabaseTarget({
    explicitDatabaseName: args.values["database-name"],
    explicitDatabaseUrl: args.values["database-url"],
    baseDatabaseUrl: env.DATABASE_URL,
  });
  if (!target.ok) {
    throw new Error(target.error.message);
  }
  const options = parseSeedOptions(args.values);

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = target.target.databaseUrl;
  const result: { summary?: BranchesWebSeedSummary } = {};
  try {
    await runWithDb(async (db) => {
      const client = db as TransactionClient;
      const removedArtifacts = await cleanupBranchesWebSeed(client);
      let seededBranches = 0;
      if (!args.values.cleanup) {
        const identity = await ensureBranchesWebSeedIdentity(client);
        await ensureRepositoryAuthority(client, identity.organizationId);
        seededBranches = await seedBranchesWebRows(client, identity, options);
      }
      result.summary = {
        databaseName: target.target.databaseName,
        removedArtifacts,
        seededBranches,
        unavailableBranches: args.values.cleanup
          ? 0
          : options.unavailableBranches,
      };
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, "DATABASE_URL");
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  const summary = result.summary;
  if (!summary) {
    throw new Error("Branches web seed did not complete.");
  }
  logger.log(
    `[branches-web-seed] target=${target.target.label} removed_artifacts=${summary.removedArtifacts} seeded_branches=${summary.seededBranches} unavailable_branches=${summary.unavailableBranches}`
  );
  return summary;
}

function parseSeedOptions(
  values: ReturnType<typeof parseArgs>["values"]
): BranchesWebSeedOptions {
  const branches = positiveInteger(values.branches, "branches");
  const unavailableBranches = nonNegativeInteger(
    values["unavailable-branches"],
    "unavailable-branches"
  );
  if (unavailableBranches > branches) {
    throw new Error(
      "unavailable-branches must be less than or equal to branches"
    );
  }
  return { branches, unavailableBranches };
}

function normalizeCliArgs(argv: readonly string[]): string[] {
  return argv[0] === "--" ? [...argv.slice(1)] : [...argv];
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed >= 0)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function cleanupBranchesWebSeed(db: TransactionClient): Promise<number> {
  const organization = await readLocalTrustedOrganization(db);
  if (!organization) {
    return 0;
  }
  const artifacts = await db.artifact.findMany({
    where: {
      organizationId: organization.id,
      slug: { startsWith: `${BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX}-` },
    },
    select: { id: true, type: true },
  });
  const artifactIds = artifacts.map((artifact) => artifact.id);
  if (artifactIds.length === 0) {
    return 0;
  }
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
  await deleteManyForIdChunks(branchIds, (ids) =>
    db.branchActivityAtom.deleteMany({
      where: { organizationId: organization.id, branchArtifactId: { in: ids } },
    })
  );
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
  await deleteManyForIdChunks(artifactIds, (ids) =>
    db.artifactLink.deleteMany({
      where: {
        organizationId: organization.id,
        OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }],
      },
    })
  );
  await deleteManyForIdChunks(sessionIds, (ids) =>
    db.sessionDetail.deleteMany({
      where: { artifactId: { in: ids } },
    })
  );
  await deleteManyForIdChunks(branchIds, (ids) =>
    db.branchDetail.deleteMany({
      where: { organizationId: organization.id, artifactId: { in: ids } },
    })
  );
  await deleteManyForIdChunks(artifactIds, (ids) =>
    db.artifact.deleteMany({
      where: { organizationId: organization.id, id: { in: ids } },
    })
  );
  return artifactIds.length;
}

async function ensureBranchesWebSeedIdentity(
  db: TransactionClient
): Promise<BranchesWebSeedIdentity> {
  const organization = await ensureLocalTrustedOrganization(db);
  const user = await ensureLocalTrustedUser(db, organization.id);
  const project = await db.project.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: PROJECT_SLUG,
      },
    },
    create: {
      organizationId: organization.id,
      createdById: user.id,
      name: PROJECT_NAME,
      slug: PROJECT_SLUG,
      status: ProjectStatus.IN_PROGRESS,
      priority: Priority.MEDIUM,
    },
    update: {
      name: PROJECT_NAME,
      status: ProjectStatus.IN_PROGRESS,
      priority: Priority.MEDIUM,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.upsert({
    where: {
      userId_machineName: {
        userId: user.id,
        machineName: COMPUTE_TARGET_MACHINE_NAME,
      },
    },
    create: {
      organizationId: organization.id,
      userId: user.id,
      machineName: COMPUTE_TARGET_MACHINE_NAME,
      platform: "darwin",
      isOnline: true,
      selectedHarness: "codex",
    },
    update: {
      isOnline: true,
      selectedHarness: "codex",
    },
    select: { id: true },
  });
  return {
    organizationId: organization.id,
    userId: user.id,
    projectId: project.id,
    computeTargetId: computeTarget.id,
  };
}

async function ensureLocalTrustedOrganization(db: TransactionClient) {
  const byClerkId = await db.organization.findUnique({
    where: { clerkId: LOCAL_TRUSTED_ORG_ID },
    select: { id: true },
  });
  const bySlug = await db.organization.findUnique({
    where: { slug: LOCAL_TRUSTED_ORG_SLUG },
    select: { id: true },
  });
  if (byClerkId && bySlug && byClerkId.id !== bySlug.id) {
    throw new Error(
      `Local trusted org id and slug resolve to different organizations; refusing to seed '${LOCAL_TRUSTED_ORG_SLUG}'.`
    );
  }
  const existing = byClerkId ?? bySlug;
  if (existing) {
    return db.organization.update({
      where: { id: existing.id },
      data: {
        active: true,
        clerkId: LOCAL_TRUSTED_ORG_ID,
        name: "Closedloop AI",
        slug: LOCAL_TRUSTED_ORG_SLUG,
      },
      select: { id: true },
    });
  }
  return db.organization.create({
    data: {
      clerkId: LOCAL_TRUSTED_ORG_ID,
      name: "Closedloop AI",
      slug: LOCAL_TRUSTED_ORG_SLUG,
    },
    select: { id: true },
  });
}

async function ensureLocalTrustedUser(
  db: TransactionClient,
  organizationId: string
) {
  const existing = await db.user.findFirst({
    where: {
      organizationId,
      OR: [
        { clerkId: LOCAL_TRUSTED_USER_ID },
        { email: LOCAL_TRUSTED_USER_EMAIL },
      ],
    },
    select: { id: true },
  });
  if (existing) {
    return db.user.update({
      where: { id: existing.id },
      data: {
        active: true,
        clerkId: LOCAL_TRUSTED_USER_ID,
        email: LOCAL_TRUSTED_USER_EMAIL,
        firstName: "Local",
        lastName: "Trusted",
      },
      select: { id: true },
    });
  }
  return db.user.create({
    data: {
      clerkId: LOCAL_TRUSTED_USER_ID,
      organizationId,
      email: LOCAL_TRUSTED_USER_EMAIL,
      firstName: "Local",
      lastName: "Trusted",
    },
    select: { id: true },
  });
}

function readLocalTrustedOrganization(db: TransactionClient) {
  return db.organization.findUnique({
    where: { clerkId: LOCAL_TRUSTED_ORG_ID },
    select: { id: true },
  });
}

/**
 * Upserts the `PublicRepository` row that gives an org default-branch authority
 * for one repository without a GitHub lookup. The ISS-12017 vibe seed reuses it
 * for the repositories its golden sessions worked in.
 */
export async function ensureRepositoryAuthority(
  db: TransactionClient,
  organizationId: string,
  repository: SeedRepositoryAuthority = BRANCHES_WEB_SEED_REPOSITORY,
  now: Date = new Date()
) {
  const identity = {
    fullName: `${repository.owner}/${repository.name}`,
    owner: repository.owner,
    name: repository.name,
    htmlUrl: `https://github.com/${repository.owner}/${repository.name}`,
    defaultBranchName: repository.defaultBranchName,
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.Backfill,
    defaultBranchCredentialType: GitHubFetchCredentialType.Unauthenticated,
    defaultBranchObservationKey: repository.observationKey,
    defaultBranchObservedAt: now,
    defaultBranchEventAt: now,
  };
  await db.publicRepository.upsert({
    where: {
      organizationId_githubRepoId: {
        organizationId,
        githubRepoId: repository.githubRepoId,
      },
    },
    create: {
      organizationId,
      githubRepoId: repository.githubRepoId,
      ...identity,
    },
    update: { ...identity, defaultBranchReason: null },
    select: { id: true },
  });
}

async function seedBranchesWebRows(
  db: TransactionClient,
  identity: BranchesWebSeedIdentity,
  options: BranchesWebSeedOptions
): Promise<number> {
  const now = new Date();
  const rows = buildBranchesWebSeedRows(identity, options, now);
  await createManyInChunks(rows.branchArtifacts, (data) =>
    db.artifact.createMany({ data })
  );
  await createManyInChunks(rows.sessionArtifacts, (data) =>
    db.artifact.createMany({ data })
  );
  await createManyInChunks(rows.branchDetails, (data) =>
    db.branchDetail.createMany({ data })
  );
  await createManyInChunks(rows.sessionDetails, (data) =>
    db.sessionDetail.createMany({ data })
  );
  await createManyInChunks(rows.links, (data) =>
    db.artifactLink.createMany({ data })
  );
  await createManyInChunks(rows.activityAtoms, (data) =>
    db.branchActivityAtom.createMany({ data })
  );
  return rows.branchArtifacts.length;
}

function buildBranchesWebSeedRows(
  identity: BranchesWebSeedIdentity,
  options: BranchesWebSeedOptions,
  now: Date
) {
  const branchArtifacts: Prisma.ArtifactCreateManyInput[] = [];
  const sessionArtifacts: Prisma.ArtifactCreateManyInput[] = [];
  const branchDetails: Prisma.BranchDetailCreateManyInput[] = [];
  const sessionDetails: Prisma.SessionDetailCreateManyInput[] = [];
  const links: Prisma.ArtifactLinkCreateManyInput[] = [];
  const activityAtoms: Prisma.BranchActivityAtomCreateManyInput[] = [];
  const availableBranches = options.branches - options.unavailableBranches;

  for (let index = 0; index < options.branches; index += 1) {
    const branchId = randomUUID();
    const sessionId = randomUUID();
    const branchNumber = index + 1;
    const isUnavailableActivity = index >= availableBranches;
    const activityAt = isUnavailableActivity
      ? new Date(now.getTime() + branchNumber * MILLISECONDS_PER_HOUR)
      : new Date(now.getTime() - branchNumber * MILLISECONDS_PER_HOUR);
    const firstPushedAt = new Date(
      now.getTime() - (branchNumber + 1) * MILLISECONDS_PER_DAY
    );
    const sessionStartedAt = new Date(
      firstPushedAt.getTime() - 2 * MILLISECONDS_PER_HOUR
    );
    const sessionEndedAt = new Date(
      sessionStartedAt.getTime() + MILLISECONDS_PER_HOUR
    );
    const branchName = `feature/iss-8018-web-vqa-${String(branchNumber).padStart(2, "0")}`;
    const headSha = shaFor(branchNumber);
    branchArtifacts.push({
      id: branchId,
      organizationId: identity.organizationId,
      projectId: identity.projectId,
      type: ArtifactType.BRANCH,
      name: branchName,
      slug: `${BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX}-branch-${branchNumber}`,
      status: BranchStatus.Open,
      priority: Priority.MEDIUM,
      createdById: identity.userId,
      createdAt: firstPushedAt,
      updatedAt: activityAt,
    });
    branchDetails.push({
      artifactId: branchId,
      organizationId: identity.organizationId,
      repositoryFullName: REPOSITORY_FULL_NAME,
      branchName,
      baseBranch: "main",
      headSha,
      headShaSource: "branches_web_vqa_seed",
      headShaObservedAt: activityAt,
      lastActivityAt: activityAt,
      firstPushedAt,
      pushSource: BranchPushSource.Session,
    });
    sessionArtifacts.push({
      id: sessionId,
      organizationId: identity.organizationId,
      projectId: identity.projectId,
      type: ArtifactType.SESSION,
      name: `ISS-8018 VQA session ${branchNumber}`,
      slug: `${BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX}-session-${branchNumber}`,
      status: SESSION_STATUS.INACTIVE,
      priority: Priority.MEDIUM,
      createdById: identity.userId,
      createdAt: sessionStartedAt,
      updatedAt: sessionEndedAt,
    });
    sessionDetails.push({
      artifactId: sessionId,
      computeTargetId: identity.computeTargetId,
      externalSessionId: `${BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX}-${branchNumber}`,
      harness: "codex",
      billingMode: null,
      repositoryFullName: REPOSITORY_FULL_NAME,
      sessionStartedAt,
      sessionUpdatedAt: sessionEndedAt,
      lastActivityAt: sessionEndedAt,
      sessionEndedAt,
      // ISS-8515: named explicitly, because the column lost its `DEFAULT 0` in
      // this same change. This seed creates no token rows, so 0 is the honest
      // value and keeps the fixture rendering the cost it always has; omitting
      // it would now seed NULL and flip the surface to "unavailable".
      estimatedCost: 0,
      metadata: {},
    });
    links.push({
      organizationId: identity.organizationId,
      sourceId: sessionId,
      targetId: branchId,
      linkType: LinkType.RELATES_TO,
      branchParticipation: BranchParticipationKind.Wrote,
      branchParticipationMethod: "branches_web_vqa_seed",
      branchParticipationObservedAt: sessionEndedAt,
      lastContributedAt: sessionEndedAt,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    });
    activityAtoms.push({
      version: BranchActivityAtomVersion.V1,
      organizationId: identity.organizationId,
      branchArtifactId: branchId,
      source: BranchActivitySource.GitHead,
      sourceEventId: `${BRANCHES_WEB_SEED_ARTIFACT_SLUG_PREFIX}:${branchNumber}`,
      occurredAt: activityAt,
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.Branch,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: isUnavailableActivity ? activityAt : now,
    });
  }
  return {
    activityAtoms,
    branchArtifacts,
    branchDetails,
    links,
    sessionArtifacts,
    sessionDetails,
  };
}

async function createManyInChunks<Row>(
  rows: Row[],
  createMany: (data: Row[]) => Promise<unknown>
) {
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const chunk = rows.slice(index, index + CHUNK_SIZE);
    if (chunk.length > 0) {
      await createMany(chunk);
    }
  }
}

async function deleteManyForIdChunks(
  ids: string[],
  deleteMany: (ids: string[]) => Promise<unknown>
) {
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    const chunk = ids.slice(index, index + CHUNK_SIZE);
    if (chunk.length > 0) {
      await deleteMany(chunk);
    }
  }
}

async function runWithProductionDb(
  fn: (db: unknown) => Promise<void> | void
): Promise<void> {
  await withDb.tx(async (db) => {
    await fn(db);
  });
}

function loadApiLocalEnv() {
  dotenvConfig({
    path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env.local"),
    override: false,
  });
}

function shaFor(index: number): string {
  return index.toString(16).padStart(40, "0");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
