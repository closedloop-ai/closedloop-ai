import type { Octokit } from "@octokit/rest";
import {
  type BundledPullRequestNode,
  GITHUB_PULL_REQUEST_READ_MODEL_FIELDS,
  mapPullRequestNode,
  mapRateLimitBudget,
} from "@repo/api/src/github-read-model";
import type {
  GitHubBundledPullRequestsObserver,
  GitHubBundledPullRequestsResult,
  GitHubRateLimitBudget,
  GitHubReadModelPullRequest,
  GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { log } from "@repo/observability/log";
import {
  classifyRepositoryAccessFailure,
  recoverPartialGraphqlEnvelope,
  toGitHubProviderFailure,
} from "./provider-error-classification";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "./provider-result";

/** PRD-683 P0-A: batch point reads by PR number without scanning repo history. */
export const GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE = 25;

export type GitHubPullRequestsByNumberResult =
  GitHubBundledPullRequestsResult & {
    /** Numbers included in an actual provider query. */
    attemptedNumbers: number[];
    /** Attempted numbers proven absent from a reachable repository. */
    missingNumbers: number[];
    /** Normalized targets skipped because the shared GraphQL budget went low. */
    unattemptedNumbers: number[];
  };

type PullRequestsByNumberGraphqlResponse = {
  rateLimit?: {
    cost?: number | null;
    remaining?: number | null;
    resetAt?: string | null;
  } | null;
  repository?: Record<string, BundledPullRequestNode | null | undefined> | null;
};

/** Fetch session-linked PR numbers directly from `repository.pullRequest(number:)`. */
export async function getRepositoryPullRequestsByNumberWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: readonly number[],
  observer?: GitHubBundledPullRequestsObserver,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<GitHubProviderResult<GitHubPullRequestsByNumberResult>> {
  const normalizedNumbers = normalizePullRequestNumbers(numbers);
  if (normalizedNumbers.length === 0) {
    return {
      status: GitHubProviderResultStatus.Success,
      value: emptyPullRequestsByNumberResult(),
    };
  }

  const pullRequests: GitHubReadModelPullRequest[] = [];
  const attemptedNumbers: number[] = [];
  const missingNumbers: number[] = [];
  let rateLimit: GitHubRateLimitBudget = mapRateLimitBudget(null);
  let stopReason: GitHubBundledPullRequestsStopReason =
    GitHubBundledPullRequestsStopReason.Complete;

  for (
    let offset = 0;
    offset < normalizedNumbers.length;
    offset += GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE
  ) {
    const batchNumbers = normalizedNumbers.slice(
      offset,
      offset + GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE
    );
    let response: PullRequestsByNumberGraphqlResponse;
    let transientNumbers: ReadonlySet<number> = EMPTY_TRANSIENT_NUMBERS;
    try {
      response = await octokit.graphql<PullRequestsByNumberGraphqlResponse>(
        buildPullRequestsByNumberQuery(batchNumbers.length),
        buildPullRequestsByNumberVariables(owner, repo, batchNumbers)
      );
    } catch (error) {
      // ISS-8287, and the resolver order is the sibling single-shot read's
      // (`pull-requests-by-number.ts`): repo-access, then rate limit, then
      // partial. A repo this credential cannot reach also answers a partial
      // SHAPE, so recovering first would report "nothing to heal" for a repo we
      // cannot see; a rate limit outranks recovery because stamping every
      // requested number as attempted would debounce the ones the limit stopped
      // us from resolving.
      //
      // What is left is the case this batch read could not survive before: one
      // deleted PR makes GitHub answer 200 with every OTHER alias populated and
      // an `errors[]` entry for that one, and octokit throws on it. Discarding
      // the throw failed all 25 co-batched numbers because one was gone — on
      // every tick, forever — and never recorded the gone one as missing.
      const repositoryAccessFailure = classifyRepositoryAccessFailure(
        error,
        attemptedNumbers.length > 0 ? 1 : 0
      );
      if (repositoryAccessFailure) {
        return repositoryAccessFailure;
      }
      const failure = toGitHubProviderFailure(error);
      if (failure.status === GitHubProviderResultStatus.ProviderRateLimit) {
        return failure;
      }
      const partial = recoverPartialPullRequests(error);
      if (!partial) {
        return failure;
      }
      log.warn("[github/pull-request-point-read] recovered from partial data", {
        owner,
        repo,
        batchSize: batchNumbers.length,
        graphqlErrorCount: partial.errors.length,
      });
      transientNumbers = transientlyUnresolvedNumbers(
        partial.errors,
        batchNumbers,
        partial.data
      );
      response = partial.data;
    }
    // An alias GitHub failed on for a TRANSIENT reason was not read, so it is
    // neither attempted nor missing — it stays unattempted and gets retried.
    // Only an alias that resolved to nothing with no error, or with a
    // `NOT_FOUND`, is "proven absent from a reachable repository", which is what
    // `missingNumbers` claims and what debounces the target downstream.
    attemptedNumbers.push(
      ...batchNumbers.filter((number) => !transientNumbers.has(number))
    );
    rateLimit = observedRateLimit(response, rateLimit);
    // The FULL batch, so alias indices still line up with their numbers.
    const batchPullRequests = mapPullRequestsByNumberBatch(
      response,
      batchNumbers,
      repositoryDefaultContext
    );
    pullRequests.push(...batchPullRequests.pullRequests);
    missingNumbers.push(
      ...batchPullRequests.missingNumbers.filter(
        (number) => !transientNumbers.has(number)
      )
    );
    observer?.({
      page: offset / GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
      itemCount: batchPullRequests.pullRequests.length,
      rateLimit,
    });
    const hasRemaining =
      offset + GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE <
      normalizedNumbers.length;
    if (hasRemaining && rateLimit.state === GitHubProviderBudgetState.Low) {
      stopReason = GitHubBundledPullRequestsStopReason.BudgetLow;
      break;
    }
  }

  const returnedNumbers = new Set(pullRequests.map((pr) => pr.number));
  const missingTargetNumbers = normalizedNumbers.filter(
    (number) => !returnedNumbers.has(number)
  );
  const unattemptedNumbers = normalizedNumbers.filter(
    (number) => !attemptedNumbers.includes(number)
  );

  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests,
      rateLimit,
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: unattemptedNumbers.length > 0,
      nextCursor: null,
      fetchedPages: Math.ceil(
        attemptedNumbers.length / GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE
      ),
      stopReason,
      targetNumbers: normalizedNumbers,
      missingTargetNumbers,
      attemptedNumbers,
      missingNumbers,
      unattemptedNumbers,
    },
  };
}

