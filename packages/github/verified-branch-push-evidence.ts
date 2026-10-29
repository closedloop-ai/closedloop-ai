import type { Octokit } from "@octokit/rest";
import {
  BranchIdentityAvailability,
  isHumanGitHubActor,
} from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import type { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  type AssociatedPullRequestRef,
  getBranchPushCommitShas,
} from "./branch-push-commit-shas";
import {
  BranchPushTransitionState,
  readReportedPushAccount,
  verifyBranchPushTransition,
} from "./branch-push-transition";
import { getCheckSuitePushEvidenceForCommit } from "./check-suite-push-evidence";
import type { GitHubOperationReadBudget } from "./operation-read-budget";
import { getPullRequestForcePushEvents } from "./pull-request-force-push-events";
import { getRecentBranchPushEvents } from "./repository-push-events";

export const MAX_ASSOCIATED_PULL_REQUESTS = 20;
const MAX_CHECK_SUITE_COMMIT_READS = 100;
const MAX_REST_ACCOUNT_READS = 30;
const MAX_TRANSITION_VERIFICATIONS = 100;

export type VerifiedBranchPush = {
  source: BranchPushContributionSource;
  sourceEventId: string;
  beforeSha: string;
  afterSha: string;
  providerUserId: string;
  providerLogin?: string;
  actorType: GitHubActorType;
  observedAt: Date;
};

/** Supported provider observations do not by themselves establish lifetime completeness. */
export type VerifiedBranchPushEvidence = {
  pushes: VerifiedBranchPush[];
  availability: BranchIdentityAvailability;
};

type BranchPushReadInput = {
  owner: string;
  repo: string;
  branchName: string;
  pullRequests: readonly AssociatedPullRequestRef[];
  observedAt: Date;
  readBudget?: GitHubOperationReadBudget;
};

type CandidateRead = {
  candidates: VerifiedBranchPush[];
  availability: BranchIdentityAvailability[];
};

type VerifiedCandidateRead = {
  pushes: VerifiedBranchPush[];
  availability: BranchIdentityAvailability | null;
};

/**
 * Recover bounded exact-ref GitHub pusher evidence, then verify every new-commit
 * transition before it can become a durable collaborator receipt.
 */
export async function getVerifiedBranchPushEvidence(
  octokit: Octokit,
  input: BranchPushReadInput
): Promise<VerifiedBranchPushEvidence> {
  const pullRequests = uniquePullRequests(input.pullRequests).slice(
    0,
    MAX_ASSOCIATED_PULL_REQUESTS
  );
  const remaining = input.readBudget?.requestsRemaining() ?? 0;
  const checks = await readPhase(input, Math.floor(remaining * 0.3), () =>
    collectCheckSuiteCandidates(octokit, input, pullRequests)
  );
  const forcePushes = await readPhase(input, Math.floor(remaining * 0.2), () =>
    collectForcePushCandidates(octokit, input, pullRequests)
  );
  const recent = await readPhase(input, Math.floor(remaining * 0.2), () =>
    collectRecentCandidates(octokit, input)
  );
  const sources = [
    ...checks.availability,
    ...forcePushes.availability,
    ...recent.availability,
  ];
  const verified = await verifyCandidates(octokit, input, [
    ...checks.candidates,
    ...forcePushes.candidates,
    ...recent.candidates,
  ]);
  const availabilitySources = [
    ...sources,
    ...(verified.availability ? [verified.availability] : []),
  ];
  return {
    pushes: verified.pushes,
    availability: resolveEvidenceAvailability(
      availabilitySources,
      verified.availability
    ),
  };
}

async function collectCheckSuiteCandidates(
  octokit: Octokit,
  input: BranchPushReadInput,
  pullRequests: readonly AssociatedPullRequestRef[]
): Promise<CandidateRead> {
  const commitBudget = Math.floor(
    (input.readBudget?.requestsRemaining() ?? 0) / 2
  );
  const commits = await readPhase(input, commitBudget, () =>
    getBranchPushCommitShas(octokit, {
      owner: input.owner,
      repo: input.repo,
      branchName: input.branchName,
      pullRequests,
    })
  );
  const candidates: VerifiedBranchPush[] = [];
  const availability = [commits.availability];
  for (const commitSha of commits.commitShas.slice(
    0,
    MAX_CHECK_SUITE_COMMIT_READS
  )) {
    if (input.readBudget?.exhausted()) {
      break;
    }
    const evidence = await getCheckSuitePushEvidenceForCommit(octokit, {
      owner: input.owner,
      repo: input.repo,
      branchName: input.branchName,
      commitSha,
    });
    availability.push(evidence.availability);
    for (const push of evidence.pushes) {
      candidates.push({
        source: BranchPushContributionSource.GraphqlPush,
        sourceEventId: push.pushId,
        beforeSha: push.beforeSha,
        afterSha: push.afterSha,
        providerUserId: push.providerUserId,
        ...(push.providerLogin ? { providerLogin: push.providerLogin } : {}),
        actorType: push.actorType,
        observedAt: input.observedAt,
      });
    }
  }
  return { candidates, availability };
}

