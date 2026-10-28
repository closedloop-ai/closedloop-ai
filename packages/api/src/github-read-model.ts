import { ChecksStatus, ReviewDecision } from "./types/branch-checks.ts";
import { GitHubPRState } from "./types/github.ts";
import {
  normalizeGitHubActorType,
  normalizeGitHubProviderUserId,
} from "./types/github-actor.ts";
import {
  type GitHubBundledPullRequestsPageOptions,
  type GitHubBundledPullRequestsResult,
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  type GitHubFetchCredentialType as GitHubFetchCredentialTypeValue,
  GitHubFetchMechanism,
  type GitHubFetchMechanism as GitHubFetchMechanismValue,
  GitHubFetchTrigger,
  type GitHubFetchTrigger as GitHubFetchTriggerValue,
  type GitHubMergedPredicateInput,
  GitHubProviderBudgetState,
  type GitHubRateLimitBudget,
  type GitHubReadModelPageInfo,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
  type GitHubRepositoryDefaultObservationContext,
  GitHubSyncResultReason,
  type GitHubSyncResultReason as GitHubSyncResultReasonValue,
} from "./types/github-read-model.ts";
import { normalizeConstValue } from "./types/normalize-const-value.ts";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
  type RepositoryDefaultUnavailableObservation,
  repositoryDefaultAuthorityValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "./types/repository-default-identity.ts";
import { VcsProviderKind } from "./types/vcs-provider-kind.ts";

/**
 * PRs per page of the bundled read (ISS-7891).
 *
 * 25, not the 100 GitHub's connection limit allows, because the query's
 * `statusCheckRollup` blows GitHub's ~10s GraphQL execution budget at 100 and
 * comes back 502/504 — measured against real repositories with an
 * authenticated token:
 *
 *     closedloop-ai  100  11.1s  502      prisma/prisma  50  6.4s  ok
 *     closedloop-ai   50   3.9s  ok       prisma/prisma  25  2.2s  ok
 *     closedloop-ai   25   1.5s  ok       vercel/next.js 25  2.2s  ok
 *
 * 50 is NOT the answer even though it passed: rollup cost scales with
 * checks-per-PR, a property of the repository's CI that we do not control, and
 * prisma already spends 6.4s of the budget there. 25 holds every measured repo
 * near 2s.
 *
 * Rate-limit cost was 1 point at every page size, so this trades no budget —
 * only round trips, which is why the reconciler raises its page count to keep
 * per-tick coverage.
 *
 * ISS-7892 then removed the re-fetching this constant was holding back: the
 * reconcile sweep now stops paging at its watermark and drops the rollup it
 * never persisted, so the page size no longer carries the lane on its own.
 */
export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE = 25;
/** GitHub's own per-connection ceiling; an explicit caller may still ask for it. */
export const GITHUB_BUNDLED_PULL_REQUESTS_MAX_PAGE_SIZE = 100;
/**
 * The default page budget, which exists to make the default ITEM budget
 * reachable — the provider loop stops at whichever bound it hits first.
 *
 * 1 page was enough while a page held 100. At 25 it is not: a caller taking the
 * defaults asked for 100 items and silently received 25, which is how the live
 * repository PR list — `getRepositoryPullRequestsWithMetadata`, which forwards
 * `maxItems`/`maxPages` but never a `pageSize` — started returning 25 rows for a
 * `limit: 30` request (#5898 review). The three defaults are one triple: page
 * size × pages must still reach items.
 */
export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_PAGES = 4;
export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_ITEMS = 100;

/**
 * The node selection shared by the paged bundled read and the by-number
 * self-heal read (ISS-7892), so the two cannot drift into projecting different
 * fields onto the same row.
 */
export const GITHUB_PULL_REQUEST_NODE_FIELDS = `
          id
          databaseId
          number
          title
          url
          state
          isDraft
          additions
          deletions
          changedFiles
          reviewDecision
          createdAt
          closedAt
          mergedAt
          updatedAt
          baseRefName
          headRefName
          headRefOid
          headRepository {
            databaseId
            nameWithOwner
            defaultBranchRef {
              name
            }
          }
          mergeCommit {
            oid
          }
          author {
            login
            __typename
            ... on User { databaseId }
            ... on Bot { databaseId }
            ... on Mannequin { databaseId }
          }`;

