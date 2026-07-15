import { randomUUID } from "node:crypto";
import { BranchViewCheckKind } from "@repo/api/src/types/branch-view";
import {
  ArtifactType,
  ChecksStatus,
  GitHubInstallationStatus,
  ProjectStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CheckRunRetryKey,
  CheckRunRetryState,
  claimDueCheckRunRetries,
  scheduleCheckRunRetry,
} from "@/lib/branch-status-check-retry";

const { mockQueryStatusCheckRollupWithProviderResult } = vi.hoisted(() => ({
  mockQueryStatusCheckRollupWithProviderResult: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  GitHubProviderResultStatus: {
    Success: "success",
    ProviderRateLimit: "provider_rate_limit",
    ProviderUnavailable: "provider_unavailable",
  },
  queryStatusCheckRollupWithProviderResult:
    mockQueryStatusCheckRollupWithProviderResult,
}));

import { GitHubProviderResultStatus } from "@repo/github";
import { drainDueCheckRunRetries } from "./branch-status-check-retry-drain";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDatabase ? describe : describe.skip;
const testOrganizationIds: string[] = [];

describeWithDatabase("check_run retry recovery integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (testOrganizationIds.length > 0) {
      const organizationId = testOrganizationIds.pop();
      if (organizationId) {
        await deleteSeededGraph(organizationId);
      }
    }
  });

  it("claims due pending retries and preserves duplicate idempotency attempts in the database", async () => {
    const seeded = await seedBranchGraph();
    const now = new Date("2026-07-03T01:00:00Z");
    const dueAt = new Date("2026-07-03T01:00:01Z");

    await withDb.tx((tx) =>
      scheduleCheckRunRetry(tx, seeded.retryKey, "rate_limited", now, 1)
    );
    const claims = await withDb.tx((tx) =>
      claimDueCheckRunRetries(tx, dueAt, 10)
    );
    await withDb.tx((tx) =>
      scheduleCheckRunRetry(tx, seeded.retryKey, "rate_limited", dueAt, 1)
    );

    expect(claims).toEqual([
      expect.objectContaining({
        attempts: 1,
        branchArtifactId: seeded.branchArtifactId,
        headSha: seeded.headSha,
        idempotencyKey: seeded.retryKey.idempotencyKey,
        installationId: seeded.installationId,
        owner: "acme",
        repo: "widgets",
        resourceId: seeded.retryKey.resourceId,
      }),
    ]);
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual(
      expect.objectContaining({
        attempts: 1,
        state: CheckRunRetryState.Pending,
      })
    );
  });

  it("drains a successful retry into current checks and clears retry metadata", async () => {
    const seeded = await seedDueRetry();
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: successRollup(),
    });

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:01Z"),
      10
    );

    expect(summary).toEqual({
      claimed: 1,
      deadLettered: 0,
      discarded: 0,
      missing: 0,
      rescheduled: 0,
      succeeded: 1,
    });
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual(
      expect.objectContaining({ attempts: 0, state: null })
    );
    await withDb(async (db) => {
      const branch = await db.branchDetail.findUniqueOrThrow({
        where: { artifactId: seeded.branchArtifactId },
        include: { statusChecks: true },
      });
      expect(branch.checksStatus).toBe(ChecksStatus.PASSING);
      expect(branch.statusChecks).toHaveLength(1);
      expect(branch.statusChecks[0]?.providerKey).toBe("ci/test");
    });
  });

  it("reschedules provider rate limits with the provider retry window", async () => {
    const seeded = await seedDueRetry();
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      retryAfterSeconds: 45,
      status: GitHubProviderResultStatus.ProviderRateLimit,
    });

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:01Z"),
      10
    );

    expect(summary.rescheduled).toBe(1);
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual({
      attempts: 1,
      nextAt: new Date("2026-07-03T01:00:46Z").toISOString(),
      state: CheckRunRetryState.Pending,
    });
  });

  it("discards retry metadata when the branch head changes after claim", async () => {
    const seeded = await seedDueRetry();
    mockQueryStatusCheckRollupWithProviderResult.mockImplementation(
      async () => {
        await withDb((db) =>
          db.branchDetail.update({
            where: { artifactId: seeded.branchArtifactId },
            data: { headSha: "new-head-sha" },
          })
        );
        return {
          status: GitHubProviderResultStatus.Success,
          value: successRollup(),
        };
      }
    );

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:01Z"),
      10
    );

    expect(summary.discarded).toBe(1);
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual(
      expect.objectContaining({ attempts: 0, state: null })
    );
  });

  it("discards retry metadata when the branch is deleted after claim", async () => {
    const seeded = await seedDueRetry();
    mockQueryStatusCheckRollupWithProviderResult.mockImplementation(
      async () => {
        await withDb((db) =>
          db.branchDetail.update({
            where: { artifactId: seeded.branchArtifactId },
            data: { deletedAt: new Date("2026-07-03T01:00:02Z") },
          })
        );
        return {
          status: GitHubProviderResultStatus.Success,
          value: successRollup(),
        };
      }
    );

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:01Z"),
      10
    );

    expect(summary.discarded).toBe(1);
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual(
      expect.objectContaining({ attempts: 0, state: null })
    );
  });

  it("dead-letters retryable provider failures at the retry ceiling", async () => {
    const seeded = await seedDueRetry({ attempts: 4 });
    mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
      retryAfterSeconds: null,
      status: GitHubProviderResultStatus.ProviderRateLimit,
    });

    const summary = await drainDueCheckRunRetries(
      new Date("2026-07-03T01:00:01Z"),
      10
    );

    expect(summary.deadLettered).toBe(1);
    await expect(readRetryState(seeded.branchArtifactId)).resolves.toEqual(
      expect.objectContaining({
        attempts: 5,
        state: CheckRunRetryState.DeadLetter,
      })
    );
  });
});

