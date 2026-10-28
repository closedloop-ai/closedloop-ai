import { boundedFetch } from "./bounded-fetch";

/** A content-read budget belongs to one operation, never a cached Octokit. */
export type GitHubOperationReadBudget = {
  fetch: typeof fetch;
  exhausted: () => boolean;
  requestsUsed: () => number;
  requestsRemaining: () => number;
  withRequestLimit: <T>(limit: number, read: () => Promise<T>) => Promise<T>;
  dispose: () => void;
};

/** Share the physical fetch ceiling and cancellation deadline across REST and GraphQL. */
export function createGitHubOperationReadBudget(input: {
  maxRequests: number;
  maxDurationMs: number;
  fetch?: typeof fetch;
}): GitHubOperationReadBudget {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.maxDurationMs);
  const baseFetch = input.fetch ?? boundedFetch;
  let requestsUsed = 0;
  let requestCeiling = input.maxRequests;
  return {
    fetch: (request, init) => {
      if (controller.signal.aborted || requestsUsed >= requestCeiling) {
        return Promise.reject(
          new Error("GitHub operation read budget exhausted")
        );
      }
      requestsUsed += 1;
      const signal = init?.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      return baseFetch(request, { ...init, signal });
    },
    exhausted: () =>
      controller.signal.aborted || requestsUsed >= requestCeiling,
    requestsUsed: () => requestsUsed,
    requestsRemaining: () => Math.max(0, requestCeiling - requestsUsed),
    // Phase limits are sequential: nested discovery cannot consume verification's reserve.
    withRequestLimit: async (limit, read) => {
      const previousCeiling = requestCeiling;
      requestCeiling = Math.min(previousCeiling, requestsUsed + limit);
      try {
        return await read();
      } finally {
        requestCeiling = previousCeiling;
      }
    },
    dispose: () => clearTimeout(timer),
  };
}