/** Legacy nullable wrapper for callers that do not need the failure discriminant. */
export async function getRepositoryPullRequestsByNumber(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: readonly number[],
  observer?: GitHubBundledPullRequestsObserver,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<GitHubPullRequestsByNumberResult | null> {
  const result = await getRepositoryPullRequestsByNumberWithProviderResult(
    octokit,
    owner,
    repo,
    numbers,
    observer,
    repositoryDefaultContext
  );
  return result.status === GitHubProviderResultStatus.Success
    ? result.value
    : null;
}

function mapPullRequestsByNumberBatch(
  response: PullRequestsByNumberGraphqlResponse,
  numbers: readonly number[],
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): {
  pullRequests: GitHubReadModelPullRequest[];
  missingNumbers: number[];
} {
  const pullRequests: GitHubReadModelPullRequest[] = [];
  const missingNumbers: number[] = [];
  for (const [index, number] of numbers.entries()) {
    const mapped = mapPullRequestNode(
      response.repository?.[pullRequestAlias(index)],
      GitHubReadModelSource.Provider,
      repositoryDefaultContext
    );
    if (mapped) {
      pullRequests.push(mapped);
      continue;
    }
    missingNumbers.push(number);
  }
  return { pullRequests, missingNumbers };
}

function buildPullRequestsByNumberQuery(count: number): string {
  const variables = Array.from(
    { length: count },
    (_, index) => `$${pullRequestAlias(index)}: Int!`
  ).join(", ");
  const selections = Array.from(
    { length: count },
    (
      _,
      index
    ) => `${pullRequestAlias(index)}: pullRequest(number: $${pullRequestAlias(index)}) {
      ${GITHUB_PULL_REQUEST_READ_MODEL_FIELDS}
    }`
  ).join("\n");
  return `
    query PullRequestsByNumber($owner: String!, $repo: String!, ${variables}) {
      rateLimit {
        cost
        remaining
        resetAt
      }
      repository(owner: $owner, name: $repo) {
        ${selections}
      }
    }
  `;
}

function buildPullRequestsByNumberVariables(
  owner: string,
  repo: string,
  numbers: readonly number[]
): Record<string, string | number> {
  const variables: Record<string, string | number> = { owner, repo };
  for (const [index, number] of numbers.entries()) {
    variables[pullRequestAlias(index)] = number;
  }
  return variables;
}

function normalizePullRequestNumbers(numbers: readonly number[]): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const number of numbers) {
    if (!(Number.isSafeInteger(number) && number > 0)) {
      continue;
    }
    if (seen.has(number)) {
      continue;
    }
    seen.add(number);
    normalized.push(number);
  }
  return normalized;
}

function emptyPullRequestsByNumberResult(): GitHubPullRequestsByNumberResult {
  return {
    pullRequests: [],
    rateLimit: mapRateLimitBudget(null),
    pageInfo: { hasNextPage: false, endCursor: null },
    hasMore: false,
    truncated: false,
    nextCursor: null,
    fetchedPages: 0,
    stopReason: GitHubBundledPullRequestsStopReason.Complete,
    targetNumbers: [],
    missingTargetNumbers: [],
    attemptedNumbers: [],
    missingNumbers: [],
    unattemptedNumbers: [],
  };
}

