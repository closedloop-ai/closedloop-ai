import { ArtifactType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import {
  BranchPushContributionSource,
  isPlausibleBranchPushTransition,
} from "@repo/api/src/types/branch-push-contribution";
import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import {
  BranchPushTransitionState,
  verifyBranchPushTransition,
} from "@repo/github/branch-push-transition";
import { getCheckSuitePushEvidenceForCommit } from "@repo/github/check-suite-push-evidence";
import {
  createGitHubOperationReadBudget,
  type GitHubOperationReadBudget,
} from "@repo/github/operation-read-budget";
import type { Octokit } from "@repo/github/user-token-auth";
import {
  getVerifiedBranchPushEvidence,
  MAX_ASSOCIATED_PULL_REQUESTS,
} from "@repo/github/verified-branch-push-evidence";
import { z } from "zod";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import { readAssociatedPullRequestsForPushBackfill } from "./branch-canonical-pull-request-cloud";
import { branchPushBackfillQueueSql } from "./branch-push-backfill-queue";
import {
  BranchPushContributionWriteResult,
  recordBranchPushContribution,
} from "./branch-push-contribution-service";

const BACKFILL_RETRY_HOURS = 24;
const BACKFILL_BRANCHES_PER_TICK = 50;
const BACKFILL_TICK_REQUEST_LIMIT = 160;
const BACKFILL_TICK_DURATION_MS = 120_000;
const pullRequestHeadSchema = z.object({
  head: z.object({
    ref: z.string().nullable(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/** Measured receipts remain usable while missing lifetime history stays incomplete. */
export type BranchPushBackfillResult = {
  availability: BranchIdentityAvailability;
  observedCount: number;
  recordedCount: number;
};

/** Bound historical scans per scheduled tick while preserving retry fairness. */
export const branchPushBackfillService = {
  /** Prefer Push.pusher and retain a validated webhook account when checks provide no identity. */
  async captureWebhookPush(
    input: WebhookPushCaptureInput
  ): Promise<BranchPushBackfillResult> {
    return await captureWebhookPushContribution(input);
  },
  async backfillBranch(input: {
    organizationId: string;
    branchArtifactId: string;
    observedAt?: Date;
  }): Promise<BranchPushBackfillResult> {
    return await backfillBranchPushContributions(input);
  },
  async runNext(
    options: { organizationId?: string } = {}
  ): Promise<BranchPushBackfillResult | null> {
    const targets = await withDb((db) =>
      db.$queryRaw<{ organizationId: string; branchArtifactId: string }[]>(
        branchPushBackfillQueueSql({
          ...options,
          limit: BACKFILL_BRANCHES_PER_TICK,
          retryHours: BACKFILL_RETRY_HOURS,
        })
      )
    );
    if (targets.length === 0) {
      return null;
    }
    const budget = createGitHubOperationReadBudget({
      maxRequests: BACKFILL_TICK_REQUEST_LIMIT,
      maxDurationMs: BACKFILL_TICK_DURATION_MS,
    });
    const result: BranchPushBackfillResult = {
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 0,
      recordedCount: 0,
    };
    try {
      for (const target of targets) {
        if (budget.exhausted()) {
          break;
        }
        const observed = await backfillBranchPushContributions(target, budget);
        result.observedCount += observed.observedCount;
        result.recordedCount += observed.recordedCount;
      }
      return result;
    } finally {
      budget.dispose();
    }
  },
};

/** Backfill one org-owned Branch through its active installation credential. */
async function backfillBranchPushContributions(
  input: {
    organizationId: string;
    branchArtifactId: string;
    observedAt?: Date;
  },
  sharedBudget?: GitHubOperationReadBudget
): Promise<BranchPushBackfillResult> {
  const observedAt = input.observedAt ?? new Date();
  const target = await readBackfillTarget(
    input.organizationId,
    input.branchArtifactId
  );
  if (!target) {
    return emptyUnavailable();
  }
  if ("invalidLastAttemptAt" in target) {
    // Advance a stale repository pointer so it cannot hold the cron's only slot.
    await withDb((db) =>
      db.branchDetail.updateMany({
        where: {
          artifactId: input.branchArtifactId,
          organizationId: input.organizationId,
          pushCoverageLastAttemptAt: target.invalidLastAttemptAt,
        },
        data: {
          pushCoverageLastAttemptAt: observedAt,
          pushCoverageAvailability: BranchIdentityAvailability.Unavailable,
        },
      })
    );
    return emptyUnavailable();
  }
  const claimed = await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        organizationId: input.organizationId,
        pushCoverageLastAttemptAt: target.lastAttemptAt,
      },
      data: {
        pushCoverageLastAttemptAt: observedAt,
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
      },
    })
  );
  if (claimed.count === 0) {
    return emptyUnavailable();
  }
  const budget =
    sharedBudget ??
    createGitHubOperationReadBudget({ maxRequests: 80, maxDurationMs: 60_000 });
  try {
    const client = await acquireInstallationClient(target.installationId, {
      fetch: budget.fetch,
    });
    if (client.status !== GitHubProviderResultStatus.Success) {
      await stampCoverage(
        input,
        observedAt,
        BranchIdentityAvailability.Unavailable
      );
      return emptyUnavailable();
    }
    const evidence = await budget.withRequestLimit(80, async () => {
      const pullRequests = await resolveAssociatedPullRequests(
        client.value,
        target
      );
      return await getVerifiedBranchPushEvidence(client.value, {
        owner: target.owner,
        repo: target.repo,
        branchName: target.branchName,
        pullRequests,
        observedAt,
        readBudget: budget,
      });
    });
    let recordedCount = 0;
    for (const push of evidence.pushes) {
      const outcome = await recordBranchPushContribution({
        organizationId: input.organizationId,
        branchArtifactId: input.branchArtifactId,
        repositoryFullName: target.repositoryFullName,
        refName: target.branchName,
        beforeSha: push.beforeSha,
        afterSha: push.afterSha,
        source: push.source,
        sourceEventId: push.sourceEventId,
        providerUserId: push.providerUserId,
        ...(push.providerLogin ? { providerLogin: push.providerLogin } : {}),
        actorType: push.actorType,
        newCommitCount: 1,
        observedAt: push.observedAt,
      });
      if (outcome === BranchPushContributionWriteResult.Recorded) {
        recordedCount++;
      }
    }
    await stampCoverage(input, observedAt, evidence.availability);
    return {
      availability: evidence.availability,
      observedCount: evidence.pushes.length,
      recordedCount,
    };
  } finally {
    if (!sharedBudget) {
      budget.dispose();
    }
  }
}

async function readBackfillTarget(
  organizationId: string,
  branchArtifactId: string
) {
  const branch = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        artifactId: branchArtifactId,
        organizationId,
        artifact: { type: ArtifactType.Branch },
      },
      select: {
        repositoryFullName: true,
        branchName: true,
        pushCoverageLastAttemptAt: true,
        repository: {
          select: {
            owner: true,
            name: true,
            fullName: true,
            removedAt: true,
            installation: {
              select: {
                organizationId: true,
                installationId: true,
                status: true,
              },
            },
          },
        },
      },
    })
  );
  if (!branch) {
    return null;
  }
  const repository = branch.repository;
  if (
    !repository ||
    repository.removedAt ||
    repository.installation.organizationId !== organizationId ||
    repository.installation.status !== GitHubInstallationStatus.ACTIVE ||
    normalizeRepoFullName(repository.fullName) !== branch.repositoryFullName
  ) {
    return { invalidLastAttemptAt: branch.pushCoverageLastAttemptAt };
  }
  const pullRequests = await withDb((db) =>
    readAssociatedPullRequestsForPushBackfill(
      db,
      organizationId,
      branchArtifactId,
      MAX_ASSOCIATED_PULL_REQUESTS + 1
    )
  );
  return {
    repositoryFullName: branch.repositoryFullName,
    branchName: branch.branchName,
    owner: repository.owner,
    repo: repository.name,
    installationId: repository.installation.installationId,
    lastAttemptAt: branch.pushCoverageLastAttemptAt,
    pullRequests,
  };
}

