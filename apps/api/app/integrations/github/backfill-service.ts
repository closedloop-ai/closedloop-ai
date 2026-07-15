import {
  GitHubBackfillStatus,
  type GitHubBackfillSummary,
} from "@repo/api/src/types/github";
import { GitHubProviderBudgetState } from "@repo/api/src/types/github-read-model";
import type { Prisma } from "@repo/database";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviewsWithProviderResult,
  queryBundledPullRequestsWithProviderResult,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { z } from "zod";
import { parseGitHubPullRequestUrl } from "@/app/artifact-links/pull-requests/pull-request-url";
import {
  type GitHubBackfillPullRequestMetadata,
  githubBackfillProjectionWriter,
} from "./backfill-projection-writer";
import { githubService } from "./service";

export type RunGitHubBackfillInput = {
  organizationId: string;
  /**
   * Internal owner approval for visible projection writes. Public routes reject
   * request-body approval, so only trusted continuation/retry callers can move
   * the bounded backfill from diff-only into the shared writer path.
   */
  approvedForVisibleWrites?: boolean;
  repositoryLimit?: number;
  /**
   * Trusted continuations may run immediately after a bounded first slice. The
   * durable in-flight lease is still honored; only the post-release cooldown is
   * bypassed so the remaining repositories are not delayed or swallowed.
   */
  bypassCooldown?: boolean;
};

const DEFAULT_REPOSITORY_LIMIT = 10;
const BRANCH_PAGE_LIMIT = 100;
const PULL_REQUEST_PAGE_LIMIT = 100;
const PULL_REQUEST_BACKFILL_MAX_PAGES = 5;
const PULL_REQUEST_BACKFILL_MAX_ITEMS = 500;
const PULL_REQUEST_METADATA_LIMIT = 25;
const PULL_REQUEST_METADATA_PAGE_SIZE = 100;
const BACKFILL_SETTINGS_KEY = "githubBackfillLatestSummary";
const BACKFILL_RUN_GATE_SETTINGS_KEY = "githubBackfillRunGate";
const BACKFILL_RUN_LEASE_MS = 20 * 60 * 1000;
const BACKFILL_RUN_COOLDOWN_MS = 30 * 1000;
const gitHubBackfillSummarySchema = z.object({
  status: z.enum(GitHubBackfillStatus),
  repositoryCount: z.number().int().min(0),
  branchCount: z.number().int().min(0),
  pullRequestCount: z.number().int().min(0),
  branchProjectionChangeCount: z.number().int().min(0),
  pullRequestProjectionChangeCount: z.number().int().min(0),
  reviewDecisionProjectionChangeCount: z.number().int().min(0),
  checkProjectionChangeCount: z.number().int().min(0),
  issueCommentProjectionChangeCount: z.number().int().min(0).default(0),
  reviewCommentProjectionChangeCount: z.number().int().min(0).default(0),
  reviewThreadProjectionChangeCount: z.number().int().min(0).default(0),
  reviewProjectionChangeCount: z.number().int().min(0).default(0),
  statusCheckProjectionChangeCount: z.number().int().min(0).default(0),
  skippedBranchCount: z.number().int().min(0),
  dryRun: z.boolean(),
  ownerApprovalRequired: z.boolean(),
  failures: z.array(z.string()),
});
const gitHubBackfillRunGateSchema = z
  .object({
    inFlightUntil: z.number().int().min(0),
    cooldownUntil: z.number().int().min(0),
  })
  .strict();
const settingsObjectSchema = z.record(z.string(), z.unknown());

/** Bounded post-connect historical backfill owner for existing branch artifacts. */
export const githubBackfillService = {
  async runPostConnectBackfill(
    input: RunGitHubBackfillInput
  ): Promise<GitHubBackfillSummary> {
    const gate = await claimBackfillRun(input.organizationId, {
      bypassCooldown: Boolean(input.bypassCooldown),
    });
    if (!gate.claimed) {
      return gate.summary;
    }
    try {
      return await runPostConnectBackfillAfterClaim(input);
    } finally {
      await releaseBackfillRun(input.organizationId);
    }
  },
  getLatestBackfillSummary(
    organizationId: string
  ): Promise<GitHubBackfillSummary> {
    return getLatestBackfillSummary(organizationId);
  },
};

