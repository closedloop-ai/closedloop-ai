import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "../index";
import {
  classifyBundledRepositoryAccessFailure,
  classifyGitHubProviderError,
  getGitHubRetryAfterSeconds,
} from "../provider-error-classification";

const NOW_MS = Date.parse("2026-06-01T12:00:00Z");

describe("GitHub provider error shapes", () => {
  it("reads nested response metadata and Headers-compatible values", () => {
    const headers = new Headers({ "retry-after": " 4 " });

    expect(
      getGitHubRetryAfterSeconds({ response: { status: 429, headers } }, NOW_MS)
    ).toBe(4);
    expect(
      classifyGitHubProviderError(
        { response: { status: 429, headers } },
        NOW_MS
      )
    ).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 4,
    });
  });

  it("ignores invalid reset epochs", () => {
    expect(
      getGitHubRetryAfterSeconds(
        { status: 429, headers: { "x-ratelimit-reset": "invalid" } },
        NOW_MS
      )
    ).toBeNull();
  });

  it("ignores malformed provider envelopes and header adapters", () => {
    expect(classifyGitHubProviderError(null, NOW_MS)).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    expect(
      classifyGitHubProviderError(
        { response: { status: "429", headers: "invalid" } },
        NOW_MS
      )
    ).toEqual({ status: GitHubProviderResultStatus.ProviderUnavailable });
    expect(
      classifyGitHubProviderError(
        { response: "invalid", errors: [null] },
        NOW_MS
      )
    ).toEqual({ status: GitHubProviderResultStatus.ProviderUnavailable });
    expect(
      getGitHubRetryAfterSeconds({ headers: { get: () => "   " } }, NOW_MS)
    ).toBeNull();
    expect(
      getGitHubRetryAfterSeconds({ headers: { get: () => 42 } }, NOW_MS)
    ).toBeNull();
    expect(
      getGitHubRetryAfterSeconds(
        { headers: { "x-ratelimit-reset": 42 } },
        NOW_MS
      )
    ).toBeNull();
  });

  describe("classifyBundledRepositoryAccessFailure via queryBundledPullRequestsWithProviderResult (ISS-5093)", () => {
    // Cases 1-5 drive the REAL PRODUCTION SEAM: queryBundledPullRequestsWithProviderResult
    // calls resolveBundledPullRequestsPageFailure which calls
    // classifyBundledRepositoryAccessFailure. Testing through this seam ensures a
    // deleted call site in index.ts makes the suite go red — a direct helper-only
    // test stays green after the call site is removed.
    //
    // All error objects are production-shaped GraphqlResponseError values: they carry
    // `errors` and `data` but NO `status` key, because octokit's graphql() throws
    // after a successful HTTP 200 once it sees errors in the response body.

    it("seam: root NOT_FOUND GraphQL error resolves to ProviderRepoNotFound", async () => {
      const error = {
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository"],
            message:
              "Could not resolve to a Repository with the name 'acme/widgets'.",
          },
        ],
        data: { repository: null },
      };
      const octokit = {
        graphql: vi.fn().mockRejectedValue(error),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result.status).toBe(
        GitHubProviderResultStatus.ProviderRepoNotFound
      );
    });

    // The blocker this status exists for: a 403 on a LATER page cannot be a
    // repo-level denial, because page 1 already reached the repo. Before the
    // split, both this and a guarded root FORBIDDEN surfaced as
    // ProviderPermissionFiltered, so the reconciler recorded a 6h no-access
    // verdict against a healthy credential and demoted the repo to unsyncable.
    it("seam: an HTTP 403 on page 2 stays ProviderPermissionFiltered, never a repo verdict", async () => {
      const firstPage = {
        rateLimit: { cost: 1, remaining: 4999, resetAt: null },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [],
          },
        },
      };
      const octokit = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce(firstPage)
          .mockRejectedValueOnce({
            status: 403,
            message: "Resource not accessible by integration",
          }),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result.status).not.toBe(
        GitHubProviderResultStatus.ProviderRepoForbidden
      );
      expect(result.status).not.toBe(
        GitHubProviderResultStatus.ProviderRepoNotFound
      );
    });

    it("seam: root FORBIDDEN GraphQL error resolves to ProviderRepoForbidden", async () => {
      const error = {
        errors: [
          {
            type: "FORBIDDEN",
            path: ["repository"],
            message: "Resource not accessible by integration.",
          },
        ],
        data: { repository: null },
      };
      const octokit = {
        graphql: vi.fn().mockRejectedValue(error),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result.status).toBe(
        GitHubProviderResultStatus.ProviderRepoForbidden
      );
    });

    it("seam: nested NOT_FOUND under a resolved repository resolves to ProviderUnavailable — misclassifying as ProviderRepoNotFound would exclude a healthy credential for 6 hours (credential-poisoning guard)", async () => {
      const error = {
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "pullRequests", "nodes", 0, "author"],
          },
        ],
        data: { repository: { pullRequests: { nodes: [] } } },
      };
      const octokit = {
        graphql: vi.fn().mockRejectedValue(error),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result.status).toBe(
        GitHubProviderResultStatus.ProviderUnavailable
      );
    });

    it("seam: NOT_FOUND with no path cannot be attributed to the repository selection and resolves to ProviderUnavailable", async () => {
      const error = {
        errors: [{ type: "NOT_FOUND", message: "Not found" }],
        data: { repository: null },
      };
      const octokit = {
        graphql: vi.fn().mockRejectedValue(error),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result.status).toBe(
        GitHubProviderResultStatus.ProviderUnavailable
      );
    });

    it("seam: GraphQL RATE_LIMITED envelope takes rate-limit precedence over repository-access analysis and resolves to ProviderRateLimit", async () => {
      const error = {
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      };
      const octokit = {
        graphql: vi.fn().mockRejectedValue(error),
      } as unknown as Octokit;

      const result = await queryBundledPullRequestsWithProviderResult(
        octokit,
        "acme",
        "widgets",
        []
      );

      expect(result).toEqual({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds: null,
      });
    });

    it("root NOT_FOUND with pagesFetched > 0 returns null from the helper — already-fetched pages must not be discarded because of a later-page error", () => {
      const error = {
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository"],
            message:
              "Could not resolve to a Repository with the name 'acme/widgets'.",
          },
        ],
        data: { repository: null },
      };

      expect(classifyBundledRepositoryAccessFailure(error, 1)).toBeNull();
    });

    it("hostile repo name containing 'rate-limit' does not suppress the no-access verdict", () => {
      const error = {
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository"],
            message:
              "Could not resolve to a Repository with the name 'evil-corp/rate-limit-testing'.",
          },
        ],
        data: { repository: null },
      };

      const result = classifyBundledRepositoryAccessFailure(error, 0);

      expect(result).toEqual({
        status: GitHubProviderResultStatus.ProviderRepoNotFound,
      });
    });

    it("REST-shaped { status: 404 } through classifyGitHubProviderError stays ProviderUnavailable — ISS-5093 did not change REST reader semantics", () => {
      expect(classifyGitHubProviderError({ status: 404 })).toEqual({
        status: GitHubProviderResultStatus.ProviderUnavailable,
      });
    });
  });
});