const GITHUB_STATUS_CHECK_ROLLUP_SELECTION = `
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }`;

/**
 * The same selection with the check rollup attached, for the point read in
 * `packages/github`. `main` extracted this list independently while ISS-7892
 * was in flight (as `GITHUB_PULL_REQUEST_READ_MODEL_FIELDS`, rollup inlined);
 * both extractions are the same list, so it is composed from the two pieces
 * above rather than restated — a second copy is exactly the drift the split
 * was meant to prevent.
 */
export const GITHUB_PULL_REQUEST_READ_MODEL_FIELDS = `${GITHUB_PULL_REQUEST_NODE_FIELDS}${GITHUB_STATUS_CHECK_ROLLUP_SELECTION}`;

function buildBundledPullRequestsQuery(rollupSelection: string): string {
  return `
  query BundledPullRequests($owner: String!, $repo: String!, $pageSize: Int!, $after: String) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $pageSize, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {${GITHUB_PULL_REQUEST_NODE_FIELDS}${rollupSelection}
        }
      }
    }
  }
`;
}

export const GITHUB_BUNDLED_PULL_REQUESTS_QUERY = buildBundledPullRequestsQuery(
  GITHUB_STATUS_CHECK_ROLLUP_SELECTION
);

/**
 * ISS-7892: the same read with `statusCheckRollup` dropped. Measured against
 * `closedloop-ai/closedloop-ai` at the ISS-7891 page size of 25, 8 pages:
 * 24.9s with the rollup, 14.9s without. The reconcile sweep discards check
 * state entirely (`buildPullRequestDetailUpdate` never writes it), so paying
 * for the rollup there buys nothing.
 */
export const GITHUB_BUNDLED_PULL_REQUESTS_QUERY_WITHOUT_ROLLUP =
  buildBundledPullRequestsQuery("");

export type BundledPullRequestsGraphqlResponse = {
  rateLimit?: {
    cost?: number | null;
    remaining?: number | null;
    resetAt?: string | null;
  } | null;
  repository?: {
    pullRequests?: {
      pageInfo?: {
        hasNextPage?: boolean | null;
        endCursor?: string | null;
      } | null;
      nodes?: BundledPullRequestNode[] | null;
    } | null;
  } | null;
};

