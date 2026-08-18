import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import {
  type BundledPullRequestsGraphqlResponse,
  buildBundledPullRequestsVariables,
  bundledPullRequestsFoundAllTargets,
  GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
  mapBundledPullRequestsResponse,
  mergeBundledPullRequestsResults,
  normalizeBundledPullRequestsPageOptions,
} from "@repo/api/src/github-read-model";
import {
  type BranchViewCheck,
  BranchViewCheckKind,
} from "@repo/api/src/types/branch-view";
import type { GitHubContributor } from "@repo/api/src/types/github";
import type {
  GitHubBundledPullRequestsObserver,
  GitHubBundledPullRequestsPageOptions,
  GitHubBundledPullRequestsResult,
  GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  StatusCheckRollupFailureReason,
  type StatusCheckRollupState,
} from "@repo/api/src/types/github-status";
import { log } from "@repo/observability/log";
import {
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  mapGitHubPullRequestReviewAuthor,
  mapPullRequestIssueComment,
  mapPullRequestReviewComment,
} from "./comment-payloads";
import {
  getInstallationAccessToken as getInstallationAccessTokenForInstallation,
  getInstallationOctokit,
} from "./installation-auth";
import { keys, webhookSecretKeys } from "./keys";
import {
  classifyBundledRepositoryAccessFailure,
  classifyGitHubProviderError,
  toGitHubProviderFailure,
  toGitHubUserTokenProviderFailure,
} from "./provider-error-classification";
import {
  getStatusCheckDedupeKey,
  hashProviderKey,
  normalizeProviderStatus,
  normalizeProviderText,
  parseProviderTimestamp,
  sanitizeProviderUrl,
} from "./provider-field-normalize";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  type GitHubUserTokenProviderResult,
} from "./provider-result";
import {
  GITHUB_PULL_REQUEST_REST_HEADERS,
  type GitHubPullRequestRestAuthorityObservation,
  type GitHubSinglePullRequestResult,
  mapSinglePullRequestResponse,
} from "./pull-request-rest";
import {
  mapRepositoryPullRequest,
  normalizeRepositoryPullRequestListLimit,
  type RepositoryPullRequestListItem as RepositoryPullRequestListItemShape,
  repositoryPullRequestMatchesState,
  selectRepositoryPullRequestsForList,
} from "./repository-pull-request-list";
import {
  fetchReviewThreadMetadataByCommentId,
  MAX_PR_METADATA_PAGES,
} from "./review-thread-lookup";

export type {
  CreatePullRequestReviewCommentWithUserTokenInput,
  GitHubCommentAuthor,
  GitHubPullRequestIssueComment,
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
} from "./comment-payloads";
// biome-ignore lint/performance/noBarrelFile: packages/github/index.ts is the package API surface.
export {
  createPullRequestIssueCommentWithUserToken,
  createPullRequestReviewCommentWithUserToken,
  createReplyForReviewCommentWithUserToken,
  deletePullRequestIssueCommentWithUserToken,
  deletePullRequestReviewCommentWithUserToken,
  resolvePullRequestReviewThreadWithUserToken,
  unresolvePullRequestReviewThreadWithUserToken,
  updatePullRequestIssueCommentWithUserToken,
  updatePullRequestReviewCommentWithUserToken,
} from "./comment-user-token";
export {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  type GitHubUserTokenProviderResult,
  GitHubUserTokenProviderResultStatus,
} from "./provider-result";
export type {
  GitHubPullRequestRestAuthorityObservation,
  GitHubSinglePullRequestResult,
} from "./pull-request-rest";

// Top-level regex for performance
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const CHECK_RUN_DEDUPE_PRIORITY = 0;
const STATUS_CONTEXT_DEDUPE_PRIORITY = 1;

// Lazy config getter - only validates when actually called at runtime
let _config: ReturnType<typeof keys> | null = null;
function getConfig() {
  if (!_config) {
    _config = keys();
  }
  return _config;
}

// Lazy installation-repo parser. GITHUB_APP_DISPATCH_REPO names the
// owner/repo whose GitHub App installation backs app-authenticated reads.
function getDispatchRepo() {
  const config = getConfig();
  return config.GITHUB_APP_DISPATCH_REPO.split("/") as [string, string];
}

/**
 * Create an authenticated Octokit instance using the GitHub App installation token.
 * Resolves the installation for the configured app-installation repo
 * (`GITHUB_APP_DISPATCH_REPO`) and mints a fresh installation token. Used for
 * app-owned reads such as the Desktop release lookup.
 */
