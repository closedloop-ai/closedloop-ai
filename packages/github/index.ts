import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import {
  type BranchViewCheck,
  BranchViewCheckKind,
} from "@repo/api/src/types/branch-view";
import type {
  GitHubContributor,
  StatusCheckRollupState,
} from "@repo/api/src/types/github";
import {
  GitHubPRState,
  StatusCheckRollupFailureReason,
} from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import {
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReviewComment,
  mapPullRequestIssueComment,
  mapPullRequestReviewComment,
} from "./comment-payloads";
import {
  getInstallationAccessToken as getInstallationAccessTokenForInstallation,
  getInstallationOctokit,
} from "./installation-auth";
import { keys, webhookSecretKeys } from "./keys";
import {
  fetchReviewThreadMetadataByCommentId,
  MAX_PR_METADATA_PAGES,
} from "./review-thread-lookup";

export type {
  CreatePullRequestReviewCommentWithUserTokenInput,
  GitHubCommentAuthor,
  GitHubPullRequestIssueComment,
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

// Top-level regex for performance
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const PROVIDER_TEXT_NORMALIZE_REGEX = /\s+/g;
const CHECK_RUN_DEDUPE_PRIORITY = 0;
const STATUS_CONTEXT_DEDUPE_PRIORITY = 1;

export const GitHubProviderResultStatus = {
  Success: "success",
  ProviderRateLimit: "provider_rate_limit",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type GitHubProviderResultStatus =
  (typeof GitHubProviderResultStatus)[keyof typeof GitHubProviderResultStatus];

export type GitHubProviderResult<T> =
  | { status: typeof GitHubProviderResultStatus.Success; value: T }
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | { status: typeof GitHubProviderResultStatus.ProviderUnavailable };

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
 * Get branches for a GitHub repository using GitHub GraphQL API.
 * Fetches up to 100 branches, sorted by committedDate descending.
 * Returns the top `limit` branches with the default branch pinned at position 0.
 *
 * @param installationId - GitHub installation ID (string)
 * @param owner - Repository owner (org or user)
 * @param name - Repository name
 * @param limit - Maximum number of branches to return (default: 20)
 */
export async function getRepositoryBranches(
  installationId: string,
  owner: string,
  name: string,
  limit = 20
): Promise<Array<{ name: string; committedDate: string; isDefault: boolean }>> {
  const config = getConfig();

  try {
    // Create installation-authenticated Octokit
    const auth = createAppAuth({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    });

    const installationAuth = await auth({
      type: "installation",
      installationId: Number.parseInt(installationId, 10),
    });

    const octokit = new Octokit({
      auth: installationAuth.token,
    });

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

    const defaultBranch = response.repository.defaultBranchRef?.name ?? "main";

    const branches = response.repository.refs.nodes
      .map((node) => ({
        name: node.name,
        committedDate: node.target.committedDate ?? new Date(0).toISOString(),
        isDefault: node.name === defaultBranch,
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
    } else if (defaultBranchIndex === -1) {
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
      installationId,
      owner,
      name,
      error: errorMessage,
    });
    throw new Error(`Failed to fetch branches: ${errorMessage}`);
  }
}

/**
 * Fetch pull requests for a repository via REST API.
 * Returns PRs sorted by most recently updated.
 */
export async function getRepositoryPullRequests(
  installationId: string,
  owner: string,
  name: string,
  options?: { state?: "open" | "closed" | "all"; limit?: number }
): Promise<
  Array<{
    githubId: string;
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
    headSha: string | null;
    state: "OPEN" | "MERGED" | "CLOSED";
    isDraft: boolean;
    closedAt: string | null;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    updatedAt: string;
    author: string;
  }>
> {
  const config = getConfig();
  const limit = options?.limit ?? 30;
  const state = options?.state ?? "all";

  try {
    const auth = createAppAuth({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    });

    const installationAuth = await auth({
      type: "installation",
      installationId: Number.parseInt(installationId, 10),
    });

    const octokit = new Octokit({
      auth: installationAuth.token,
    });

    const { data: pulls } = await octokit.pulls.list({
      owner,
      repo: name,
      state,
      sort: "updated",
      direction: "desc",
      per_page: Math.min(limit, 100),
    });

    return pulls.map((pr) => {
      let prState: "OPEN" | "MERGED" | "CLOSED" = "OPEN";
      if (pr.merged_at) {
        prState = "MERGED";
      } else if (pr.state === "closed") {
        prState = "CLOSED";
      }

      return {
        githubId: String(pr.id),
        number: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha ?? null,
        state: prState,
        isDraft: pr.draft ?? false,
        closedAt: pr.closed_at ?? null,
        mergedAt: pr.merged_at ?? null,
        mergeCommitSha: pr.merge_commit_sha ?? null,
        updatedAt: pr.updated_at,
        author: pr.user?.login ?? "unknown",
      };
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/pull-requests] Failed to fetch pull requests", {
      installationId,
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
  installationId: string;
  owner: string;
  repo: string;
  commitSha: string;
};

/**
 * Query aggregate and bounded per-context status-check data for a commit SHA.
 * Provider failures return exact reason values without throwing expected errors.
 */
export async function queryStatusCheckRollup(
  installationId: string,
  owner: string,
  repo: string,
  commitSha: string
): Promise<StatusCheckRollupResult> {
  const invalidInputResult = validateStatusCheckRollupInput(
    owner,
    repo,
    commitSha
  );
  if (invalidInputResult) {
    return invalidInputResult;
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
    const octokit = await getInstallationOctokit(installationId);
    const data = await octokit.graphql<StatusCheckRollupResponse>(query, {
      owner,
      repo,
      commitSha,
    });

    return mapStatusCheckRollupResponse(data?.repository ?? null, {
      installationId,
      owner,
      repo,
      commitSha,
    });
  } catch (error) {
    const partialResult = mapPartialStatusCheckRollupError(error, {
      installationId,
      owner,
      repo,
      commitSha,
    });
    if (partialResult) {
      return partialResult;
    }

    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message.toLowerCase().includes("rate limit")) {
      log.warn("[github/rollup] Rate limited", {
        installationId,
        owner,
        repo,
        commitSha,
      });
      return { ok: false, reason: StatusCheckRollupFailureReason.RateLimited };
    }

    if (status === 403) {
      log.error("[github/rollup] Permission denied (403)", {
        installationId,
        owner,
        repo,
        commitSha,
      });
      return {
        ok: false,
        reason: StatusCheckRollupFailureReason.PermissionDenied,
      };
    }

    log.error("[github/rollup] GraphQL query failed", {
      installationId,
      owner,
      repo,
      commitSha,
      error: message,
    });
    return { ok: false, reason: StatusCheckRollupFailureReason.GraphqlError };
  }
}

export async function queryStatusCheckRollupWithProviderResult(
  installationId: string,
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
    const octokit = await getInstallationOctokit(installationId);
    const data = await octokit.graphql<StatusCheckRollupResponse>(query, {
      owner,
      repo,
      commitSha,
    });

    return {
      status: GitHubProviderResultStatus.Success,
      value: mapStatusCheckRollupResponse(data?.repository ?? null, {
        installationId,
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
      installationId,
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

function parseProviderTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getStatusCheckDedupeKey(name: string): string {
  return name.toLowerCase();
}

function hashProviderKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 64);
}

function normalizeProviderText(
  value: string | null | undefined,
  maxLength: number
): string | null {
  const normalized = value
    ?.replace(PROVIDER_TEXT_NORMALIZE_REGEX, " ")
    .trim()
    .slice(0, maxLength);
  return normalized ? normalized : null;
}

function normalizeProviderStatus(
  value: string | null | undefined
): string | null {
  const normalized = normalizeProviderText(value, 64);
  return normalized ? normalized.toUpperCase() : null;
}

function sanitizeProviderUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!(trimmed && trimmed.length <= 2048)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export type GitHubProviderErrorClassification =
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | { status: typeof GitHubProviderResultStatus.ProviderUnavailable };

/**
 * Extract retry metadata from GitHub REST/GraphQL errors. `Retry-After` wins
 * over reset epochs because it is the provider's most specific instruction.
 */
export function getGitHubRetryAfterSeconds(
  error: unknown,
  nowMs = Date.now()
): number | null {
  const retryAfter = getGitHubErrorHeader(error, "retry-after");
  const retryAfterSeconds = parseRetryAfterHeader(retryAfter, nowMs);
  if (retryAfterSeconds !== null) {
    return retryAfterSeconds;
  }

  const resetEpoch = getGitHubErrorHeader(error, "x-ratelimit-reset");
  if (!resetEpoch) {
    return null;
  }
  const resetSeconds = Number(resetEpoch);
  if (!(Number.isFinite(resetSeconds) && resetSeconds > 0)) {
    return null;
  }
  const secondsUntilReset = Math.ceil((resetSeconds * 1000 - nowMs) / 1000);
  return secondsUntilReset > 0 ? secondsUntilReset : null;
}

/** Classify GitHub provider failures without exposing raw provider content. */
export function classifyGitHubProviderError(
  error: unknown,
  nowMs = Date.now()
): GitHubProviderErrorClassification {
  const status = getGitHubErrorStatus(error);
  const retryAfterSeconds = getGitHubRetryAfterSeconds(error, nowMs);
  if (
    status === 429 ||
    (status === 403 &&
      (retryAfterSeconds !== null || hasGitHubRateLimitEvidence(error))) ||
    hasGitHubRateLimitEvidence(error)
  ) {
    return {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds,
    };
  }
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

function toGitHubProviderFailure(
  error: unknown
): Exclude<
  GitHubProviderResult<never>,
  { status: typeof GitHubProviderResultStatus.Success }
> {
  const classification = classifyGitHubProviderError(error);
  if (classification.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return classification;
  }
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

function parseRetryAfterHeader(value: string | null, nowMs: number) {
  if (!value) {
    return null;
  }
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.ceil(numericSeconds);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const secondsUntilDate = Math.ceil((dateMs - nowMs) / 1000);
  return secondsUntilDate > 0 ? secondsUntilDate : null;
}

function getGitHubErrorStatus(error: unknown): number | null {
  if (!(error && typeof error === "object")) {
    return null;
  }
  const directStatus = Reflect.get(error, "status");
  if (typeof directStatus === "number") {
    return directStatus;
  }
  const response = Reflect.get(error, "response");
  if (response && typeof response === "object") {
    const responseStatus = Reflect.get(response, "status");
    return typeof responseStatus === "number" ? responseStatus : null;
  }
  return null;
}

function getGitHubErrorHeader(
  error: unknown,
  headerName: string
): string | null {
  if (!(error && typeof error === "object")) {
    return null;
  }
  const directHeaders = Reflect.get(error, "headers");
  const directValue = getHeaderValue(directHeaders, headerName);
  if (directValue) {
    return directValue;
  }
  const response = Reflect.get(error, "response");
  if (!(response && typeof response === "object")) {
    return null;
  }
  return getHeaderValue(Reflect.get(response, "headers"), headerName);
}

function getHeaderValue(headers: unknown, headerName: string): string | null {
  if (!(headers && typeof headers === "object")) {
    return null;
  }
  const getter = Reflect.get(headers, "get");
  if (typeof getter === "function") {
    const value = getter.call(headers, headerName);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) {
      continue;
    }
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

function hasGitHubRateLimitEvidence(error: unknown): boolean {
  const text = getGitHubErrorText(error).toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate_limited") ||
    text.includes("rate-limited") ||
    text.includes("ratelimit") ||
    text.includes("secondary rate")
  );
}

function getGitHubErrorText(error: unknown): string {
  if (!(error && typeof error === "object")) {
    return "";
  }
  const messages: string[] = [];
  pushStringProperty(messages, error, "message");
  pushStringProperty(messages, error, "reason");
  const errors = Reflect.get(error, "errors");
  if (Array.isArray(errors)) {
    for (const item of errors) {
      pushErrorItemText(messages, item);
    }
  }
  return messages.join(" ");
}

function pushErrorItemText(messages: string[], item: unknown) {
  if (!(item && typeof item === "object")) {
    return;
  }
  pushStringProperty(messages, item, "message");
  pushStringProperty(messages, item, "type");
  pushStringProperty(messages, item, "reason");
}

function pushStringProperty(
  messages: string[],
  source: object,
  property: string
) {
  const value = Reflect.get(source, property);
  if (typeof value === "string") {
    messages.push(value);
  }
}

/**
 * Fetch a single pull request by number.
 * Returns null on any error (not found, permission denied, etc.).
 */
export async function getSinglePullRequest(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<{
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  state: GitHubPRState;
  mergedAt: string | null;
  closedAt: string | null;
  authorLogin: string | null;
  isDraft: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
} | null> {
  const result = await getSinglePullRequestWithProviderResult(
    installationId,
    owner,
    repo,
    pullNumber
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github/pull-request] Failed to fetch single pull request", {
    installationId,
    owner,
    repo,
    pullNumber,
    status: result.status,
  });
  return null;
}

export async function getSinglePullRequestWithProviderResult(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  GitHubProviderResult<{
    githubId: string;
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
    state: GitHubPRState;
    mergedAt: string | null;
    closedAt: string | null;
    authorLogin: string | null;
    isDraft: boolean;
    headSha: string;
    baseSha: string;
    mergeCommitSha: string | null;
  }>
> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    let state: GitHubPRState = GitHubPRState.Open;
    if (pr.merged_at) {
      state = GitHubPRState.Merged;
    } else if (pr.state === "closed") {
      state = GitHubPRState.Closed;
    }

    return {
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: String(pr.id),
        number: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        state,
        mergedAt: pr.merged_at ?? null,
        closedAt: pr.closed_at ?? null,
        authorLogin: pr.user?.login ?? null,
        isDraft: pr.draft ?? false,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        mergeCommitSha: pr.merge_commit_sha ?? null,
      },
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
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

/**
 * List all files changed in a pull request.
 * Uses pagination to retrieve up to all changed files.
 * Returns null on error.
 */
export async function listPullRequestFiles(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<Array<{
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}> | null> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const files: Awaited<ReturnType<typeof octokit.pulls.listFiles>>["data"] =
      [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const { data } = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      files.push(...data);
      if (data.length < 100 || files.length >= MAX_PR_METADATA_ROWS) {
        break;
      }
    }

    return files.slice(0, MAX_PR_METADATA_ROWS).map((file) => ({
      filename: file.filename,
      previous_filename: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }));
  } catch (error) {
    log.warn("[github/pull-request] Failed to list pull request files", {
      installationId,
      owner,
      repo,
      pullNumber,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
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
 * Compare two refs and return bounded file-change metadata from GitHub.
 * Raw file contents are intentionally not fetched here; callers decide how to
 * truncate or omit patch snippets before persisting metadata.
 */
export async function compareBranchFileChanges(
  installationId: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitHubChangedFile[] | null> {
  const result = await compareBranchFileChangesWithProviderResult(
    installationId,
    owner,
    repo,
    base,
    head
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github/branch-files] Failed to compare branch file changes", {
    installationId,
    owner,
    repo,
    base,
    head,
    status: result.status,
  });
  return null;
}

export async function compareBranchFileChangesWithProviderResult(
  installationId: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitHubProviderResult<GitHubChangedFile[]>> {
  try {
    const octokit = await getInstallationOctokit(installationId);
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

/**
 * Resolve the merge-base commit SHA between a base ref and a head ref. This is
 * the fork point GitHub uses for pull request "Files changed" diffs, so callers
 * rendering a PR-equivalent diff must compare against it rather than the base
 * branch's current tip (which drifts as the base advances). Returns null when
 * the comparison cannot be resolved.
 */
export async function getMergeBaseSha(
  installationId: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string | null> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    return data.merge_base_commit?.sha ?? null;
  } catch (error) {
    log.warn("[github/branch-files] Failed to resolve merge base", {
      installationId,
      owner,
      repo,
      base,
      head,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

export type BoundedFileContentAtRefResult =
  | { status: "found"; content: string }
  | { status: "missing" | "not_file" | "too_large" | "unsupported_encoding" };

/**
 * Fetch bounded text content at a specific git ref. GitHub content/blob size
 * metadata is checked before decoding so explicit diff routes can reject
 * oversized files without materializing large strings in memory.
 */
export async function getBoundedFileContentAtRef(
  installationId: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxBytes: number
): Promise<BoundedFileContentAtRefResult> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });

    // Directories return arrays; symlinks/submodules have no content field.
    if (Array.isArray(data) || data.type !== "file") {
      return { status: "not_file" };
    }

    if (exceedsDeclaredSize(data.size, maxBytes)) {
      return { status: "too_large" };
    }

    if (data.encoding === "none") {
      const { data: blob } = await octokit.git.getBlob({
        owner,
        repo,
        file_sha: data.sha,
      });
      if (exceedsDeclaredSize(blob.size, maxBytes)) {
        return { status: "too_large" };
      }
      return decodeBoundedGitHubTextContent(
        blob.content,
        blob.encoding,
        maxBytes
      );
    }

    if (!("content" in data) || typeof data.content !== "string") {
      return { status: "not_file" };
    }

    return decodeBoundedGitHubTextContent(
      data.content,
      data.encoding,
      maxBytes
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return { status: "missing" };
    }
    log.warn("[github/content] Failed to fetch bounded file content at ref", {
      installationId,
      owner,
      repo,
      path,
      ref,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

function decodeBoundedGitHubTextContent(
  content: string,
  encoding: string | undefined,
  maxBytes: number
): BoundedFileContentAtRefResult {
  if (encoding === "base64") {
    const buffer = Buffer.from(content, "base64");
    if (buffer.byteLength > maxBytes) {
      return { status: "too_large" };
    }
    return { status: "found", content: buffer.toString("utf-8") };
  }

  if (encoding === "utf-8" || encoding === "utf8") {
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      return { status: "too_large" };
    }
    return { status: "found", content };
  }

  log.warn("[github/content] Unsupported file encoding", {
    encoding: encoding ?? null,
  });
  return { status: "unsupported_encoding" };
}

function exceedsDeclaredSize(
  size: number | null | undefined,
  maxBytes: number
) {
  return (
    Number.isFinite(maxBytes) && typeof size === "number" && size > maxBytes
  );
}

/**
 * Fetch all review comments (inline code comments) for a pull request.
 * Returns null on error.
 */
export async function listPullRequestReviewComments(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubPullRequestReviewComment[] | null> {
  const result = await listPullRequestReviewCommentsWithProviderResult(
    installationId,
    owner,
    repo,
    pullNumber
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github] Failed to list PR review comments", {
    owner,
    repo,
    pullNumber,
    status: result.status,
  });
  return null;
}

export async function listPullRequestReviewCommentsWithProviderResult(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubProviderResult<GitHubPullRequestReviewComment[]>> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const comments: Awaited<
      ReturnType<typeof octokit.pulls.listReviewComments>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const { data } = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      comments.push(...data);
      if (data.length < 100 || comments.length >= MAX_PR_METADATA_ROWS) {
        break;
      }
    }
    const reviewThreadMetadata = await fetchReviewThreadMetadataByCommentId(
      octokit,
      owner,
      repo,
      pullNumber,
      MAX_PR_METADATA_PAGES
    );

    return {
      status: GitHubProviderResultStatus.Success,
      value: comments
        .slice(0, MAX_PR_METADATA_ROWS)
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
 * Fetch all reviews for a pull request.
 * Returns null on error.
 */
export async function listPullRequestReviews(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<Array<{
  id: number;
  user: { login: string; avatar_url: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
}> | null> {
  const result = await listPullRequestReviewsWithProviderResult(
    installationId,
    owner,
    repo,
    pullNumber
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github] Failed to list PR reviews", {
    owner,
    repo,
    pullNumber,
    status: result.status,
  });
  return null;
}

export async function listPullRequestReviewsWithProviderResult(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  GitHubProviderResult<
    Array<{
      id: number;
      user: { login: string; avatar_url: string } | null;
      state: string;
      body: string | null;
      submitted_at: string | null;
      html_url: string;
    }>
  >
> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const reviews: Awaited<
      ReturnType<typeof octokit.pulls.listReviews>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const { data } = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      reviews.push(...data);
      if (data.length < 100 || reviews.length >= MAX_PR_METADATA_ROWS) {
        break;
      }
    }
    return {
      status: GitHubProviderResultStatus.Success,
      value: reviews.slice(0, MAX_PR_METADATA_ROWS).map((r) => ({
        id: r.id,
        user: r.user
          ? { login: r.user.login, avatar_url: r.user.avatar_url }
          : null,
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
 * Fetch all general PR conversation comments (issue comments on a PR).
 * These are non-inline comments posted in the PR conversation tab.
 * Returns null on error.
 */
export async function listPullRequestIssueComments(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubPullRequestIssueComment[] | null> {
  const result = await listPullRequestIssueCommentsWithProviderResult(
    installationId,
    owner,
    repo,
    pullNumber
  );
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  log.warn("[github] Failed to list PR issue comments", {
    owner,
    repo,
    pullNumber,
    status: result.status,
  });
  return null;
}

export async function listPullRequestIssueCommentsWithProviderResult(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubProviderResult<GitHubPullRequestIssueComment[]>> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const comments: Awaited<
      ReturnType<typeof octokit.issues.listComments>
    >["data"] = [];
    for (let page = 1; page <= MAX_PR_METADATA_PAGES; page++) {
      const { data } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
        page,
      });
      comments.push(...data);
      if (data.length < 100 || comments.length >= MAX_PR_METADATA_ROWS) {
        break;
      }
    }
    return {
      status: GitHubProviderResultStatus.Success,
      value: comments
        .slice(0, MAX_PR_METADATA_ROWS)
        .map(mapPullRequestIssueComment),
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
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
 * Verify that a branch exists in a repository using an installation token.
 * Convenience wrapper around verifyBranchExists that creates the Octokit
 * instance from the given installation ID, so callers do not need to import
 * Octokit directly.
 *
 * Returns true if the branch exists, false if it does not (404).
 * Throws a descriptive error for any other failure.
 */
export async function verifyInstallationBranchExists(
  installationId: string,
  owner: string,
  repo: string,
  branch: string
): Promise<boolean> {
  const octokit = await getInstallationOctokit(installationId);
  return verifyBranchExists(octokit, owner, repo, branch);
}

/**
 * Fetch the list of contributors for a repository.
 * Returns a normalized list with login, avatar URL, contribution count, and profile URL.
 * Returns an empty array on 404 or error (the repo may have no commits yet).
 */
export async function getRepositoryContributors(
  installationId: string,
  owner: string,
  repo: string,
  options?: { perPage?: number }
): Promise<GitHubContributor[]> {
  const perPage = Math.min(options?.perPage ?? 30, 100);

  try {
    const octokit = await getInstallationOctokit(installationId);
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
      installationId,
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