export type BundledPullRequestNode = {
  id?: string | null;
  databaseId?: number | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  reviewDecision?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  updatedAt?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  headRepository?: {
    databaseId?: number | null;
    nameWithOwner?: string | null;
    defaultBranchRef?: { name?: string | null } | null;
  } | null;
  mergeCommit?: { oid?: string | null } | null;
  author?: {
    login?: string | null;
    __typename?: string | null;
    databaseId?: number | null;
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
};

/**
 * Build variables for the shared bundled PR query. Target numbers remain a
 * caller-side stop condition because GitHub's repository PR connection cannot
 * filter by arbitrary PR numbers.
 */
export function buildBundledPullRequestsVariables(
  owner: string,
  repo: string,
  _numbers: readonly number[],
  options: GitHubBundledPullRequestsPageOptions = {}
) {
  const normalized = normalizeBundledPullRequestsPageOptions(options);
  const variables: {
    owner: string;
    repo: string;
    pageSize: number;
    after?: string;
  } = {
    owner,
    repo,
    pageSize: normalized.pageSize,
  };
  if (normalized.after) {
    variables.after = normalized.after;
  }
  return variables;
}

export function mapBundledPullRequestsResponse(
  response: BundledPullRequestsGraphqlResponse | null | undefined,
  source: GitHubReadModelSource = GitHubReadModelSource.Provider,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): GitHubBundledPullRequestsResult {
  const pullRequests: GitHubReadModelPullRequest[] = [];
  for (const node of response?.repository?.pullRequests?.nodes ?? []) {
    const mapped = mapPullRequestNode(node, source, repositoryDefaultContext);
    if (mapped) {
      pullRequests.push(mapped);
    }
  }
  const pageInfo = mapReadModelPageInfo(
    response?.repository?.pullRequests?.pageInfo
  );

  return {
    pullRequests,
    rateLimit: mapRateLimitBudget(response?.rateLimit ?? null),
    pageInfo,
    hasMore: pageInfo.hasNextPage,
    truncated: pageInfo.hasNextPage,
    nextCursor: pageInfo.endCursor,
    fetchedPages: 1,
    stopReason: pageInfo.hasNextPage
      ? GitHubBundledPullRequestsStopReason.PageLimit
      : GitHubBundledPullRequestsStopReason.Complete,
  };
}

export function mapPullRequestNode(
  node: BundledPullRequestNode | null | undefined,
  source: GitHubReadModelSource,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): GitHubReadModelPullRequest | null {
  if (!(node?.id && typeof node.number === "number" && node.url)) {
    return null;
  }

  const headRepository = mapGraphqlHeadRepository(
    node.headRepository,
    repositoryDefaultContext
  );
  return {
    githubId: resolveRestPullRequestId(node),
    number: node.number,
    title: node.title ?? `Pull request #${node.number}`,
    htmlUrl: node.url,
    headBranch: node.headRefName ?? "",
    baseBranch: node.baseRefName ?? "",
    headSha: node.headRefOid ?? null,
    state: mapProviderPullRequestState(node.state, node.mergedAt),
    isDraft: node.isDraft ?? false,
    additions: normalizeOptionalNumber(node.additions),
    deletions: normalizeOptionalNumber(node.deletions),
    changedFiles: normalizeOptionalNumber(node.changedFiles),
    reviewDecision: mapProviderReviewDecision(node.reviewDecision),
    checksStatus: mapProviderChecksStatus(
      node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state ?? null
    ),
    statusCheckRollup:
      node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state ?? null,
    openedAt: normalizeProviderTimestamp(node.createdAt),
    closedAt: normalizeOptionalString(node.closedAt),
    mergedAt: normalizeOptionalString(node.mergedAt),
    mergeCommitSha: normalizeOptionalString(node.mergeCommit?.oid),
    updatedAt: normalizeOptionalString(node.updatedAt),
    author: normalizeOptionalString(node.author?.login),
    ...mapReadModelAuthorIdentity(node.author),
    source,
    ...(headRepository.authority === undefined
      ? {}
      : { headRepository: headRepository.authority }),
    ...(headRepository.unavailable === undefined
      ? {}
      : {
          headRepositoryUnavailable: headRepository.unavailable,
        }),
  };
}

function resolveRestPullRequestId(node: BundledPullRequestNode): string {
  return typeof node.databaseId === "number" && Number.isFinite(node.databaseId)
    ? String(node.databaseId)
    : (node.id ?? "");
}

export function resolveMergedPullRequestState(
  input: GitHubMergedPredicateInput
): GitHubPRState | null {
  if (input.connected && input.githubState) {
    return input.githubState;
  }
  return input.localState ?? input.githubState ?? null;
}

export function isPullRequestMerged(
  input: GitHubMergedPredicateInput
): boolean {
  return resolveMergedPullRequestState(input) === GitHubPRState.Merged;
}

export function mapRateLimitBudget(
  value: {
    cost?: number | null;
    remaining?: number | null;
    resetAt?: string | null;
  } | null
): GitHubRateLimitBudget {
  const remaining =
    typeof value?.remaining === "number" && Number.isFinite(value.remaining)
      ? value.remaining
      : null;
  const cost =
    typeof value?.cost === "number" && Number.isFinite(value.cost)
      ? value.cost
      : null;
  return {
    cost,
    remaining,
    resetAt: normalizeOptionalString(value?.resetAt),
    state: resolveBudgetState(remaining),
  };
}

/**
 * Normalize optional persisted provenance values. Legacy rows may have null or
 * absent values, and newer peers may send values this version does not know.
 */
export function normalizeGitHubFetchCredentialType(
  value: unknown
): GitHubFetchCredentialTypeValue {
  return normalizeConstValue(value, GitHubFetchCredentialType);
}

export function normalizeGitHubFetchMechanism(
  value: unknown
): GitHubFetchMechanismValue {
  return normalizeConstValue(value, GitHubFetchMechanism);
}

export function normalizeGitHubFetchTrigger(
  value: unknown
): GitHubFetchTriggerValue {
  return normalizeConstValue(value, GitHubFetchTrigger);
}

export function normalizeGitHubSyncResultReason(
  value: unknown
): GitHubSyncResultReasonValue {
  return normalizeConstValue(value, GitHubSyncResultReason);
}

export function normalizeBundledPullRequestsPageOptions(
  options: GitHubBundledPullRequestsPageOptions = {}
): Required<GitHubBundledPullRequestsPageOptions> {
  const pageSize = clampPositiveInteger(
    options.pageSize,
    GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
    GITHUB_BUNDLED_PULL_REQUESTS_MAX_PAGE_SIZE
  );
  const maxPages = clampPositiveInteger(
    options.maxPages,
    GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_PAGES
  );
  const maxItems = clampPositiveInteger(
    options.maxItems,
    GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_ITEMS
  );
  return {
    pageSize,
    after: normalizeOptionalString(options.after),
    maxPages,
    maxItems,
    targetNumbers: normalizeTargetNumbers(options.targetNumbers),
    stopAtUpdatedAt: normalizeOptionalString(options.stopAtUpdatedAt),
    includeStatusCheckRollup: options.includeStatusCheckRollup !== false,
  };
}

export function mergeBundledPullRequestsResults(
  pages: readonly GitHubBundledPullRequestsResult[],
  options: GitHubBundledPullRequestsPageOptions = {},
  stopReason?: GitHubBundledPullRequestsStopReason
): GitHubBundledPullRequestsResult {
  const normalized = normalizeBundledPullRequestsPageOptions(options);
  const pullRequests = dedupePullRequestsByNumber(
    pages.flatMap((page) => page.pullRequests)
  );
  const latest = pages.at(-1);
  const pageInfo = latest?.pageInfo ?? emptyPageInfo();
  const missingTargetNumbers = findMissingTargetNumbers(
    normalized.targetNumbers,
    pullRequests
  );
  const resolvedStopReason =
    stopReason ??
    resolveBundledPullRequestsStopReason({
      pageInfo,
      fetchedPages: pages.length,
      pullRequestCount: pullRequests.length,
      maxPages: normalized.maxPages,
      maxItems: normalized.maxItems,
      targetNumberCount: normalized.targetNumbers.length,
      missingTargetNumbers,
    });
  const hasMore = pageInfo.hasNextPage;

  return {
    pullRequests,
    rateLimit: latest?.rateLimit ?? mapRateLimitBudget(null),
    pageInfo,
    hasMore,
    truncated:
      hasMore ||
      !(
        resolvedStopReason === GitHubBundledPullRequestsStopReason.Complete ||
        resolvedStopReason === GitHubBundledPullRequestsStopReason.TargetFound
      ),
    nextCursor: pageInfo.endCursor,
    fetchedPages: pages.length,
    stopReason: resolvedStopReason,
    targetNumbers: [...normalized.targetNumbers],
    missingTargetNumbers,
  };
}

export function bundledPullRequestsFoundAllTargets(
  pullRequests: readonly GitHubReadModelPullRequest[],
  targetNumbers: readonly number[]
): boolean {
  return findMissingTargetNumbers(targetNumbers, pullRequests).length === 0;
}

const LOW_GRAPHQL_BUDGET_REMAINING = 250;
const GH_ZERO_TIME = "0001-01-01T00:00:00Z";

function mapGraphqlHeadRepository(
  repository: BundledPullRequestNode["headRepository"],
  context: GitHubRepositoryDefaultObservationContext | undefined
): {
  authority?: RepositoryDefaultAuthority;
  unavailable?: RepositoryDefaultUnavailableObservation;
} {
  if (context === undefined) {
    return {};
  }
  if (repository === null || repository === undefined) {
    return mapGraphqlHeadRepositoryUnavailable(
      RepositoryDefaultReason.NotReported,
      context
    );
  }

  const providerRepositoryId = normalizeProviderRepositoryId(
    repository.databaseId
  );
  const fullName = normalizeOptionalString(repository.nameWithOwner);
  if (!(providerRepositoryId && fullName)) {
    return mapGraphqlHeadRepositoryUnavailable(
      RepositoryDefaultReason.Malformed,
      context
    );
  }

  const defaultBranch = normalizeOptionalString(
    repository.defaultBranchRef?.name
  );
  const parsed = repositoryDefaultAuthorityValidator.safeParse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence:
      defaultBranch === null
        ? {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason: RepositoryDefaultReason.NotReported,
          }
        : {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch,
          },
    provenance: {
      source: RepositoryDefaultSource.PullRequestGraphql,
      ...context,
    },
  });
  if (!parsed.success) {
    return mapGraphqlHeadRepositoryUnavailable(
      RepositoryDefaultReason.Malformed,
      context
    );
  }
  return { authority: parsed.data };
}