async function resolveAssociatedPullRequests(
  octokit: Octokit,
  target: Extract<
    NonNullable<Awaited<ReturnType<typeof readBackfillTarget>>>,
    { owner: string }
  >
) {
  const result: { owner: string; repo: string; number: number }[] = [];
  for (const pullRequest of target.pullRequests.slice(
    0,
    MAX_ASSOCIATED_PULL_REQUESTS
  )) {
    const base = parseRepositoryFullName(
      pullRequest.repositoryFullName ?? pullRequest.repository?.fullName ?? ""
    );
    if (
      base &&
      pullRequest.headRefName === target.branchName &&
      normalizeRepoFullName(pullRequest.headRepositoryFullName ?? "") ===
        target.repositoryFullName
    ) {
      result.push({ ...base, number: pullRequest.number });
      continue;
    }
    const lookup = base ?? { owner: target.owner, repo: target.repo };
    try {
      const response = await octokit.rest.pulls.get({
        owner: lookup.owner,
        repo: lookup.repo,
        pull_number: pullRequest.number,
      });
      const parsed = pullRequestHeadSchema.safeParse(response.data);
      if (
        parsed.success &&
        parsed.data.head.ref === target.branchName &&
        normalizeRepoFullName(parsed.data.head.repo?.full_name ?? "") ===
          target.repositoryFullName
      ) {
        result.push({ ...lookup, number: pullRequest.number });
      }
    } catch {
      // A missing or denied historical PR leaves coverage incomplete.
    }
  }
  return result;
}