export async function getAuthenticatedOctokit(): Promise<Octokit> {
  const config = getConfig();
  const [dispatchOwner, dispatchRepo] = getDispatchRepo();

  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });

  // Get installation ID for the dispatch repo
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    },
  });

  const { data: installation } = await appOctokit.apps.getRepoInstallation({
    owner: dispatchOwner,
    repo: dispatchRepo,
  });

  // Create installation-authenticated Octokit
  const installationAuth = await auth({
    type: "installation",
    installationId: installation.id,
  });

  return new Octokit({
    auth: installationAuth.token,
  });
}

/**
 * Verify GitHub webhook signature using HMAC SHA-256.
 *
 * Resolves the webhook secret through the scoped `webhookSecretKeys()`
 * validator rather than the full `keys()` schema, so verification depends only
 * on the webhook secret and does not transitively require unrelated GitHub App
 * config (OAuth client id/secret, the App installation repo) in partial-config
 * environments. The webhook route gates on `isGitHubConfigured()` before
 * calling this, so the secret is present on the live path.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const { GITHUB_APP_WEBHOOK_SECRET } = webhookSecretKeys();
  const expectedSignature = createHmac("sha256", GITHUB_APP_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  const providedSignature = signature.slice(7); // Remove "sha256=" prefix

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature, "hex"),
      Buffer.from(providedSignature, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Delete (uninstall) a GitHub App installation.
 * This requires JWT authentication (app-level), not installation token.
 * @see https://docs.github.com/en/rest/apps/apps#delete-an-installation-for-the-authenticated-app
 */
export async function deleteInstallation(
  installationId: string
): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();

  try {
    // Create app-level authenticated Octokit (JWT, not installation token)
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
      },
    });

    await appOctokit.apps.deleteInstallation({
      installation_id: Number.parseInt(installationId, 10),
    });

    log.info("[github/app] Deleted installation", { installationId });
    return { success: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/app] Failed to delete installation", {
      installationId,
      error: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * Get branches for a GitHub repository using GitHub GraphQL API with the
 * caller's client. Fetches up to 100 branches, sorted by committedDate
 * descending. Returns the top `limit` branches with the provider-reported
 * default branch pinned at position 0. A missing default branch is preserved
 * as unavailable rather than inferred from a conventional branch name.
 *
 * @param octokit - The caller's GitHub client
 * @param owner - Repository owner (org or user)
 * @param name - Repository name
 * @param limit - Maximum number of branches to return (default: 20)
 */