async function runPostConnectBackfillAfterClaim(
  input: RunGitHubBackfillInput
): Promise<GitHubBackfillSummary> {
  const repositoryLimit = clampRepositoryLimit(input.repositoryLimit);
  const failures: string[] = [];
  let branchCount = 0;
  let pullRequestCount = 0;
  let branchProjectionChangeCount = 0;
  let pullRequestProjectionChangeCount = 0;
  let reviewDecisionProjectionChangeCount = 0;
  let checkProjectionChangeCount = 0;
  let issueCommentProjectionChangeCount = 0;
  let reviewCommentProjectionChangeCount = 0;
  let reviewThreadProjectionChangeCount = 0;
  let reviewProjectionChangeCount = 0;
  let statusCheckProjectionChangeCount = 0;
  let skippedBranchCount = 0;
  const repositories = await getBackfillRepositories(input.organizationId);
  const scopedRepositories = repositories.slice(0, repositoryLimit);

  for (const repository of scopedRepositories) {
    try {
      const targetNumbers = await getBackfillTargetPullRequestNumbers(
        input.organizationId,
        repository.id,
        repository.fullName
      );
      const [branches, pullRequests, bundledPullRequests] = await Promise.all([
        githubService.getBranches(
          repository.id,
          input.organizationId,
          BRANCH_PAGE_LIMIT
        ),
        githubService.getPullRequests(
          repository.id,
          input.organizationId,
          null,
          { limit: PULL_REQUEST_PAGE_LIMIT }
        ),
        queryBundledPullRequestsWithProviderResult(
          repository.installation.installationId,
          repository.owner,
          repository.name,
          targetNumbers,
          {
            maxItems:
              targetNumbers.length > 0
                ? PULL_REQUEST_BACKFILL_MAX_ITEMS
                : undefined,
            maxPages:
              targetNumbers.length > 0
                ? PULL_REQUEST_BACKFILL_MAX_PAGES
                : undefined,
            targetNumbers,
          }
        ),
      ]);
      branchCount += branches.branches.length;
      pullRequestCount += pullRequests.pullRequests.length;
      if (bundledPullRequests.status !== GitHubProviderResultStatus.Success) {
        failures.push(`${repository.fullName}:${bundledPullRequests.status}`);
        continue;
      }
      const metadata = await fetchPullRequestMetadata(
        repository,
        bundledPullRequests.value.pullRequests
      );
      failures.push(...metadata.failures);
      const projectionWriter = input.approvedForVisibleWrites
        ? githubBackfillProjectionWriter.write
        : githubBackfillProjectionWriter.diff;
      const diff = await projectionWriter({
        organizationId: input.organizationId,
        repository,
        pullRequests: bundledPullRequests.value.pullRequests,
        pullRequestMetadata: metadata.pullRequestMetadata,
      });
      branchProjectionChangeCount += diff.branchProjectionChangeCount;
      pullRequestProjectionChangeCount += diff.pullRequestProjectionChangeCount;
      reviewDecisionProjectionChangeCount +=
        diff.reviewDecisionProjectionChangeCount;
      checkProjectionChangeCount += diff.checkProjectionChangeCount;
      issueCommentProjectionChangeCount +=
        diff.issueCommentProjectionChangeCount;
      reviewCommentProjectionChangeCount +=
        diff.reviewCommentProjectionChangeCount;
      reviewThreadProjectionChangeCount +=
        diff.reviewThreadProjectionChangeCount;
      reviewProjectionChangeCount += diff.reviewProjectionChangeCount;
      statusCheckProjectionChangeCount += diff.statusCheckProjectionChangeCount;
      skippedBranchCount += diff.skippedBranchCount;
      if (
        bundledPullRequests.value.rateLimit.state ===
        GitHubProviderBudgetState.Low
      ) {
        failures.push(`${repository.fullName}:provider_budget_low`);
      }
    } catch {
      failures.push(repository.fullName);
    }
  }

  const summary = {
    status: resolveBackfillStatus(
      failures,
      Boolean(input.approvedForVisibleWrites)
    ),
    repositoryCount: scopedRepositories.length,
    branchCount,
    pullRequestCount,
    branchProjectionChangeCount,
    pullRequestProjectionChangeCount,
    reviewDecisionProjectionChangeCount,
    checkProjectionChangeCount,
    issueCommentProjectionChangeCount,
    reviewCommentProjectionChangeCount,
    reviewThreadProjectionChangeCount,
    reviewProjectionChangeCount,
    statusCheckProjectionChangeCount,
    skippedBranchCount,
    dryRun: !input.approvedForVisibleWrites,
    ownerApprovalRequired: !input.approvedForVisibleWrites,
    failures,
  };
  await persistLatestBackfillSummary(input.organizationId, summary);
  return summary;
}

