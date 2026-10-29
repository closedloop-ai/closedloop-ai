import { randomUUID } from "node:crypto";
import {
  GitHubBackfillStatus,
  type GitHubBackfillSummary,
} from "@repo/api/src/types/github";
import type {
  GitHubBundledPullRequestsObservation,
  GitHubBundledPullRequestsResult,
  GitHubFetchCredentialType,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultProvenance,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { ArtifactType, withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import {
  listAllPullRequestIssueComments,
  listAllPullRequestReviewComments,
  listAllPullRequestReviews,
} from "@repo/github/pull-request-comment-lists";
import type { Octokit } from "@repo/github/user-token-auth";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { z } from "zod";
import {
  cloudBranchCanonicalPullRequestSelect,
  resolveCloudBranchCanonicalDetail,
} from "@/app/branches/branch-canonical-pull-request-cloud";
import { writeReconciledPullRequestFailures } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import {
  createGitHubReadCostObserver,
  GitHubReadCostRoute,
} from "@/lib/github/github-read-cost-log";
import {
  recordSyncClientNoAccessIfRepoDenied,
  recordSyncClientRateLimits,
  recordSyncClientRepoReached,
} from "@/lib/github/github-sync-client-feedback";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import {
  backfillFetchProvenance,
  fetchCredentialTypeFromKind,
} from "@/lib/github-fetch-provenance";
import {
  claimOrganizationRun,
  isOrganizationRunInFlight,
  type OrganizationRunGateDefinition,
  releaseOrganizationRun,
} from "@/lib/organization-run-gate";
import { writeOrganizationSettingsKey } from "@/lib/organization-settings-write";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  type BackfillRepositoryListCounts,
  type GitHubBackfillCandidate,
  getBackfillCandidates,
  readBackfillRepositoryListCounts,
} from "./backfill-candidates";
import {
  type BackfillCommentLists,
  reconcileProjectedComments,
} from "./backfill-comment-reconcile";
import type {
  GitHubBackfillProjectionDiff,
  GitHubBackfillPullRequestMetadata,
} from "./backfill-projection-contract";
import {
  addProjectionDiff,
  emptyProjectionDiff,
} from "./backfill-projection-diff-counter";
import { githubBackfillProjectionWriter } from "./backfill-projection-writer";
import { extractTrackedPullRequestNumbers } from "./tracked-pull-requests";
import { trackedRepositorySelector } from "./tracked-repository-selector";

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

const BACKFILL_LOG_PREFIX = "[github/backfill]";
const DEFAULT_REPOSITORY_LIMIT = 10;
/**
 * Depth of the targeted self-heal search, in pages and in items.
 *
 * The two are one number expressed twice: the provider loop bounds itself by
 * BOTH `maxPages` and `maxItems`, so the pages must be able to reach the items
 * or the item budget is fiction. This lane passes no explicit `pageSize`, so it
 * inherits `GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE` — which ISS-7891
 * cut from 100 to 25, taking the reachable depth from 500 to 125 while this
 * constant still claimed 500. Pages rise to keep the claim true.
 *
 * The cost is round trips, not items: this path pages through PRs ordered by
 * updated-at hunting specific numbers (the query has no server-side number
 * filter), and exits the moment every target is found. Burning all 20 pages
 * means the target is absent from the 500 most-recently-updated PRs — the same
 * miss that previously cost 5 pages, and the case that ends in a recorded fetch
 * failure either way.
 */
export const PULL_REQUEST_BACKFILL_MAX_PAGES = 20;
export const PULL_REQUEST_BACKFILL_MAX_ITEMS = 500;
/** Pull requests per repository whose metadata one sweep reads. */
const PULL_REQUEST_METADATA_LIMIT = 25;
/**
 * Cap on in-flight per-PR metadata TASKS (ISS-7408). Each PR's metadata is a
 * handful of GitHub reads that depend on nothing another PR returns, so
 * awaiting one PR at a time cost up to PULL_REQUEST_METADATA_LIMIT serial round
 * trips per repository to preserve an ordering the caller re-establishes
 * anyway. Same value as `DB_FANOUT_MAX_CONCURRENCY` (`lib/db-fanout.ts`).
 *
 * This bounds TASKS, not provider calls, and the distinction is the whole point
 * (#5689 review). Each task fans out
 * `PULL_REQUEST_METADATA_READS_PER_PULL_REQUEST` reads at once, so the real
 * ceiling is their product — 20 concurrent provider calls per repository, up
 * from the serial loop's 4. That is a deliberate 5x increase in burst, taken
 * because it stays well inside GitHub's App concurrency guidance while
 * returning most of the latency win; repositories still sweep serially, so 20
 * is the peak for the whole run, not per repo in parallel.
 */
export const PULL_REQUEST_METADATA_CONCURRENCY = 5;

/**
 * Provider reads `fetchSinglePullRequestMetadata` issues per PR, all at once:
 * issue comments, review comments, reviews, and the status-check rollup. The
 * rollup is skipped when the PR has no head SHA, so this is the ceiling rather
 * than a fixed count.
 */
export const PULL_REQUEST_METADATA_READS_PER_PULL_REQUEST = 4;
export const BACKFILL_SETTINGS_KEY = "githubBackfillLatestSummary";
export const BACKFILL_RUN_GATE_SETTINGS_KEY = "githubBackfillRunGate";
const BACKFILL_RUN_LEASE_MS = 20 * 60 * 1000;
const BACKFILL_RUN_COOLDOWN_MS = 30 * 1000;
/** Names this lane's settings writes in the shared row-count guard's messages. */
const BACKFILL_SETTINGS_WRITE_SUBJECT = "GitHub backfill settings write";
const BACKFILL_RUN_GATE: OrganizationRunGateDefinition = {
  settingsKey: BACKFILL_RUN_GATE_SETTINGS_KEY,
  lockName: "github-backfill-run",
  leaseMs: BACKFILL_RUN_LEASE_MS,
  cooldownMs: BACKFILL_RUN_COOLDOWN_MS,
  writeSubject: BACKFILL_SETTINGS_WRITE_SUBJECT,
};
const gitHubBackfillSummarySchema = z.object({
  status: z.enum(GitHubBackfillStatus),
  repositoryCount: z.number().int().min(0),
  branchCount: z.number().int().min(0),
  pullRequestCount: z.number().int().min(0),
  branchProjectionChangeCount: z.number().int().min(0),
  pullRequestProjectionChangeCount: z.number().int().min(0),
  lifecycleAtomProjectionChangeCount: z.number().int().min(0).default(0),
  branchLastActivityProjectionChangeCount: z.number().int().min(0).default(0),
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
const settingsObjectSchema = z.record(z.string(), z.unknown());

/**
 * The outcome of claiming a backfill run, with the sweep itself still pending.
 *
 * ISS-7408: a caller that hands the sweep to `waitUntil` MUST be able to await
 * the durable claim separately. The claim is what makes
 * `getLatestBackfillSummary` report `running`; if the response is sent before
 * it commits, the client's first status poll can read the PREVIOUS run's
 * terminal status, stop polling for good, and never see the sweep it started.
 */
export type GitHubBackfillStart =
  | { claimed: true; completion: Promise<GitHubBackfillSummary> }
  | { claimed: false; summary: GitHubBackfillSummary };

/** Bounded post-connect historical backfill owner for existing branch artifacts. */
export const githubBackfillService = {
  async runPostConnectBackfill(
    input: RunGitHubBackfillInput
  ): Promise<GitHubBackfillSummary> {
    const start = await startPostConnectBackfill(input);
    return start.claimed ? await start.completion : start.summary;
  },
  startPostConnectBackfill(
    input: RunGitHubBackfillInput,
    /** Runs on the lease claim's transaction (ISS-12552). */
    recordClaim?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<GitHubBackfillStart> {
    return startPostConnectBackfill(input, recordClaim);
  },
  getLatestBackfillSummary(
    organizationId: string
  ): Promise<GitHubBackfillSummary> {
    return getLatestBackfillSummary(organizationId);
  },
};

async function startPostConnectBackfill(
  input: RunGitHubBackfillInput,
  recordClaim?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<GitHubBackfillStart> {
  const claim = await claimOrganizationRun(
    input.organizationId,
    BACKFILL_RUN_GATE,
    { bypassCooldown: Boolean(input.bypassCooldown), recordClaim }
  );
  if (!claim.claimed) {
    return {
      claimed: false,
      summary: latestSummaryFromSettings(claim.settings),
    };
  }
  // Awaited by the caller or handed to `waitUntil`; either way the release is
  // bound here so no path can claim the durable gate and leak the lease.
  const completion = runPostConnectBackfillAfterClaim(input).finally(() =>
    releaseOrganizationRun(input.organizationId, BACKFILL_RUN_GATE)
  );
  return { claimed: true, completion };
}

async function runPostConnectBackfillAfterClaim(
  input: RunGitHubBackfillInput
): Promise<GitHubBackfillSummary> {
  const repositoryLimit = clampRepositoryLimit(input.repositoryLimit);
  const failures: string[] = [];
  let branchCount = 0;
  let pullRequestCount = 0;
  let projectionDiff = emptyProjectionDiff();
  const candidates = await getBackfillCandidates(input.organizationId);
  const scopedRepositories = candidates.slice(0, repositoryLimit);

  for (const repository of scopedRepositories) {
    const outcome = await sweepBackfillRepository(repository, input);
    branchCount += outcome.branchCount;
    pullRequestCount += outcome.pullRequestCount;
    failures.push(...outcome.failures);
    if (outcome.diff) {
      projectionDiff = addProjectionDiff(projectionDiff, outcome.diff);
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
    ...projectionDiff,
    dryRun: !input.approvedForVisibleWrites,
    ownerApprovalRequired: !input.approvedForVisibleWrites,
    failures,
  };
  await persistLatestBackfillSummary(input.organizationId, summary);
  return summary;
}

type BackfillRepositoryOutcome = {
  branchCount: number;
  pullRequestCount: number;
  /** Null when the repository never reached the projection lane. */
  diff: GitHubBackfillProjectionDiff | null;
  failures: string[];
};

/**
 * One repository's slice of the sweep. Never throws: an unexpected failure
 * becomes this repository's `failures` entry so the remaining repositories
 * still sweep.
 */
async function sweepBackfillRepository(
  repository: GitHubBackfillCandidate,
  input: RunGitHubBackfillInput
): Promise<BackfillRepositoryOutcome> {
  const feedbackContext = {
    logPrefix: BACKFILL_LOG_PREFIX,
    organizationId: input.organizationId,
    repositoryFullName: repository.fullName,
  };
  try {
    const targetNumbers = await getBackfillTargetPullRequestNumbers(
      input.organizationId,
      repository.repositoryId,
      repository.fullName
    );
    // One pooled client per repository sweep, shared by the bundled read and
    // every per-PR metadata read below (PLN-1525: resolve once per operation,
    // thread down). Tier 1 resolves the org's covering installation first, so an
    // App-installed org draws the identical credential it drew before this lane
    // existed; an installation-free org falls through to the budget-aware
    // user-token pool instead of one member's interactive bucket. A denial is
    // classified like any other provider failure so it stays distinguishable in
    // the summary rather than reading as a zero.
    const drawn = await getGitHubSyncClient({
      organizationId: input.organizationId,
      target: { owner: repository.owner, repo: repository.name },
    });
    if (!drawn.ok) {
      return repositoryOutcome({
        failures: [`${repository.fullName}:${drawn.error.reason}`],
      });
    }
    const client = drawn.value;
    const credentialType = fetchCredentialTypeFromKind(client.kind);
    const authorityProvenance = backfillAuthorityProvenance(
      credentialType,
      client.credentialOwnerId
    );
    const costObserver = createGitHubReadCostObserver({
      route: GitHubReadCostRoute.Backfill,
      organizationId: input.organizationId,
      repositoryId: repository.repositoryId,
      repositoryFullName: repository.fullName,
    });
    // GraphQL budget rides the response body, so the pool cannot see it without
    // the caller handing it back. Every page, not just the last.
    const observations: GitHubBundledPullRequestsObservation[] = [];
    const [listCounts, bundledPullRequests] = await Promise.all([
      // Best-effort, and deliberately NOT sharing a rejection fate with the
      // bundled read: these two numbers only decorate the summary, while the
      // bundled read carries the projection. Letting a transient list failure
      // reject the pair would discard a successful fetch and leave the
      // repository stale — the exact staleness this lane exists to remove.
      readBackfillRepositoryListCountsBestEffort({
        candidate: repository,
        organizationId: input.organizationId,
      }),
      queryBundledPullRequestsWithProviderResult(
        client.octokit,
        repository.owner,
        repository.name,
        targetNumbers,
        bundledReadOptions(targetNumbers),
        (observation) => {
          observations.push(observation);
          costObserver(observation);
        },
        repositoryDefaultObservationContext(authorityProvenance)
      ),
    ]);
    const counts = {
      branchCount: listCounts.branchCount,
      pullRequestCount: listCounts.pullRequestCount,
    };
    // Both reads spent the same drawn token, so both budgets go back.
    observations.push(...listCounts.observations);
    await recordSyncClientRateLimits(client, observations, feedbackContext);
    if (bundledPullRequests.status !== GitHubProviderResultStatus.Success) {
      if (input.approvedForVisibleWrites) {
        await writeReconciledPullRequestFailures({
          organizationId: input.organizationId,
          repositoryId: repository.repositoryId,
          repositoryFullName: repository.fullName,
          pullRequestNumbers: targetNumbers,
          result: bundledPullRequests,
          provenance: authorityProvenance,
        });
      }
      await recordSyncClientNoAccessIfRepoDenied(
        client,
        bundledPullRequests.status,
        feedbackContext
      );
      return repositoryOutcome({
        ...counts,
        failures: [`${repository.fullName}:${bundledPullRequests.status}`],
      });
    }
    await recordSyncClientRepoReached(client, feedbackContext);
    const metadata = await fetchPullRequestMetadata(
      client.octokit,
      repository,
      bundledPullRequests.value.pullRequests
    );
    const projectionInput = {
      organizationId: input.organizationId,
      repository: {
        id: repository.repositoryId,
        fullName: repository.fullName,
      },
      pullRequests: bundledPullRequests.value.pullRequests,
      pullRequestMetadata: metadata.pullRequestMetadata,
    };
    const projected: { number: number; pullRequestDetailId: string }[] = [];
    const diff = input.approvedForVisibleWrites
      ? await githubBackfillProjectionWriter.write({
          ...projectionInput,
          credential: {
            type: credentialType,
            ownerId: client.credentialOwnerId,
          },
          onPullRequestProjected: (pullRequest) => projected.push(pullRequest),
        })
      : await githubBackfillProjectionWriter.diff(projectionInput);
    const commentFailures = await reconcileProjectedComments(
      repository.fullName,
      projected,
      metadata.commentListsByNumber,
      backfillFetchProvenance({
        credentialType,
        credentialOwnerId: client.credentialOwnerId,
      })
    );
    const budgetFailures =
      bundledPullRequests.value.rateLimit.state ===
      GitHubProviderBudgetState.Low
        ? [`${repository.fullName}:provider_budget_low`]
        : [];
    return repositoryOutcome({
      ...counts,
      diff,
      failures: [
        ...listCounts.failures,
        ...metadata.failures,
        ...commentFailures,
        ...coverageShortfallFailures(repository.fullName, bundledPullRequests),
        ...budgetFailures,
      ],
    });
  } catch {
    return repositoryOutcome({ failures: [repository.fullName] });
  }
}

/**
 * The branch and PR list counts, or zeros plus a recorded failure.
 *
 * A zero here is not a measured zero, and the `failures[]` entry is what says
 * so: it moves the run to `degraded`, so a reader never takes a short count for
 * an empty repository. Reporting the number as absent instead would take a
 * summary field from `number` to `number | null` across a contract this change
 * does not otherwise touch.
 */
async function readBackfillRepositoryListCountsBestEffort(
  input: Parameters<typeof readBackfillRepositoryListCounts>[0]
): Promise<BackfillRepositoryListCounts & { failures: string[] }> {
  try {
    const counts = await readBackfillRepositoryListCounts(input);
    return { ...counts, failures: [] };
  } catch (error) {
    log.warn(`${BACKFILL_LOG_PREFIX} repository list counts failed`, {
      organizationId: input.organizationId,
      repositoryFullName: input.candidate.fullName,
      error: parseError(error),
    });
    return {
      branchCount: 0,
      pullRequestCount: 0,
      observations: [],
      failures: [`${input.candidate.fullName}:list_counts_unavailable`],
    };
  }
}

/**
 * What the bounded provider search did NOT reach.
 *
 * `truncated` means the search hit its own page/item ceiling; a non-empty
 * `missingTargetNumbers` means specific tracked PRs were asked for and never
 * found inside that window, so they get no deeper read this pass. Both leave
 * the sweep short of the coverage it set out for, and a summary that reported
 * `completed` while withholding them would read as full coverage — the one
 * claim these entries exist to disprove.
 */
function coverageShortfallFailures(
  repositoryFullName: string,
  bundled: { value: GitHubBundledPullRequestsResult }
): string[] {
  const failures: string[] = [];
  if (bundled.value.truncated) {
    failures.push(`${repositoryFullName}:target_search_truncated`);
  }
  const missing = bundled.value.missingTargetNumbers?.length ?? 0;
  if (missing > 0) {
    failures.push(`${repositoryFullName}:targets_missing:${missing}`);
  }
  return failures;
}

function repositoryOutcome(
  overrides: Partial<BackfillRepositoryOutcome>
): BackfillRepositoryOutcome {
  return {
    branchCount: overrides.branchCount ?? 0,
    pullRequestCount: overrides.pullRequestCount ?? 0,
    diff: overrides.diff ?? null,
    failures: overrides.failures ?? [],
  };
}

function backfillAuthorityProvenance(
  credentialType: GitHubFetchCredentialType,
  credentialOwnerId: string | null
): RepositoryDefaultProvenance {
  return {
    source: RepositoryDefaultSource.PullRequestGraphql,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType,
    ...(credentialOwnerId ? { credentialOwnerId } : {}),
    observationKey: randomUUID(),
    observedAt: new Date().toISOString(),
  };
}

/**
 * The deeper bounded search is spent only when there are targets to hunt; with
 * none, the provider's own defaults keep the sweep to a first page.
 */
function bundledReadOptions(targetNumbers: number[]) {
  const targeted = targetNumbers.length > 0;
  return {
    maxItems: targeted ? PULL_REQUEST_BACKFILL_MAX_ITEMS : undefined,
    maxPages: targeted ? PULL_REQUEST_BACKFILL_MAX_PAGES : undefined,
    targetNumbers,
  };
}

function repositoryDefaultObservationContext(
  provenance: RepositoryDefaultProvenance
) {
  return {
    mechanism: provenance.mechanism,
    trigger: provenance.trigger,
    credentialType: provenance.credentialType,
    ...(provenance.credentialOwnerId
      ? { credentialOwnerId: provenance.credentialOwnerId }
      : {}),
    observationKey: provenance.observationKey,
    observedAt: provenance.observedAt,
  };
}

async function fetchPullRequestMetadata(
  octokit: Octokit,
  repository: {
    fullName: string;
    owner: string;
    name: string;
  },
  pullRequests: readonly { number: number; headSha: string | null }[]
): Promise<{
  pullRequestMetadata: GitHubBackfillPullRequestMetadata[];
  commentListsByNumber: Map<number, BackfillCommentLists>;
  failures: string[];
}> {
  const targets = pullRequests.slice(0, PULL_REQUEST_METADATA_LIMIT);
  const limit = pLimit(PULL_REQUEST_METADATA_CONCURRENCY);
  // `allSettled`, not `all`: `all` rejects on the first failure while the
  // queued and in-flight fetches keep running unawaited, which the
  // fire-and-forget rule in apps/api/AGENTS.md forbids. `.map` order is
  // preserved by both, so the projection writer still sees the PRs in the same
  // order the serial loop produced.
  const settled = await Promise.allSettled(
    targets.map((pullRequest) =>
      limit(() =>
        fetchSinglePullRequestMetadata(octokit, repository, pullRequest)
      )
    )
  );

  const pullRequestMetadata: GitHubBackfillPullRequestMetadata[] = [];
  const commentListsByNumber = new Map<number, BackfillCommentLists>();
  const failures: string[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      pullRequestMetadata.push(result.value.metadata);
      commentListsByNumber.set(
        result.value.metadata.number,
        result.value.commentLists
      );
      failures.push(...result.value.failures);
      continue;
    }
    // The per-read helpers report provider trouble as a status rather than a
    // throw, so a rejection here is unexpected rather than routine. It still
    // has to land in `failures` — that array is what moves the summary to
    // `degraded`, and a dropped PR that reported nothing would let the run
    // claim a clean sweep it did not make.
    failures.push(
      `${repository.fullName}#${targets[index]?.number}:metadata:rejected`
    );
  }
  return { pullRequestMetadata, commentListsByNumber, failures };
}

async function fetchSinglePullRequestMetadata(
  octokit: Octokit,
  repository: {
    fullName: string;
    owner: string;
    name: string;
  },
  pullRequest: { number: number; headSha: string | null }
): Promise<{
  metadata: GitHubBackfillPullRequestMetadata;
  commentLists: BackfillCommentLists;
  failures: string[];
}> {
  const listedAt = new Date();
  const [issueComments, reviewComments, reviews, statusCheckRollup] =
    await Promise.all([
      listAllPullRequestIssueComments(
        octokit,
        repository.owner,
        repository.name,
        pullRequest.number
      ),
      listAllPullRequestReviewComments(
        octokit,
        repository.owner,
        repository.name,
        pullRequest.number
      ),
      listAllPullRequestReviews(
        octokit,
        repository.owner,
        repository.name,
        pullRequest.number
      ),
      pullRequest.headSha
        ? queryStatusCheckRollupWithProviderResult(
            octokit,
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
          ? issueComments.value.items
          : [],
      issueCommentsComplete:
        issueComments.status === GitHubProviderResultStatus.Success &&
        issueComments.value.complete,
      reviewComments:
        reviewComments.status === GitHubProviderResultStatus.Success
          ? reviewComments.value.items
          : [],
      reviewCommentsComplete:
        reviewComments.status === GitHubProviderResultStatus.Success &&
        reviewComments.value.complete,
      reviews:
        reviews.status === GitHubProviderResultStatus.Success
          ? reviews.value.items
          : [],
      statusCheckRollup:
        statusCheckRollup?.status === GitHubProviderResultStatus.Success
          ? statusCheckRollup.value
          : null,
    },
    commentLists: { issueComments, reviewComments, reviews, listedAt },
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
  repositoryId: string | null,
  repositoryFullName: string
): Promise<number[]> {
  const branches = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.BRANCH,
        // A bare `{ repositoryId }` returns zero rows for an installation-free
        // org even after the candidate list is widened, so the sweep would find
        // no self-heal targets and read as a clean pass.
        branch: trackedRepositorySelector({
          repositoryId,
          repositoryFullName,
        }),
      },
      select: {
        id: true,
        branch: {
          select: {
            currentPullRequestDetailId: true,
            repositoryId: true,
            repositoryFullName: true,
            repository: { select: { fullName: true } },
          },
        },
        // Scoped with the SAME predicate as the branch above (PR #6453 review):
        // the canonical population keys on `branchArtifactId` alone, so an
        // unscoped candidate list lets a live PR row from another repository
        // win the arbitration. `extractTrackedPullRequestNumbers` then filters
        // that foreign URL back out, and the branch's real PR — the one this
        // sweep exists to self-heal — is silently never targeted.
        pullRequestDetails: {
          where: trackedRepositorySelector({
            repositoryId,
            repositoryFullName,
          }),
          select: cloudBranchCanonicalPullRequestSelect,
        },
      },
    })
  );
  // ISS-8522: the sweep targets the branch's CANONICAL PR, not whatever the
  // promotion pointer last named — a branch whose pointer is stale or still an
  // unpromoted stub would otherwise self-heal the wrong PR, or none at all.
  const htmlUrls = branches.flatMap((artifact) => {
    if (!artifact.branch) {
      return [];
    }
    const canonical = resolveCloudBranchCanonicalDetail({
      id: artifact.id,
      currentPullRequestDetailId: artifact.branch.currentPullRequestDetailId,
      branch: artifact.branch,
      pullRequestDetails: artifact.pullRequestDetails,
    });
    const htmlUrl = canonical.detail?.htmlUrl;
    return htmlUrl ? [htmlUrl] : [];
  });
  // The canonical extractor, not a second copy of it: it normalizes BOTH sides
  // before comparing. The verbatim compare this replaced silently dropped every
  // target whose stored `htmlUrl` casing disagreed with the repository row's —
  // an under-read that looked like a repository with nothing to self-heal.
  return extractTrackedPullRequestNumbers(repositoryFullName, htmlUrls);
}

function clampRepositoryLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value == null) {
    return DEFAULT_REPOSITORY_LIMIT;
  }
  return Math.min(Math.max(1, value), DEFAULT_REPOSITORY_LIMIT);
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
  const summary = latestSummaryFromSettings(settings);
  if (!isOrganizationRunInFlight(settings, BACKFILL_RUN_GATE)) {
    return summary;
  }
  // ISS-7408: the summary key is written only once a run FINISHES, so on its
  // own it reports the previous run's terminal status while a new run is still
  // sweeping. That made it unusable as the status surface for the 202 the POST
  // now returns: a poller would read `completed` immediately and stop before
  // any of the new data landed. The run gate is the in-flight fact, written
  // inside the claim transaction and cleared only after the summary is
  // persisted, so a reader that sees it clear is guaranteed the fresh summary.
  //
  // The counts stay those of the last COMPLETED run — they are last-known, not
  // progress. `status` is the only field describing the run in flight.
  return { ...summary, status: GitHubBackfillStatus.Running };
}

async function persistLatestBackfillSummary(
  organizationId: string,
  summary: GitHubBackfillSummary
): Promise<void> {
  // No lock: this key is not part of any read-decide-write critical section, so
  // unlike the run gate it takes no advisory lock. Matches
  // `frustration-setting-service` and `onboarding/service`. The single-statement
  // transaction the shared writer opens (ISS-7142) exists so its row-count
  // refusal can roll back, not to serialize anything.
  await writeOrganizationSettingsKey(
    organizationId,
    BACKFILL_SETTINGS_KEY,
    summary,
    BACKFILL_SETTINGS_WRITE_SUBJECT
  );
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
    lifecycleAtomProjectionChangeCount: 0,
    branchLastActivityProjectionChangeCount: 0,
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
