import { ChecksStatus, ReviewDecision } from "./types/branch-checks.ts";
import { GitHubPRState } from "./types/github.ts";
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
  GitHubSyncResultReason,
  type GitHubSyncResultReason as GitHubSyncResultReasonValue,
} from "./types/github-read-model.ts";

export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE = 100;
export const GITHUB_BUNDLED_PULL_REQUESTS_MAX_PAGE_SIZE = 100;
export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_PAGES = 1;
export const GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_ITEMS = 100;

export const GITHUB_BUNDLED_PULL_REQUESTS_QUERY = `
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
        nodes {
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
          mergeCommit {
            oid
          }
          author {
            login
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

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
  mergeCommit?: { oid?: string | null } | null;
  author?: { login?: string | null } | null;
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
  source: GitHubReadModelSource = GitHubReadModelSource.Provider
): GitHubBundledPullRequestsResult {
  const pullRequests: GitHubReadModelPullRequest[] = [];
  for (const node of response?.repository?.pullRequests?.nodes ?? []) {
    const mapped = mapPullRequestNode(node, source);
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
  source: GitHubReadModelSource
): GitHubReadModelPullRequest | null {
  if (!(node?.id && typeof node.number === "number" && node.url)) {
    return null;
  }

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
    source,
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

function normalizeConstValue<Value extends string>(
  value: unknown,
  values: Record<string, Value> & { Unknown: Value }
): Value {
  const knownValues = Object.values(values) as Value[];
  const matchedValue =
    typeof value === "string"
      ? knownValues.find((knownValue) => knownValue === value)
      : undefined;
  return matchedValue ?? values.Unknown;
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