function mapGraphqlHeadRepositoryUnavailable(
  reason: RepositoryDefaultReason,
  context: GitHubRepositoryDefaultObservationContext
): { unavailable?: RepositoryDefaultUnavailableObservation } {
  const parsed = repositoryDefaultUnavailableObservationValidator.safeParse({
    reason,
    provenance: {
      source: RepositoryDefaultSource.PullRequestGraphql,
      ...context,
    },
  });
  return parsed.success ? { unavailable: parsed.data } : {};
}

function normalizeProviderRepositoryId(value: number | null | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function mapProviderPullRequestState(
  state: string | null | undefined,
  mergedAt: string | null | undefined
): GitHubPRState {
  if (mergedAt) {
    return GitHubPRState.Merged;
  }

  switch (state) {
    case GitHubPRState.Open:
      return GitHubPRState.Open;
    case GitHubPRState.Merged:
      return GitHubPRState.Merged;
    case GitHubPRState.Closed:
      return GitHubPRState.Closed;
    default:
      return GitHubPRState.Open;
  }
}

function mapProviderReviewDecision(
  value: string | null | undefined
): ReviewDecision | null {
  switch (value) {
    case ReviewDecision.Approved:
      return ReviewDecision.Approved;
    case ReviewDecision.ChangesRequested:
      return ReviewDecision.ChangesRequested;
    case ReviewDecision.Commented:
      return ReviewDecision.Commented;
    case ReviewDecision.Dismissed:
      return ReviewDecision.Dismissed;
    default:
      return null;
  }
}

function mapProviderChecksStatus(
  value: string | null | undefined
): ChecksStatus | null {
  switch (value) {
    case "SUCCESS":
      return ChecksStatus.Passing;
    case "FAILURE":
    case "ERROR":
      return ChecksStatus.Failing;
    case "PENDING":
    case "EXPECTED":
      return ChecksStatus.Pending;
    default:
      return null;
  }
}

function normalizeOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeProviderTimestamp(value: string | null | undefined) {
  if (value === GH_ZERO_TIME) {
    return null;
  }
  return normalizeOptionalString(value);
}

function normalizeOptionalNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapReadModelPageInfo(
  value:
    | {
        hasNextPage?: boolean | null;
        endCursor?: string | null;
      }
    | null
    | undefined
): GitHubReadModelPageInfo {
  return {
    hasNextPage: value?.hasNextPage === true,
    endCursor: normalizeOptionalString(value?.endCursor),
  };
}

function emptyPageInfo(): GitHubReadModelPageInfo {
  return { hasNextPage: false, endCursor: null };
}

function normalizeTargetNumbers(value: readonly number[] | undefined) {
  const seen = new Set<number>();
  const targetNumbers: number[] = [];
  for (const number of value ?? []) {
    if (Number.isInteger(number) && number > 0 && !seen.has(number)) {
      seen.add(number);
      targetNumbers.push(number);
    }
  }
  return targetNumbers;
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  ceiling = Number.MAX_SAFE_INTEGER
) {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.trunc(value)), ceiling);
}