export async function getRepositoryBranches(
  octokit: Octokit,
  owner: string,
  name: string,
  limit = 20
): Promise<Array<{ name: string; committedDate: string; isDefault: boolean }>> {
  try {
    // GitHub GraphQL query to fetch branches with committedDate
    // We fetch up to 100 branches (GitHub's default page size) and sort/limit server-side
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            name
          }
          refs(refPrefix: "refs/heads/", first: 100, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
            nodes {
              name
              target {
                ... on Commit {
                  committedDate
                }
              }
            }
          }
        }
      }
    `;

    const response = await octokit.graphql<{
      repository: {
        defaultBranchRef: { name: string } | null;
        refs: {
          nodes: Array<{
            name: string;
            target: { committedDate?: string };
          }>;
        };
      };
    }>(query, {
      owner,
      name,
    });

    const defaultBranch = response.repository.defaultBranchRef?.name;

    const branches = response.repository.refs.nodes
      .map((node) => ({
        name: node.name,
        committedDate: node.target.committedDate ?? new Date(0).toISOString(),
        isDefault: defaultBranch !== undefined && node.name === defaultBranch,
      }))
      .sort(
        (a, b) =>
          new Date(b.committedDate).getTime() -
          new Date(a.committedDate).getTime()
      );

    // Pin default branch at position 0
    const defaultBranchIndex = branches.findIndex((b) => b.isDefault);
    if (defaultBranchIndex > 0) {
      const [defaultBranchObj] = branches.splice(defaultBranchIndex, 1);
      branches.unshift(defaultBranchObj);
    } else if (defaultBranchIndex === -1 && defaultBranch !== undefined) {
      // Default branch wasn't in the top 100 by commit date — add it explicitly
      branches.unshift({
        name: defaultBranch,
        committedDate: new Date(0).toISOString(),
        isDefault: true,
      });
    }

    // Return top `limit` branches
    return branches.slice(0, limit);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/branches] Failed to fetch branches", {
      owner,
      name,
      error: errorMessage,
    });
    throw new Error(`Failed to fetch branches: ${errorMessage}`);
  }
}

export type RepositoryPullRequestListItem = RepositoryPullRequestListItemShape;
export type RepositoryPullRequest = RepositoryPullRequestListItemShape;

export type RepositoryPullRequestListResult = {
  pullRequests: RepositoryPullRequest[];
  hasMore: boolean;
  truncated: boolean;
  pageInfo: NonNullable<GitHubBundledPullRequestsResult["pageInfo"]>;
  stopReason: NonNullable<GitHubBundledPullRequestsResult["stopReason"]>;
  missingTargetNumbers: number[];
};

export async function getRepositoryPullRequestsWithMetadata(
  octokit: Octokit,
  owner: string,
  name: string,
  options?: {
    state?: "open" | "closed" | "all";
    limit?: number;
    targetNumbers?: readonly number[];
    maxPages?: number;
    maxItems?: number;
  },
  // PLN-1535 M0: optional per-page rate-limit-cost observer. Omitted by callers
  // that do not measure GraphQL spend; the read behaves identically either way.
  observer?: GitHubBundledPullRequestsObserver,
  // ISS-5826: caller-owned, attempt-stable provenance for optional fork-head
  // repository authority. Omission preserves behavior for older callers.
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<RepositoryPullRequestListResult> {
  const limit = normalizeRepositoryPullRequestListLimit(options?.limit);
  const state = options?.state ?? "all";

  try {
    const result = await queryBundledPullRequestsWithProviderResult(
      octokit,
      owner,
      name,
      options?.targetNumbers ?? [],
      {
        maxItems: options?.maxItems,
        maxPages: options?.maxPages,
        targetNumbers: options?.targetNumbers,
      },
      observer,
      repositoryDefaultContext
    );
    if (result.status !== GitHubProviderResultStatus.Success) {
      throw new Error(result.status);
    }

    const pullRequests = selectRepositoryPullRequestsForList(
      result.value.pullRequests.filter((pr) =>
        repositoryPullRequestMatchesState(pr, state)
      ),
      limit,
      options?.targetNumbers ?? []
    ).map(mapRepositoryPullRequest);
    return {
      pullRequests,
      hasMore: result.value.hasMore === true,
      truncated: result.value.truncated === true,
      pageInfo: result.value.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      },
      stopReason:
        result.value.stopReason ?? GitHubBundledPullRequestsStopReason.Complete,
      missingTargetNumbers: result.value.missingTargetNumbers ?? [],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/pull-requests] Failed to fetch pull requests", {
      owner,
      name,
      error: errorMessage,
    });
    throw new Error(`Failed to fetch pull requests: ${errorMessage}`);
  }
}

export type StatusCheckRollupCheck = BranchViewCheck & {
  providerNodeId: string | null;
  position: number;
};

export type StatusCheckRollupResult =
  | {
      ok: true;
      state: StatusCheckRollupState | null;
      checks: StatusCheckRollupCheck[];
      totalCount: number;
      truncated: boolean;
    }
  | { ok: false; reason: StatusCheckRollupFailureReason };

type StatusCheckRollupResponse = {
  repository: {
    object: {
      __typename: string | null;
      statusCheckRollup?: {
        state: StatusCheckRollupState;
        contexts: {
          totalCount: number;
          pageInfo: { hasNextPage: boolean };
          nodes: StatusCheckRollupNode[];
        } | null;
      } | null;
    } | null;
  } | null;
};

type StatusCheckRollupNode =
  | {
      __typename: "CheckRun";
      id: string | null;
      name: string | null;
      status: string | null;
      conclusion: string | null;
      startedAt: string | null;
      completedAt: string | null;
      detailsUrl: string | null;
      url: string | null;
    }
  | {
      __typename: "StatusContext";
      context: string | null;
      state: string | null;
      createdAt: string | null;
      targetUrl: string | null;
    }
  | { __typename: string | null }
  | null;

type StatusCheckRollupCandidate = StatusCheckRollupCheck & {
  dedupeKey: string;
  observedAt: string | null;
  sourcePriority: number;
};

type StatusCheckRollupQueryContext = {
  owner: string;
  repo: string;
  commitSha: string;
};

/**
 * Query aggregate and bounded per-context status-check data for a commit SHA
 * with the caller's client. Provider failures return exact reason values
 * without throwing expected errors.
 */
export async function queryStatusCheckRollupWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  commitSha: string
): Promise<GitHubProviderResult<StatusCheckRollupResult>> {
  const invalidInputResult = validateStatusCheckRollupInput(
    owner,
    repo,
    commitSha
  );
  if (invalidInputResult) {
    return {
      status: GitHubProviderResultStatus.Success,
      value: invalidInputResult,
    };
  }

  const query = `
    query GetStatusCheckRollup($owner: String!, $repo: String!, $commitSha: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $commitSha) {
          __typename
          ... on Commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                pageInfo {
                  hasNextPage
                }
                nodes {
                  __typename
                  ... on CheckRun {
                    id
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    detailsUrl
                    url
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await octokit.graphql<StatusCheckRollupResponse>(query, {
      owner,
      repo,
      commitSha,
    });

    return {
      status: GitHubProviderResultStatus.Success,
      value: mapStatusCheckRollupResponse(data?.repository ?? null, {
        owner,
        repo,
        commitSha,
      }),
    };
  } catch (error) {
    const classification = classifyGitHubProviderError(error);
    if (
      classification.status === GitHubProviderResultStatus.ProviderRateLimit
    ) {
      return classification;
    }

    const partialResult = mapPartialStatusCheckRollupError(error, {
      owner,
      repo,
      commitSha,
    });
    if (partialResult) {
      return {
        status: GitHubProviderResultStatus.Success,
        value: partialResult,
      };
    }

    return { status: GitHubProviderResultStatus.ProviderUnavailable };
  }
}

/**
 * Fetch a visible repository window of pull requests with review/check summary
 * data in one GraphQL request. Every call selects rateLimit budget metadata via
 * the shared query so callers can back off from GitHub-reported limits.
 */
export async function queryBundledPullRequestsWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: readonly number[],
  options: GitHubBundledPullRequestsPageOptions = {},
  // PLN-1535 M0: invoked once per fetched page with the mapped `rateLimit`
  // budget (incl. the `cost` this read otherwise discards) so callers can
  // measure GraphQL spend per route. Pages already fetched before an early
  // paging exit are still reported.
  observer?: GitHubBundledPullRequestsObserver,
  repositoryDefaultContext?: GitHubRepositoryDefaultObservationContext
): Promise<GitHubProviderResult<GitHubBundledPullRequestsResult>> {
  try {
    const normalized = normalizeBundledPullRequestsPageOptions({
      ...options,
      targetNumbers: options.targetNumbers ?? numbers,
    });
    const pages: GitHubBundledPullRequestsResult[] = [];
    let after = normalized.after;

    for (let page = 0; page < normalized.maxPages; page++) {
      const remainingItems =
        normalized.maxItems - countBundledPullRequests(pages);
      if (remainingItems <= 0) {
        break;
      }
      let data: BundledPullRequestsGraphqlResponse;
      try {
        data = await octokit.graphql<BundledPullRequestsGraphqlResponse>(
          GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
          buildBundledPullRequestsVariables(owner, repo, numbers, {
            ...normalized,
            after,
            pageSize: Math.min(normalized.pageSize, remainingItems),
          })
        );
      } catch (error) {
        return resolveBundledPullRequestsPageFailure(error, pages, normalized);
      }
      const mapped = mapBundledPullRequestsResponse(
        data,
        undefined,
        repositoryDefaultContext
      );
      pages.push(mapped);
      observer?.({
        page,
        itemCount: mapped.pullRequests.length,
        rateLimit: mapped.rateLimit,
      });

      if (
        normalized.targetNumbers.length > 0 &&
        bundledPullRequestsFoundAllTargets(
          pages.flatMap((current) => current.pullRequests),
          normalized.targetNumbers
        )
      ) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.TargetFound
          ),
        };
      }
      if (mapped.rateLimit.state === GitHubProviderBudgetState.Low) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.BudgetLow
          ),
        };
      }
      if (!(mapped.pageInfo?.hasNextPage && mapped.pageInfo.endCursor)) {
        return {
          status: GitHubProviderResultStatus.Success,
          value: mergeBundledPullRequestsResults(pages, normalized),
        };
      }
      after = mapped.pageInfo.endCursor;
    }

    return {
      status: GitHubProviderResultStatus.Success,
      value: mergeBundledPullRequestsResults(pages, normalized),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

function mapPartialStatusCheckRollupError(
  error: unknown,
  context: StatusCheckRollupQueryContext
): StatusCheckRollupResult | null {
  const data = getPartialGraphqlData(error);
  if (!data) {
    return null;
  }

  const result = mapStatusCheckRollupResponse(data.repository ?? null, context);
  if (!result.ok) {
    return null;
  }

  log.warn("[github/rollup] Recovered rollup from partial GraphQL data", {
    ...context,
    graphqlErrorCount: getGraphqlErrorCount(error),
  });
  return result;
}

function getPartialGraphqlData(
  error: unknown
): StatusCheckRollupResponse | null {
  const data = (error as { data?: unknown }).data;
  if (isStatusCheckRollupResponse(data)) {
    return data;
  }

  const responseData = (error as { response?: { data?: unknown } }).response
    ?.data;
  if (isStatusCheckRollupResponse(responseData)) {
    return responseData;
  }

  const nestedResponseData = (responseData as { data?: unknown } | null)?.data;
  return isStatusCheckRollupResponse(nestedResponseData)
    ? nestedResponseData
    : null;
}

function isStatusCheckRollupResponse(
  value: unknown
): value is StatusCheckRollupResponse {
  return typeof value === "object" && value !== null && "repository" in value;
}

function getGraphqlErrorCount(error: unknown): number {
  const errors = (error as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors.length : 0;
}

function validateStatusCheckRollupInput(
  owner: string,
  repo: string,
  commitSha: string
): StatusCheckRollupResult | null {
  if (!(owner && repo)) {
    log.warn("[github/rollup] Missing owner or repo", { owner, repo });
    return { ok: false, reason: StatusCheckRollupFailureReason.InvalidInput };
  }

  if (!COMMIT_SHA_REGEX.test(commitSha)) {
    log.warn("[github/rollup] Invalid commit SHA (must be 40 chars)", {
      commitSha,
      length: commitSha.length,
    });
    return { ok: false, reason: StatusCheckRollupFailureReason.InvalidInput };
  }

  return null;
}

function mapStatusCheckRollupResponse(
  repository: StatusCheckRollupResponse["repository"] | null,
  context: StatusCheckRollupQueryContext
): StatusCheckRollupResult {
  if (!repository) {
    log.warn("[github/rollup] Repository unavailable", context);
    return {
      ok: false,
      reason: StatusCheckRollupFailureReason.GraphqlError,
    };
  }

  const object = repository.object ?? null;
  if (object?.__typename !== "Commit") {
    log.warn("[github/rollup] Commit object unavailable", {
      ...context,
      objectType: object?.__typename ?? null,
    });
    return {
      ok: false,
      reason: StatusCheckRollupFailureReason.GraphqlError,
    };
  }

  const rollup = object.statusCheckRollup ?? null;
  if (!rollup) {
    return {
      ok: true,
      state: null,
      checks: [],
      totalCount: 0,
      truncated: false,
    };
  }

  const nodes = rollup.contexts?.nodes ?? [];
  const checks = mapStatusCheckRollupNodes(nodes);
  const providerTruncated = Boolean(rollup.contexts?.pageInfo.hasNextPage);
  const totalCount = providerTruncated
    ? (rollup.contexts?.totalCount ?? checks.length)
    : checks.length;
  return {
    ok: true,
    state: rollup.state,
    checks,
    totalCount,
    truncated: providerTruncated,
  };
}

function mapStatusCheckRollupNodes(
  nodes: StatusCheckRollupNode[]
): StatusCheckRollupCheck[] {
  const candidates: StatusCheckRollupCandidate[] = [];

  for (const node of nodes) {
    if (!node) {
      continue;
    }
    if (isCheckRunNode(node)) {
      const check = mapCheckRunNode(node, candidates.length);
      if (check) {
        candidates.push(check);
      }
      continue;
    }
    if (isStatusContextNode(node)) {
      candidates.push(mapStatusContextNode(node, candidates.length));
    }
  }

  return dedupeStatusCheckRollupCandidates(candidates);
}

function isCheckRunNode(
  node: Exclude<StatusCheckRollupNode, null>
): node is Extract<StatusCheckRollupNode, { __typename: "CheckRun" }> {
  return node.__typename === "CheckRun" && "id" in node;
}

function isStatusContextNode(
  node: Exclude<StatusCheckRollupNode, null>
): node is Extract<StatusCheckRollupNode, { __typename: "StatusContext" }> {
  return node.__typename === "StatusContext" && "context" in node;
}

function mapCheckRunNode(
  node: Extract<StatusCheckRollupNode, { __typename: "CheckRun" }>,
  position: number
): StatusCheckRollupCandidate | null {
  const providerNodeId = normalizeProviderText(node.id, 255);
  if (!providerNodeId) {
    return null;
  }
  const name = normalizeProviderText(node.name, 255) ?? "Unnamed check";

  return {
    id: `node:${hashProviderKey(providerNodeId)}`,
    kind: BranchViewCheckKind.CheckRun,
    name,
    status: normalizeProviderStatus(node.status),
    conclusion: normalizeProviderStatus(node.conclusion),
    targetUrl:
      sanitizeProviderUrl(node.detailsUrl) ?? sanitizeProviderUrl(node.url),
    providerNodeId,
    position,
    dedupeKey: getStatusCheckDedupeKey(name),
    observedAt: node.completedAt ?? node.startedAt ?? null,
    sourcePriority: CHECK_RUN_DEDUPE_PRIORITY,
  };
}

function mapStatusContextNode(
  node: Extract<StatusCheckRollupNode, { __typename: "StatusContext" }>,
  position: number
): StatusCheckRollupCandidate {
  const name =
    normalizeProviderText(node.context, 255) ?? "Unnamed status context";

  return {
    id: `context:${hashProviderKey(name)}`,
    kind: BranchViewCheckKind.StatusContext,
    name,
    status: normalizeProviderStatus(node.state),
    conclusion: null,
    targetUrl: sanitizeProviderUrl(node.targetUrl),
    providerNodeId: null,
    position,
    dedupeKey: getStatusCheckDedupeKey(name),
    observedAt: node.createdAt ?? null,
    sourcePriority: STATUS_CONTEXT_DEDUPE_PRIORITY,
  };
}

function dedupeStatusCheckRollupCandidates(
  candidates: StatusCheckRollupCandidate[]
): StatusCheckRollupCheck[] {
  const byEffectiveIdentity = new Map<string, StatusCheckRollupCandidate>();

  for (const candidate of candidates) {
    const previous = byEffectiveIdentity.get(candidate.dedupeKey);
    if (!previous || shouldReplaceStatusCheckCandidate(previous, candidate)) {
      byEffectiveIdentity.set(candidate.dedupeKey, candidate);
    }
  }

  return Array.from(byEffectiveIdentity.values())
    .sort((left, right) => left.position - right.position)
    .map(({ dedupeKey, observedAt, sourcePriority, ...check }, position) => ({
      ...check,
      position,
    }));
}

function shouldReplaceStatusCheckCandidate(
  previous: StatusCheckRollupCandidate,
  candidate: StatusCheckRollupCandidate
): boolean {
  const previousTime = parseProviderTimestamp(previous.observedAt);
  const candidateTime = parseProviderTimestamp(candidate.observedAt);

  if (candidateTime !== previousTime) {
    return candidateTime > previousTime;
  }
  if (candidate.sourcePriority !== previous.sourcePriority) {
    return candidate.sourcePriority < previous.sourcePriority;
  }
  return candidate.position > previous.position;
}

/**
 * Fetch a single pull request by number.
 * Returns null on any error (not found, permission denied, etc.).
 */
export async function getSinglePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  authorityObservation?: GitHubPullRequestRestAuthorityObservation
): Promise<GitHubSinglePullRequestResult | null> {
  const result = await getSinglePullRequestWithProviderResult(
    octokit,
    owner,
    repo,
    pullNumber,
    authorityObservation
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github/pull-request] Failed to fetch single pull request", {
    owner,
    repo,
    pullNumber,
    status: result.status,
  });
  return null;
}