async function fetchPullRequestMetadata(
  repository: {
    fullName: string;
    installation: { installationId: string };
    owner: string;
    name: string;
  },
  pullRequests: readonly { number: number; headSha: string | null }[]
): Promise<{
  pullRequestMetadata: GitHubBackfillPullRequestMetadata[];
  failures: string[];
}> {
  const pullRequestMetadata: GitHubBackfillPullRequestMetadata[] = [];
  const failures: string[] = [];
  for (const pullRequest of pullRequests.slice(
    0,
    PULL_REQUEST_METADATA_LIMIT
  )) {
    const metadata = await fetchSinglePullRequestMetadata(
      repository,
      pullRequest
    );
    pullRequestMetadata.push(metadata.metadata);
    failures.push(...metadata.failures);
  }
  return { pullRequestMetadata, failures };
}

async function fetchSinglePullRequestMetadata(
  repository: {
    fullName: string;
    installation: { installationId: string };
    owner: string;
    name: string;
  },
  pullRequest: { number: number; headSha: string | null }
): Promise<{
  metadata: GitHubBackfillPullRequestMetadata;
  failures: string[];
}> {
  const metadataOptions = {
    limit: PULL_REQUEST_METADATA_LIMIT,
    pageSize: PULL_REQUEST_METADATA_PAGE_SIZE,
  };
  const [issueComments, reviewComments, reviews, statusCheckRollup] =
    await Promise.all([
      listPullRequestIssueCommentsWithProviderResult(
        repository.installation.installationId,
        repository.owner,
        repository.name,
        pullRequest.number,
        metadataOptions
      ),
      listPullRequestReviewCommentsWithProviderResult(
        repository.installation.installationId,
        repository.owner,
        repository.name,
        pullRequest.number,
        metadataOptions
      ),
      listPullRequestReviewsWithProviderResult(
        repository.installation.installationId,
        repository.owner,
        repository.name,
        pullRequest.number,
        metadataOptions
      ),
      pullRequest.headSha
        ? queryStatusCheckRollupWithProviderResult(
            repository.installation.installationId,
            repository.owner,
            repository.name,
            pullRequest.headSha
          )
        : Promise.resolve(null),
    ]);
  return {
    metadata: {
      number: pullRequest.number,
      issueComments:
        issueComments.status === GitHubProviderResultStatus.Success
          ? issueComments.value
          : [],
      issueCommentsComplete:
        issueComments.status === GitHubProviderResultStatus.Success &&
        issueComments.value.length < PULL_REQUEST_METADATA_LIMIT,
      reviewComments:
        reviewComments.status === GitHubProviderResultStatus.Success
          ? reviewComments.value
          : [],
      reviewCommentsComplete:
        reviewComments.status === GitHubProviderResultStatus.Success &&
        reviewComments.value.length < PULL_REQUEST_METADATA_LIMIT,
      reviews:
        reviews.status === GitHubProviderResultStatus.Success
          ? reviews.value
          : [],
      statusCheckRollup:
        statusCheckRollup?.status === GitHubProviderResultStatus.Success
          ? statusCheckRollup.value
          : null,
    },
    failures: collectMetadataFailures(repository.fullName, pullRequest.number, {
      issueComments: issueComments.status,
      reviewComments: reviewComments.status,
      reviews: reviews.status,
      statusCheckRollup: statusCheckRollup?.status ?? "skipped",
    }),
  };
}

function collectMetadataFailures(
  repositoryFullName: string,
  pullRequestNumber: number,
  statuses: {
    issueComments: GitHubProviderResultStatus;
    reviewComments: GitHubProviderResultStatus;
    reviews: GitHubProviderResultStatus;
    statusCheckRollup: GitHubProviderResultStatus | "skipped";
  }
): string[] {
  const failures: string[] = [];
  for (const [kind, status] of Object.entries(statuses)) {
    if (status === GitHubProviderResultStatus.Success || status === "skipped") {
      continue;
    }
    failures.push(
      `${repositoryFullName}#${pullRequestNumber}:${kind}:${status}`
    );
  }
  return failures;
}

function resolveBackfillStatus(
  failures: string[],
  approvedForVisibleWrites: boolean
): GitHubBackfillStatus {
  if (failures.length > 0) {
    return GitHubBackfillStatus.Degraded;
  }
  if (approvedForVisibleWrites) {
    return GitHubBackfillStatus.Completed;
  }
  return GitHubBackfillStatus.OwnerApprovalRequired;
}