async function collectForcePushCandidates(
  octokit: Octokit,
  input: BranchPushReadInput,
  pullRequests: readonly AssociatedPullRequestRef[]
): Promise<CandidateRead> {
  const candidates: VerifiedBranchPush[] = [];
  const availability: BranchIdentityAvailability[] = [];
  for (const pullRequest of pullRequests) {
    if (input.readBudget?.exhausted()) {
      break;
    }
    const evidence = await getPullRequestForcePushEvents(octokit, {
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      branchName: input.branchName,
      pullNumber: pullRequest.number,
    });
    availability.push(evidence.availability);
    for (const event of evidence.events) {
      candidates.push({
        source: BranchPushContributionSource.HeadRefForcePushed,
        sourceEventId: event.eventId,
        beforeSha: event.beforeSha,
        afterSha: event.afterSha,
        providerUserId: event.providerUserId,
        ...(event.providerLogin ? { providerLogin: event.providerLogin } : {}),
        actorType: event.actorType,
        observedAt: event.observedAt,
      });
    }
  }
  return { candidates, availability };
}

function uniquePullRequests(
  pullRequests: readonly AssociatedPullRequestRef[]
): AssociatedPullRequestRef[] {
  const byKey = new Map<string, AssociatedPullRequestRef>();
  for (const pullRequest of pullRequests) {
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
      continue;
    }
    const key = `${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${pullRequest.number}`;
    byKey.set(key, pullRequest);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = `${left.owner}/${left.repo}#${left.number}`;
    const rightKey = `${right.owner}/${right.repo}#${right.number}`;
    return leftKey.localeCompare(rightKey);
  });
}

async function collectRecentCandidates(
  octokit: Octokit,
  input: BranchPushReadInput
): Promise<CandidateRead> {
  const recent = await getRecentBranchPushEvents(octokit, {
    owner: input.owner,
    repo: input.repo,
    branchName: input.branchName,
  });
  const candidates: VerifiedBranchPush[] = [];
  const restAccounts = new Map<
    string,
    Awaited<ReturnType<typeof readReportedPushAccount>>
  >();
  for (const event of recent.events) {
    if (input.readBudget?.exhausted()) {
      break;
    }
    if (
      restAccounts.size >= MAX_REST_ACCOUNT_READS &&
      !restAccounts.has(event.providerUserId)
    ) {
      continue;
    }
    if (!restAccounts.has(event.providerUserId)) {
      restAccounts.set(
        event.providerUserId,
        await readReportedPushAccount(octokit, event.providerUserId)
      );
    }
    const account = restAccounts.get(event.providerUserId);
    if (!(account && isHumanGitHubActor(account.actorType))) {
      continue;
    }
    candidates.push({
      source: BranchPushContributionSource.RestPushEvent,
      sourceEventId: event.eventId,
      beforeSha: event.beforeSha,
      afterSha: event.afterSha,
      providerUserId: account.providerUserId,
      providerLogin: account.providerLogin,
      actorType: account.actorType,
      observedAt: event.observedAt,
    });
  }
  return { candidates, availability: [recent.availability] };
}

async function verifyCandidates(
  octokit: Octokit,
  input: BranchPushReadInput,
  candidates: readonly VerifiedBranchPush[]
): Promise<VerifiedCandidateRead> {
  const verified: VerifiedBranchPush[] = [];
  const seenSourceEvents = new Set<string>();
  const transitionSources = new Map<string, BranchPushContributionSource>();
  let verificationCount = 0;
  let sawUnavailableTransition = false;
  let capped = false;
  for (const candidate of candidates) {
    if (
      verificationCount >= MAX_TRANSITION_VERIFICATIONS ||
      input.readBudget?.exhausted()
    ) {
      capped = true;
      break;
    }
    const sourceKey = `${candidate.source}:${candidate.sourceEventId}`;
    const transitionKey = `${candidate.beforeSha}:${candidate.afterSha}`;
    const preferredSource = transitionSources.get(transitionKey);
    if (
      seenSourceEvents.has(sourceKey) ||
      (preferredSource !== undefined && preferredSource !== candidate.source)
    ) {
      continue;
    }
    seenSourceEvents.add(sourceKey);
    verificationCount++;
    const state = await verifyBranchPushTransition(octokit, {
      owner: input.owner,
      repo: input.repo,
      beforeSha: candidate.beforeSha,
      afterSha: candidate.afterSha,
    });
    if (state === BranchPushTransitionState.Unavailable) {
      sawUnavailableTransition = true;
      continue;
    }
    if (state !== BranchPushTransitionState.NewCommits) {
      continue;
    }
    transitionSources.set(transitionKey, candidate.source);
    verified.push(candidate);
  }
  if (capped) {
    return {
      pushes: verified,
      availability: BranchIdentityAvailability.Incomplete,
    };
  }
  if (sawUnavailableTransition && verified.length === 0) {
    return {
      pushes: verified,
      availability: BranchIdentityAvailability.Unavailable,
    };
  }
  return {
    pushes: verified,
    availability:
      verified.length > 0 ? BranchIdentityAvailability.Incomplete : null,
  };
}

function resolveEvidenceAvailability(
  availabilitySources: readonly BranchIdentityAvailability[],
  verificationAvailability: BranchIdentityAvailability | null
): BranchIdentityAvailability {
  if (verificationAvailability === BranchIdentityAvailability.Unavailable) {
    return BranchIdentityAvailability.Unavailable;
  }
  if (
    availabilitySources.some(
      (source) => source === BranchIdentityAvailability.Incomplete
    )
  ) {
    return BranchIdentityAvailability.Incomplete;
  }
  return BranchIdentityAvailability.Unavailable;
}

/** Reserve operation capacity between sequential evidence families. */
async function readPhase<T>(
  input: BranchPushReadInput,
  limit: number,
  read: () => Promise<T>
): Promise<T> {
  return input.readBudget
    ? await input.readBudget.withRequestLimit(limit, read)
    : await read();
}