/**
 * Fetch a single pull request with the caller's client (PLN-1525 step 4: one
 * credential-agnostic function replaces the installation/user-token variant
 * pair). The result carries the credential-fault statuses so user-token lanes
 * can distinguish a revoked/underscoped credential; installation-lane callers
 * treat them like any other non-success.
 */
export async function getSinglePullRequestWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  authorityObservation?: GitHubPullRequestRestAuthorityObservation
): Promise<GitHubUserTokenProviderResult<GitHubSinglePullRequestResult>> {
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      headers: GITHUB_PULL_REQUEST_REST_HEADERS,
    });

    return {
      status: GitHubProviderResultStatus.Success,
      value: mapSinglePullRequestResponse(pr, authorityObservation),
    };
  } catch (error) {
    return toGitHubUserTokenProviderFailure(error);
  }
}

/**
 * Generate an installation access token for a given GitHub App installation.
 * Used by the loop orchestrator to pass a short-lived token to containers.
 */
export async function getInstallationAccessToken(
  installationId: string
): Promise<string> {
  return await getInstallationAccessTokenForInstallation(installationId);
}

export type GitHubChangedFile = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

const MAX_COMPARE_FILES = 500;
const MAX_PR_METADATA_ROWS = 500;

export type GitHubPullRequestMetadataListOptions = {
  /** Maximum rows to fetch before returning a bounded result. */
  limit?: number;
  /** Provider page size for each request, clamped to GitHub's REST bounds. */
  pageSize?: number;
  /** Whether to enrich review comments with review-thread id/resolution metadata. */
  includeReviewThreadMetadata?: boolean;
};

type CompareCommitFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

/**
 * Compare two refs and return bounded file-change metadata from GitHub with
 * the caller's client. Raw file contents are intentionally not fetched here;
 * callers decide how to truncate or omit patch snippets before persisting
 * metadata.
 */
export async function compareBranchFileChangesWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitHubProviderResult<GitHubChangedFile[]>> {
  try {
    const files: GitHubChangedFile[] = [];
    await octokit.paginate(
      octokit.rest.repos.compareCommitsWithBasehead,
      {
        owner,
        repo,
        basehead: `${base}...${head}`,
        per_page: 100,
      },
      (response, done) => {
        const responseData = response.data as { files?: CompareCommitFile[] };
        for (const file of responseData.files ?? []) {
          if (files.length >= MAX_COMPARE_FILES) {
            done();
            break;
          }
          const changedFile: GitHubChangedFile = {
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          };
          if (file.previous_filename) {
            changedFile.previousFilename = file.previous_filename;
          }
          if (file.patch) {
            changedFile.patch = file.patch;
          }
          files.push(changedFile);
        }
        if (files.length >= MAX_COMPARE_FILES) {
          done();
        }
        return [];
      }
    );

    return { status: GitHubProviderResultStatus.Success, value: files };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

// getMergeBaseSha / getBoundedFileContentAtRef moved to the credential-agnostic
// `@repo/github/file-content` subpath (PLN-1525 step 3) — they take an Octokit
// client from the apps/api resolver layer instead of an installationId.

/**
 * Fetch all review comments (inline code comments) for a pull request with
 * the caller's client.
 */
export async function listPullRequestReviewCommentsWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: GitHubPullRequestMetadataListOptions = {}
): Promise<GitHubProviderResult<GitHubPullRequestReviewComment[]>> {
  try {
    const limit = normalizePullRequestMetadataLimit(options.limit);
    const pageSize = normalizePullRequestMetadataPageSize(options.pageSize);
    const comments: Awaited<
      ReturnType<typeof octokit.pulls.listReviewComments>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const remainingLimit = limit - comments.length;
      const { data } = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: Math.min(pageSize, remainingLimit),
        page,
      });
      comments.push(...data);
      if (data.length < pageSize || comments.length >= limit) {
        break;
      }
    }
    const reviewThreadMetadata =
      options.includeReviewThreadMetadata === false
        ? new Map<number, { id: string; isResolved: boolean }>()
        : await fetchReviewThreadMetadataByCommentId(
            octokit,
            owner,
            repo,
            pullNumber,
            MAX_PR_METADATA_PAGES
          );

    return {
      status: GitHubProviderResultStatus.Success,
      value: comments
        .slice(0, limit)
        .map((comment) =>
          mapPullRequestReviewComment(
            comment,
            reviewThreadMetadata.get(comment.id)?.id ?? null,
            reviewThreadMetadata.get(comment.id)?.isResolved ?? null
          )
        ),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

/**
 * Fetch all reviews for a pull request with the caller's client.
 */
export async function listPullRequestReviewsWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: GitHubPullRequestMetadataListOptions = {}
): Promise<GitHubProviderResult<GitHubPullRequestReview[]>> {
  try {
    const limit = normalizePullRequestMetadataLimit(options.limit);
    const pageSize = normalizePullRequestMetadataPageSize(options.pageSize);
    const reviews: Awaited<
      ReturnType<typeof octokit.pulls.listReviews>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const remainingLimit = limit - reviews.length;
      const { data } = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: Math.min(pageSize, remainingLimit),
        page,
      });
      reviews.push(...data);
      if (data.length < pageSize || reviews.length >= limit) {
        break;
      }
    }
    return {
      status: GitHubProviderResultStatus.Success,
      value: reviews.slice(0, limit).map((r) => ({
        id: r.id,
        user: mapGitHubPullRequestReviewAuthor(r.user),
        state: r.state,
        body: r.body ?? null,
        submitted_at: r.submitted_at ?? null,
        html_url: r.html_url,
      })),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

/**
 * Fetch all general PR conversation comments (issue comments on a PR) with
 * the caller's client. These are non-inline comments posted in the PR
 * conversation tab.
 */
export async function listPullRequestIssueCommentsWithProviderResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: GitHubPullRequestMetadataListOptions = {}
): Promise<GitHubProviderResult<GitHubPullRequestIssueComment[]>> {
  try {
    const limit = normalizePullRequestMetadataLimit(options.limit);
    const pageSize = normalizePullRequestMetadataPageSize(options.pageSize);
    const comments: Awaited<
      ReturnType<typeof octokit.issues.listComments>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const remainingLimit = limit - comments.length;
      const { data } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: Math.min(pageSize, remainingLimit),
        page,
      });
      comments.push(...data);
      if (data.length < pageSize || comments.length >= limit) {
        break;
      }
    }
    return {
      status: GitHubProviderResultStatus.Success,
      value: comments.slice(0, limit).map(mapPullRequestIssueComment),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

function normalizePullRequestMetadataLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return MAX_PR_METADATA_ROWS;
  }
  return Math.min(MAX_PR_METADATA_ROWS, Math.max(1, Math.floor(limit)));
}