async function stampCoverage(
  input: { organizationId: string; branchArtifactId: string },
  observedAt: Date,
  availability: BranchIdentityAvailability
): Promise<void> {
  await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        organizationId: input.organizationId,
        pushCoverageLastAttemptAt: observedAt,
      },
      data: { pushCoverageAvailability: availability },
    })
  );
}

function emptyUnavailable(): BranchPushBackfillResult {
  return {
    availability: BranchIdentityAvailability.Unavailable,
    observedCount: 0,
    recordedCount: 0,
  };
}

async function captureWebhookPushContribution(
  input: WebhookPushCaptureInput
): Promise<BranchPushBackfillResult> {
  if (!isPlausibleBranchPushTransition(input.beforeSha, input.afterSha)) {
    return emptyUnavailable();
  }
  const target = await readBackfillTarget(
    input.organizationId,
    input.branchArtifactId
  );
  if (!target || "invalidLastAttemptAt" in target) {
    return emptyUnavailable();
  }
  const client = await acquireInstallationClient(target.installationId);
  if (client.status !== GitHubProviderResultStatus.Success) {
    return emptyUnavailable();
  }
  const transition = await verifyBranchPushTransition(client.value, {
    owner: target.owner,
    repo: target.repo,
    beforeSha: input.beforeSha,
    afterSha: input.afterSha,
  });
  if (transition !== BranchPushTransitionState.NewCommits) {
    return emptyUnavailable();
  }
  const evidence = await getCheckSuitePushEvidenceForCommit(client.value, {
    owner: target.owner,
    repo: target.repo,
    branchName: target.branchName,
    commitSha: input.afterSha,
  });
  const pushes = evidence.pushes.filter(
    (push) =>
      push.beforeSha.toLowerCase() === input.beforeSha.toLowerCase() &&
      push.afterSha.toLowerCase() === input.afterSha.toLowerCase()
  );
  let recordedCount = 0;
  if (
    pushes.length === 0 &&
    !evidence.excludedTransitions?.some(
      (range) =>
        range.beforeSha.toLowerCase() === input.beforeSha.toLowerCase() &&
        range.afterSha.toLowerCase() === input.afterSha.toLowerCase()
    )
  ) {
    if (evidence.availability === BranchIdentityAvailability.Unavailable) {
      return emptyUnavailable();
    }
    return await captureReportedWebhookAccount(
      input,
      target.repositoryFullName,
      target.branchName
    );
  }
  for (const push of pushes) {
    const outcome = await recordBranchPushContribution({
      organizationId: input.organizationId,
      branchArtifactId: input.branchArtifactId,
      repositoryFullName: target.repositoryFullName,
      refName: target.branchName,
      beforeSha: push.beforeSha,
      afterSha: push.afterSha,
      source: BranchPushContributionSource.GraphqlPush,
      sourceEventId: push.pushId,
      providerUserId: push.providerUserId,
      ...(push.providerLogin ? { providerLogin: push.providerLogin } : {}),
      actorType: push.actorType,
      newCommitCount: 1,
      observedAt: input.observedAt,
    });
    if (outcome === BranchPushContributionWriteResult.Recorded) {
      recordedCount++;
    }
  }
  // ISS-10992: one delivery proves its contributor, never lifetime coverage.
  return {
    availability: evidence.availability,
    observedCount: pushes.length,
    recordedCount,
  };
}

/** Account and delivery originate in the verified GitHub webhook, not an application user. */
export type WebhookPushCaptureInput = {
  organizationId: string;
  branchArtifactId: string;
  beforeSha: string;
  afterSha: string;
  observedAt: Date;
  sender?: unknown;
  deliveryId?: string;
};

const webhookAccountSchema = z.object({
  id: z.number().int().positive().refine(Number.isSafeInteger),
  login: z
    .string()
    .trim()
    .min(1)
    .refine((login) => login.toLowerCase() !== "ghost"),
  type: z.literal(GitHubActorType.User),
});
const webhookDeliveryIdSchema = z.string().trim().min(1).max(255);

async function captureReportedWebhookAccount(
  input: WebhookPushCaptureInput,
  repositoryFullName: string,
  refName: string
): Promise<BranchPushBackfillResult> {
  const account = webhookAccountSchema.safeParse(input.sender);
  const delivery = webhookDeliveryIdSchema.safeParse(input.deliveryId);
  if (!(account.success && delivery.success)) {
    return {
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 0,
      recordedCount: 0,
    };
  }
  const outcome = await recordBranchPushContribution({
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    repositoryFullName,
    refName,
    beforeSha: input.beforeSha,
    afterSha: input.afterSha,
    source: BranchPushContributionSource.Webhook,
    sourceEventId: delivery.data,
    providerUserId: String(account.data.id),
    providerLogin: account.data.login,
    actorType: GitHubActorType.User,
    newCommitCount: 1,
    observedAt: input.observedAt,
  });
  return {
    availability: BranchIdentityAvailability.Incomplete,
    observedCount: 1,
    recordedCount:
      outcome === BranchPushContributionWriteResult.Recorded ? 1 : 0,
  };
}