function dedupePullRequestsByNumber(
  pullRequests: readonly GitHubReadModelPullRequest[]
) {
  const seen = new Set<number>();
  const deduped: GitHubReadModelPullRequest[] = [];
  for (const pullRequest of pullRequests) {
    if (seen.has(pullRequest.number)) {
      continue;
    }
    seen.add(pullRequest.number);
    deduped.push(pullRequest);
  }
  return deduped;
}

function findMissingTargetNumbers(
  targetNumbers: readonly number[],
  pullRequests: readonly GitHubReadModelPullRequest[]
) {
  if (targetNumbers.length === 0) {
    return [];
  }
  const foundNumbers = new Set(
    pullRequests.map((pullRequest) => pullRequest.number)
  );
  return targetNumbers.filter((number) => !foundNumbers.has(number));
}

function resolveBundledPullRequestsStopReason(input: {
  pageInfo: GitHubReadModelPageInfo;
  fetchedPages: number;
  pullRequestCount: number;
  maxPages: number;
  maxItems: number;
  targetNumberCount: number;
  missingTargetNumbers: readonly number[];
}): GitHubBundledPullRequestsStopReason {
  if (!input.pageInfo.hasNextPage) {
    return GitHubBundledPullRequestsStopReason.Complete;
  }
  if (input.targetNumberCount > 0 && input.missingTargetNumbers.length === 0) {
    return GitHubBundledPullRequestsStopReason.TargetFound;
  }
  if (input.pullRequestCount >= input.maxItems) {
    return GitHubBundledPullRequestsStopReason.ItemLimit;
  }
  if (input.fetchedPages >= input.maxPages) {
    return GitHubBundledPullRequestsStopReason.PageLimit;
  }
  throw new Error(
    [
      "Unable to resolve bundled pull requests stop reason",
      `hasNextPage=${input.pageInfo.hasNextPage}`,
      `fetchedPages=${input.fetchedPages}`,
      `maxPages=${input.maxPages}`,
      `pullRequestCount=${input.pullRequestCount}`,
      `maxItems=${input.maxItems}`,
      `targetNumberCount=${input.targetNumberCount}`,
      `missingTargetNumberCount=${input.missingTargetNumbers.length}`,
    ].join("; ")
  );
}

