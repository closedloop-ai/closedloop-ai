import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  type GitHubBundledPullRequestsPageOptions,
  type GitHubBundledPullRequestsResult,
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";

const execFileAsync = promisify(execFile);
const GH_GRAPHQL_TIMEOUT_MS = 30_000;
const GH_GRAPHQL_CONCURRENCY = 3;
const BACKOFF_CACHE_MAX_SIZE = 50;
const LOW_BUDGET_BACKOFF_MS = 60_000;

type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const queue: QueueTask<unknown>[] = [];
const backoffByGhPath = new Map<string, number>();
let activeCount = 0;

export type GhGraphqlResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "gh_unavailable"
        | "auth_required"
        | "rate_limited"
        | "secondary_limited"
        | "timeout"
        | "invalid_response";
      retryAfterMs: number | null;
    };

/**
 * Execute a GitHub GraphQL query through the user's authenticated `gh` CLI.
 * Concurrency and backoff are process-local only because the user-token budget
 * is shared with tools outside Desktop and must never be persisted.
 */
export function runGhGraphql<T>(
  ghPath: string,
  query: string,
  variables: Record<string, unknown>
): Promise<GhGraphqlResult<T>> {
  const backoffMs = getRemainingBackoffMs(ghPath);
  if (backoffMs !== null) {
    return Promise.resolve({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: backoffMs,
    });
  }

  return enqueue(async () => {
    try {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        args.push("-F", `${key}=${String(value)}`);
      }
      const { stdout } = await execFileAsync(ghPath, args, {
        timeout: GH_GRAPHQL_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as T;
      return { ok: true, value: parsed };
    } catch (error) {
      return classifyGhGraphqlFailure(error, ghPath);
    }
  });
}

export async function fetchBundledPullRequestsWithGh(
  ghPath: string,
  owner: string,
  repo: string,
  numbers: readonly number[],
  options: GitHubBundledPullRequestsPageOptions = {}
): Promise<GhGraphqlResult<GitHubBundledPullRequestsResult>> {
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
    const result = await runGhGraphql<BundledPullRequestsGraphqlResponse>(
      ghPath,
      GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
      buildBundledPullRequestsVariables(owner, repo, numbers, {
        ...normalized,
        after,
        pageSize: Math.min(normalized.pageSize, remainingItems),
      })
    );
    if (!result.ok) {
      if (
        pages.length > 0 &&
        (result.reason === "rate_limited" ||
          result.reason === "secondary_limited")
      ) {
        return {
          ok: true,
          value: mergeBundledPullRequestsResults(
            pages,
            normalized,
            GitHubBundledPullRequestsStopReason.ProviderRateLimit
          ),
        };
      }
      return result;
    }

    const mapped = mapBundledPullRequestsResponse(result.value);
    pages.push(mapped);
    if (
      bundledPullRequestPagesFoundAllTargets(pages, normalized.targetNumbers)
    ) {
      recordLowBudgetBackoff(ghPath, mapped.rateLimit.state);
      return {
        ok: true,
        value: mergeBundledPullRequestsResults(
          pages,
          normalized,
          GitHubBundledPullRequestsStopReason.TargetFound
        ),
      };
    }
    if (mapped.rateLimit.state === GitHubProviderBudgetState.Low) {
      recordBackoff(ghPath, LOW_BUDGET_BACKOFF_MS);
      return {
        ok: true,
        value: mergeBundledPullRequestsResults(
          pages,
          normalized,
          GitHubBundledPullRequestsStopReason.BudgetLow
        ),
      };
    }
    if (!(mapped.pageInfo?.hasNextPage && mapped.pageInfo.endCursor)) {
      return {
        ok: true,
        value: mergeBundledPullRequestsResults(pages, normalized),
      };
    }
    after = mapped.pageInfo.endCursor;
  }

  return {
    ok: true,
    value: mergeBundledPullRequestsResults(pages, normalized),
  };
}

export function resetGhGraphqlTransportForTests(): void {
  queue.length = 0;
  activeCount = 0;
  backoffByGhPath.clear();
}

function enqueue<T>(run: () => Promise<GhGraphqlResult<T>>) {
  return new Promise<GhGraphqlResult<T>>((resolve, reject) => {
    queue.push({ run, resolve, reject } as QueueTask<unknown>);
    drainQueue();
  });
}

function drainQueue(): void {
  while (activeCount < GH_GRAPHQL_CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      return;
    }
    activeCount += 1;
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1;
        drainQueue();
      });
  }
}

function classifyGhGraphqlFailure(
  error: unknown,
  ghPath: string
): GhGraphqlResult<never> {
  const text = String(
    (error as { stderr?: string; stdout?: string; message?: string }).stderr ??
      (error as { stdout?: string }).stdout ??
      (error as Error).message ??
      error
  ).toLowerCase();
  if (isGhGraphqlTimeout(error)) {
    return { ok: false, reason: "timeout", retryAfterMs: null };
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return { ok: false, reason: "timeout", retryAfterMs: null };
  }
  if (text.includes("secondary rate limit")) {
    recordBackoff(ghPath, LOW_BUDGET_BACKOFF_MS);
    return {
      ok: false,
      reason: "secondary_limited",
      retryAfterMs: LOW_BUDGET_BACKOFF_MS,
    };
  }
  if (text.includes("rate limit")) {
    recordBackoff(ghPath, LOW_BUDGET_BACKOFF_MS);
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs: LOW_BUDGET_BACKOFF_MS,
    };
  }
  if (text.includes("authentication") || text.includes("gh auth login")) {
    return { ok: false, reason: "auth_required", retryAfterMs: null };
  }
  if (text.includes("json")) {
    return { ok: false, reason: "invalid_response", retryAfterMs: null };
  }
  return { ok: false, reason: "gh_unavailable", retryAfterMs: null };
}

function countBundledPullRequests(
  pages: readonly GitHubBundledPullRequestsResult[]
): number {
  return pages.reduce((total, page) => total + page.pullRequests.length, 0);
}

function bundledPullRequestPagesFoundAllTargets(
  pages: readonly GitHubBundledPullRequestsResult[],
  targetNumbers: readonly number[]
): boolean {
  return (
    targetNumbers.length > 0 &&
    bundledPullRequestsFoundAllTargets(
      pages.flatMap((current) => current.pullRequests),
      targetNumbers
    )
  );
}

function recordLowBudgetBackoff(
  ghPath: string,
  state: GitHubProviderBudgetState
): void {
  if (state === GitHubProviderBudgetState.Low) {
    recordBackoff(ghPath, LOW_BUDGET_BACKOFF_MS);
  }
}

function isGhGraphqlTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "killed" in error &&
    (error as { killed?: unknown }).killed === true
  );
}

function getRemainingBackoffMs(ghPath: string): number | null {
  const until = backoffByGhPath.get(ghPath);
  if (!until) {
    return null;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    backoffByGhPath.delete(ghPath);
    return null;
  }
  return remaining;
}

function recordBackoff(ghPath: string, durationMs: number): void {
  if (backoffByGhPath.size >= BACKOFF_CACHE_MAX_SIZE) {
    const oldestKey = backoffByGhPath.keys().next().value;
    if (oldestKey) {
      backoffByGhPath.delete(oldestKey);
    }
  }
  backoffByGhPath.set(ghPath, Date.now() + durationMs);
}