function pullRequestAlias(index: number): string {
  return `pr${index}`;
}

/**
 * A pull request that no longer resolves — deleted, or moved out of reach —
 * makes GitHub answer HTTP 200 with every OTHER alias populated plus an
 * `errors[]` entry for that one, and octokit throws on the errors.
 *
 * The targeted reconciler batches up to
 * {@link GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE} session-linked numbers
 * through one call, so discarding that response is a starvation bug: one gone PR
 * blocks its co-batched numbers from being refreshed on every tick, and the gone
 * one is never recorded as missing either. Recovering the payload maps the
 * aliases that DID resolve and leaves only the unresolved ones in
 * `missingNumbers` — the same salvage `pull-requests-by-number.ts` performs.
 */
function recoverPartialPullRequests(error: unknown) {
  return recoverPartialGraphqlEnvelope(error, isPullRequestsByNumberResponse);
}

function isPullRequestsByNumberResponse(
  value: unknown
): value is PullRequestsByNumberGraphqlResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { repository?: unknown }).repository === "object" &&
    (value as { repository?: unknown }).repository !== null
  );
}

/** Matches the `prN` aliases {@link pullRequestAlias} builds. */
const PULL_REQUEST_ALIAS_PATTERN = /^pr(\d+)$/;

/** GitHub's per-field error type meaning the node genuinely does not exist. */
const NOT_FOUND_GRAPHQL_ERROR_TYPE = "NOT_FOUND";

const EMPTY_TRANSIENT_NUMBERS: ReadonlySet<number> = new Set();

/**
 * Keep the budget we actually OBSERVED.
 *
 * A recovered partial can carry the aliases without the `rateLimit` root, and
 * overwriting a real measurement with `Unknown` loses the budget this call
 * genuinely saw — which would also stop the `BudgetLow` break firing for the
 * remaining batches. An absent budget is "not observed", not "unknown now".
 */
function observedRateLimit(
  response: PullRequestsByNumberGraphqlResponse,
  previous: GitHubRateLimitBudget
): GitHubRateLimitBudget {
  return response.rateLimit ? mapRateLimitBudget(response.rateLimit) : previous;
}

/**
 * The batch's numbers whose alias GitHub answered with a per-field error that is
 * NOT "this pull request does not exist".
 *
 * `INTERNAL`, `SERVICE_UNAVAILABLE` and a per-node `FORBIDDEN` all produce the
 * same HTTP 200 + populated `data` + `errors[]` shape as a deleted PR, and the
 * alias is null in `data` either way — so without reading the error entry, a
 * transient failure is indistinguishable from an absence. Reporting one as
 * `missingNumbers` makes the reconciler stamp `lastRefreshAttemptAt` on a PR
 * nothing was read for and debounce its next refresh, which is the same class of
 * false measurement the rate-limit branch above is deliberately excluded for.
 *
 * GraphQL makes an error's `path` optional, so an entry can name no alias at
 * all (whitlockk on #8018). Such an entry keeps EVERY null alias in the batch
 * unattempted rather than attributing to nobody — the same rule
 * `refusedPullRequestNodes` applies to a refusal that names no node. The
 * aliases that did resolve are still real readings and stay attempted.
 */
function transientlyUnresolvedNumbers(
  errors: readonly unknown[],
  batchNumbers: readonly number[],
  response: PullRequestsByNumberGraphqlResponse
): ReadonlySet<number> {
  const unresolved = new Set<number>();
  for (const entry of errors) {
    if (graphqlErrorType(entry) === NOT_FOUND_GRAPHQL_ERROR_TYPE) {
      continue;
    }
    const numbers = aliasedNumbers(entry, batchNumbers);
    if (numbers.length === 0) {
      return new Set(
        batchNumbers.filter(
          (_, index) => response.repository?.[pullRequestAlias(index)] == null
        )
      );
    }
    for (const number of numbers) {
      unresolved.add(number);
    }
  }
  return unresolved;
}

function graphqlErrorType(entry: unknown): string | null {
  const type = (entry as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : null;
}

/** The batch numbers an error entry's `path` points at, via its `prN` alias. */
function aliasedNumbers(
  entry: unknown,
  batchNumbers: readonly number[]
): number[] {
  const path = (entry as { path?: unknown } | null)?.path;
  if (!Array.isArray(path)) {
    return [];
  }
  const numbers: number[] = [];
  for (const segment of path) {
    if (typeof segment !== "string") {
      continue;
    }
    const match = PULL_REQUEST_ALIAS_PATTERN.exec(segment);
    if (!match) {
      continue;
    }
    const index = Number.parseInt(match[1] ?? "", 10);
    const number = Number.isSafeInteger(index)
      ? batchNumbers[index]
      : undefined;
    if (typeof number === "number") {
      numbers.push(number);
    }
  }
  return numbers;
}