function resolveBudgetState(
  remaining: number | null
): GitHubProviderBudgetState {
  if (remaining === null) {
    return GitHubProviderBudgetState.Unknown;
  }
  if (remaining <= LOW_GRAPHQL_BUDGET_REMAINING) {
    return GitHubProviderBudgetState.Low;
  }
  return GitHubProviderBudgetState.Available;
}

/**
 * ISS-7892: has this page reached PRs the caller has already processed?
 *
 * Sound only because the connection is ordered UPDATED_AT DESC — the first row
 * at or older than the watermark proves every later page is older still. A row
 * with no `updatedAt` counts as NOT reached: its position is unknown, and a
 * gap-repair read must never truncate itself on a row it cannot place. (The
 * reconciler's cursor guard is conservative in the opposite direction, refusing
 * to persist a continuation it cannot justify; neither guesses.)
 *
 * A row whose `updated_at` is bumped mid-pagination can slip past a cursor, as
 * with any keyset read over a mutating sort key. It cannot be lost: a stop here
 * leaves the page mixed, so the reconciler persists no continuation and the next
 * tick restarts from the newest PR — where that row now sorts above the stored
 * watermark. The exposure is one tick of staleness on a background lane.
 */
export function bundledPullRequestsReachedWatermark(
  pullRequests: readonly GitHubReadModelPullRequest[],
  stopAtUpdatedAt: string | null
): boolean {
  if (!stopAtUpdatedAt) {
    return false;
  }
  const watermark = Date.parse(stopAtUpdatedAt);
  if (Number.isNaN(watermark)) {
    return false;
  }
  return pullRequests.some((pullRequest) => {
    if (pullRequest.updatedAt === null) {
      return false;
    }
    const updatedAt = Date.parse(pullRequest.updatedAt);
    return !Number.isNaN(updatedAt) && updatedAt <= watermark;
  });
}

function mapReadModelAuthorIdentity(author: BundledPullRequestNode["author"]) {
  const authorProviderUserId = normalizeGitHubProviderUserId(
    author?.databaseId
  );
  const authorActorType = normalizeGitHubActorType(author?.__typename);
  return {
    ...(authorProviderUserId === undefined ? {} : { authorProviderUserId }),
    ...(authorActorType === undefined ? {} : { authorActorType }),
  };
}