async function seedDueRetry(options: { attempts?: number } = {}) {
  const seeded = await seedBranchGraph();
  await withDb.tx(async (tx) => {
    await scheduleCheckRunRetry(
      tx,
      seeded.retryKey,
      "rate_limited",
      new Date("2026-07-03T01:00:00Z"),
      1
    );
    if (options.attempts !== undefined) {
      await tx.branchDetail.update({
        where: { artifactId: seeded.branchArtifactId },
        data: { checkRunRetryAttempts: options.attempts },
      });
    }
  });
  return seeded;
}

async function seedBranchGraph() {
  const ids = makeSeedIds();
  testOrganizationIds.push(ids.organizationId);
  await withDb.tx((tx) => insertSeededGraph(tx, ids));
  return {
    branchArtifactId: ids.branchArtifactId,
    headSha: ids.headSha,
    installationId: ids.installationIdValue,
    retryKey: {
      branchArtifactId: ids.branchArtifactId,
      headSha: ids.headSha,
      idempotencyKey: `repo:${ids.resourceId}:${ids.headSha}:completed`,
      organizationId: ids.organizationId,
      repositoryId: ids.repositoryId,
      resourceId: ids.resourceId,
    } satisfies CheckRunRetryKey,
  };
}

async function insertSeededGraph(
  tx: TransactionClient,
  ids: ReturnType<typeof makeSeedIds>
) {
  await tx.organization.create({
    data: {
      clerkId: `clerk-${ids.suffix}`,
      id: ids.organizationId,
      name: "Retry Integration Org",
      slug: `retry-integration-${ids.suffix}`,
    },
  });
  await tx.user.create({
    data: {
      clerkId: `user-${ids.suffix}`,
      email: `retry-${ids.suffix}@example.com`,
      id: ids.userId,
      organizationId: ids.organizationId,
    },
  });
  await tx.project.create({
    data: {
      createdById: ids.userId,
      id: ids.projectId,
      name: "Retry Integration Project",
      organizationId: ids.organizationId,
      slug: `retry-project-${ids.suffix}`,
      status: ProjectStatus.IN_PROGRESS,
    },
  });
  await tx.gitHubInstallation.create({
    data: {
      accountId: `account-${ids.suffix}`,
      accountLogin: "acme",
      accountType: "Organization",
      id: ids.installationRecordId,
      installationId: ids.installationIdValue,
      organizationId: ids.organizationId,
      senderId: `sender-${ids.suffix}`,
      senderLogin: "octocat",
      status: GitHubInstallationStatus.ACTIVE,
    },
  });
  await tx.gitHubInstallationRepository.create({
    data: {
      fullName: "acme/widgets",
      githubRepoId: ids.githubRepoId,
      id: ids.repositoryId,
      installationId: ids.installationRecordId,
      name: "widgets",
      owner: "acme",
      private: false,
    },
  });
  await tx.artifact.create({
    data: {
      id: ids.branchArtifactId,
      name: "feature/retry-integration",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      status: "OPEN",
      type: ArtifactType.BRANCH,
    },
  });
  await tx.branchDetail.create({
    data: {
      artifactId: ids.branchArtifactId,
      branchName: `feature/retry-${ids.suffix}`,
      checksStatus: ChecksStatus.UNKNOWN,
      headSha: ids.headSha,
      organizationId: ids.organizationId,
      repositoryFullName: "acme/widgets",
      repositoryId: ids.repositoryId,
    },
  });
}

async function deleteSeededGraph(organizationId: string) {
  await withDb.tx(async (tx) => {
    const artifacts = await tx.artifact.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const artifactIds = artifacts.map((artifact) => artifact.id);
    await tx.branchStatusCheck.deleteMany({
      where: { branchArtifactId: { in: artifactIds } },
    });
    await tx.branchDetail.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await tx.artifact.deleteMany({ where: { organizationId } });
    await tx.project.deleteMany({ where: { organizationId } });
    await tx.gitHubInstallationRepository.deleteMany({
      where: { installation: { organizationId } },
    });
    await tx.gitHubInstallation.deleteMany({ where: { organizationId } });
    await tx.user.deleteMany({ where: { organizationId } });
    await tx.organization.deleteMany({ where: { id: organizationId } });
  });
}

function readRetryState(branchArtifactId: string) {
  return withDb(async (db) => {
    const branch = await db.branchDetail.findUniqueOrThrow({
      where: { artifactId: branchArtifactId },
    });
    return {
      attempts: branch.checkRunRetryAttempts,
      nextAt: branch.checkRunRetryNextAt?.toISOString(),
      state: branch.checkRunRetryState,
    };
  });
}

function successRollup() {
  return {
    checks: [
      {
        conclusion: "SUCCESS",
        id: "ci/test",
        kind: BranchViewCheckKind.CheckRun,
        name: "CI / Test",
        position: 0,
        providerNodeId: null,
        status: "COMPLETED",
        targetUrl: "https://example.com/check",
      },
    ],
    ok: true,
    state: "SUCCESS",
    totalCount: 1,
    truncated: false,
  };
}

function makeSeedIds() {
  const suffix = randomUUID();
  return {
    branchArtifactId: randomUUID(),
    githubRepoId: `repo-${suffix}`,
    headSha: `head-${suffix}`,
    installationIdValue: `installation-${suffix}`,
    installationRecordId: randomUUID(),
    organizationId: randomUUID(),
    projectId: randomUUID(),
    repositoryId: randomUUID(),
    resourceId: `check-run-${suffix}`,
    suffix,
    userId: randomUUID(),
  };
}