async function getBackfillTargetPullRequestNumbers(
  organizationId: string,
  repositoryId: string,
  repositoryFullName: string
): Promise<number[]> {
  const branches = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.BRANCH,
        branch: { repositoryId },
      },
      select: {
        branch: {
          select: {
            currentPullRequestDetail: {
              select: { htmlUrl: true },
            },
          },
        },
      },
    })
  );
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const artifact of branches) {
    const htmlUrl = artifact.branch?.currentPullRequestDetail?.htmlUrl;
    if (!htmlUrl) {
      continue;
    }
    const parsed = parseGitHubPullRequestUrl(htmlUrl);
    if (parsed?.fullName !== repositoryFullName || seen.has(parsed.number)) {
      continue;
    }
    seen.add(parsed.number);
    numbers.push(parsed.number);
  }
  return numbers;
}

function clampRepositoryLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value == null) {
    return DEFAULT_REPOSITORY_LIMIT;
  }
  return Math.min(Math.max(1, value), DEFAULT_REPOSITORY_LIMIT);
}

function getBackfillRepositories(organizationId: string) {
  return withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      where: {
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      include: {
        installation: {
          select: { installationId: true },
        },
      },
      orderBy: [
        { lastPushedAt: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ],
    })
  );
}

async function getLatestBackfillSummary(
  organizationId: string
): Promise<GitHubBackfillSummary> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  const settings = settingsObjectSchema.parse(organization?.settings ?? {});
  const parsed = gitHubBackfillSummarySchema.safeParse(
    settings[BACKFILL_SETTINGS_KEY]
  );
  return parsed.success ? parsed.data : emptyBackfillSummary();
}

function claimBackfillRun(
  organizationId: string,
  options: { bypassCooldown: boolean }
): Promise<
  { claimed: true } | { claimed: false; summary: GitHubBackfillSummary }
> {
  return withDb.tx(async (tx) => {
    await lockBackfillRunGate(tx, organizationId);
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = settingsObjectSchema.parse(organization?.settings ?? {});
    const now = Date.now();
    const gate = gitHubBackfillRunGateSchema.safeParse(
      settings[BACKFILL_RUN_GATE_SETTINGS_KEY]
    );
    const blockedUntil = gate.success
      ? Math.max(
          gate.data.inFlightUntil,
          options.bypassCooldown ? 0 : gate.data.cooldownUntil
        )
      : 0;
    if (blockedUntil > now) {
      return {
        claimed: false,
        summary: latestSummaryFromSettings(settings),
      };
    }
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
            inFlightUntil: now + BACKFILL_RUN_LEASE_MS,
            cooldownUntil: now + BACKFILL_RUN_COOLDOWN_MS,
          },
        } satisfies Prisma.InputJsonObject,
      },
    });
    return { claimed: true };
  });
}

async function releaseBackfillRun(organizationId: string): Promise<void> {
  await withDb.tx(async (tx) => {
    await lockBackfillRunGate(tx, organizationId);
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = settingsObjectSchema.parse(organization?.settings ?? {});
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
            inFlightUntil: 0,
            cooldownUntil: Date.now() + BACKFILL_RUN_COOLDOWN_MS,
          },
        } satisfies Prisma.InputJsonObject,
      },
    });
  });
}

async function lockBackfillRunGate(
  tx: TransactionClient,
  organizationId: string
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${organizationId}),
      hashtext(${"github-backfill-run"})
    )
  `;
}

async function persistLatestBackfillSummary(
  organizationId: string,
  summary: GitHubBackfillSummary
): Promise<void> {
  await withDb.tx(async (tx) => {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = settingsObjectSchema.parse(organization?.settings ?? {});
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          [BACKFILL_SETTINGS_KEY]: summary,
        } satisfies Prisma.InputJsonObject,
      },
    });
  });
}

function latestSummaryFromSettings(
  settings: Record<string, unknown>
): GitHubBackfillSummary {
  const parsed = gitHubBackfillSummarySchema.safeParse(
    settings[BACKFILL_SETTINGS_KEY]
  );
  return parsed.success ? parsed.data : emptyBackfillSummary();
}

function emptyBackfillSummary(): GitHubBackfillSummary {
  return {
    status: GitHubBackfillStatus.NotStarted,
    repositoryCount: 0,
    branchCount: 0,
    pullRequestCount: 0,
    branchProjectionChangeCount: 0,
    pullRequestProjectionChangeCount: 0,
    reviewDecisionProjectionChangeCount: 0,
    checkProjectionChangeCount: 0,
    issueCommentProjectionChangeCount: 0,
    reviewCommentProjectionChangeCount: 0,
    reviewThreadProjectionChangeCount: 0,
    reviewProjectionChangeCount: 0,
    statusCheckProjectionChangeCount: 0,
    skippedBranchCount: 0,
    dryRun: true,
    ownerApprovalRequired: true,
    failures: [],
  };
}