function normalizePullRequestMetadataPageSize(
  pageSize: number | undefined
): number {
  if (typeof pageSize !== "number" || !Number.isFinite(pageSize)) {
    return 100;
  }
  return Math.min(100, Math.max(1, Math.floor(pageSize)));
}

/**
 * Verify that a branch exists in a repository.
 * Returns true if the branch exists, false if it does not (404).
 * Throws a descriptive error for any other failure (permission denied, network error, etc.).
 */
export async function verifyBranchExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<boolean> {
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return false;
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/branch] Failed to verify branch existence", {
      owner,
      repo,
      branch,
      error: errorMessage,
    });
    throw new Error(
      `Failed to verify branch "${branch}" in ${owner}/${repo}: ${errorMessage}`
    );
  }
}

/**
 * Fetch the list of contributors for a repository with the caller's client.
 * Returns a normalized list with login, avatar URL, contribution count, and profile URL.
 * Returns an empty array on 404 or error (the repo may have no commits yet).
 */
export async function getRepositoryContributors(
  octokit: Octokit,
  owner: string,
  repo: string,
  options?: { perPage?: number }
): Promise<GitHubContributor[]> {
  const perPage = Math.min(options?.perPage ?? 30, 100);

  try {
    const { data } = await octokit.repos.listContributors({
      owner,
      repo,
      per_page: perPage,
    });

    return data.flatMap((contributor) => {
      if (!contributor.login || contributor.type === "Bot") {
        return [];
      }
      return [
        {
          login: contributor.login,
          avatarUrl: contributor.avatar_url ?? "",
          contributions: contributor.contributions ?? 0,
          htmlUrl: contributor.html_url ?? "",
        },
      ];
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 204) {
      return [];
    }
    log.warn("[github/contributors] Failed to list repository contributors", {
      owner,
      repo,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return [];
  }
}

/**
 * Fetch ALL branch names for a GitHub repository using pagination.
 * Looks up the GitHub App installation for the given owner/repo, then
 * iterates through every page of branches via the REST API.
 *
 * @param owner - Repository owner (org or user)
 * @param repo - Repository name
 * @returns Array of branch name strings
 */
export async function listAllBranchNames(
  owner: string,
  repo: string
): Promise<string[]> {
  const config = getConfig();

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    },
  });

  try {
    const { data: installation } = await appOctokit.apps.getRepoInstallation({
      owner,
      repo,
    });

    const octokit = await getInstallationOctokit(String(installation.id));

    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });

    return branches.map((branch) => branch.name);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to list all branch names: ${errorMessage}`);
  }
}

function countBundledPullRequests(
  pages: readonly GitHubBundledPullRequestsResult[]
): number {
  return pages.reduce((total, page) => total + page.pullRequests.length, 0);
}

/**
 * Decide what a failed page fetch means for the whole bundled read.
 *
 * Extracted from the paging loop so the reader stays under the cognitive
 * complexity ceiling. Order matters: a repo-access verdict (ISS-5093) is
 * checked first because it is the only outcome the caller records against the
 * credential — and only this repo-scoped read can tell "cannot reach the repo"
 * apart from a transient outage, since a GraphQL denial carries no HTTP status.
 * A rate limit mid-drain still returns the pages already fetched.
 */
function resolveBundledPullRequestsPageFailure(
  error: unknown,
  pages: GitHubBundledPullRequestsResult[],
  normalized: Parameters<typeof mergeBundledPullRequestsResults>[1]
): GitHubProviderResult<GitHubBundledPullRequestsResult> {
  const repositoryAccessFailure = classifyBundledRepositoryAccessFailure(
    error,
    pages.length
  );
  if (repositoryAccessFailure) {
    return repositoryAccessFailure;
  }
  const failure = toGitHubProviderFailure(error);
  if (
    pages.length > 0 &&
    failure.status === GitHubProviderResultStatus.ProviderRateLimit
  ) {
    return {
      status: GitHubProviderResultStatus.Success,
      value: mergeBundledPullRequestsResults(
        pages,
        normalized,
        GitHubBundledPullRequestsStopReason.ProviderRateLimit
      ),
    };
  }
  return failure;
}
