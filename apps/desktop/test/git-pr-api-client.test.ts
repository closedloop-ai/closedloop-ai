import assert from "node:assert/strict";
import {
  DesktopGithubPullRequestApiTimeoutMs,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  type DesktopGithubPullRequestRequest,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { describe, test } from "vitest";
import {
  buildGitPullRequestApiOptions,
  callGitPullRequestApi,
  type DesktopGatewayGitPullRequestSessionAccess,
} from "../src/server/operations/git-pr-api-client.js";

describe("callGitPullRequestApi", () => {
  test("uses the shared PR API timeout instead of the generic session default", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: true,
          data: {
            success: true,
            contractVersion: DesktopGithubPullRequestContractVersion,
            mode: DesktopGithubPullRequestSuccessMode.Create,
            status: DesktopGithubPullRequestStatus.Created,
            pullRequest: {
              number: 42,
              url: "https://github.test/closedloop-ai/closedloop-ai/pull/42",
            },
          },
        },
        200
      ),
    ]);
    const originalTimeout = AbortSignal.timeout;
    const timeoutCalls: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (timeoutMs: number) => {
        timeoutCalls.push(timeoutMs);
        return new AbortController().signal;
      },
    });

    try {
      await callGitPullRequestApi(
        sessionOptions(api.fetch),
        createRequest(),
        DesktopGithubPullRequestStage.ApiCreate
      );
    } finally {
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: originalTimeout,
      });
    }

    assert.deepEqual(timeoutCalls, [DesktopGithubPullRequestApiTimeoutMs]);
  });

  for (const status of [404, 405, 410, 501]) {
    test(`classifies HTTP ${status} as API-incompatible without retry budget burn`, async () => {
      const api = makeFetch([
        jsonResponse({ success: false, error: "missing route" }, status),
      ]);

      const result = await callGitPullRequestApi(
        sessionOptions(api.fetch),
        preflightRequest(),
        DesktopGithubPullRequestStage.ApiPreflight
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(
          result.error.code,
          DesktopGithubPullRequestErrorCode.ApiIncompatible
        );
        assert.equal(
          result.error.reason,
          DesktopGithubPullRequestReason.ApiIncompatible
        );
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.burnRetryBudget, false);
      }
    });
  }

  test("preserves structured provider 404 failures from the PR API", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "GitHub could not find the pushed branch",
          code: DesktopGithubPullRequestErrorCode.BranchUnavailable,
          details: {
            reason: DesktopGithubPullRequestReason.BranchUnavailable,
            stage: DesktopGithubPullRequestStage.ApiCreate,
            retryable: false,
            burnRetryBudget: false,
          },
        },
        404
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.BranchUnavailable
      );
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.BranchUnavailable
      );
      assert.equal(result.error.stage, DesktopGithubPullRequestStage.ApiCreate);
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("classifies malformed success responses as API-incompatible", async () => {
    const api = makeFetch([
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.ApiIncompatible
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("classifies response body read failures as retryable unavailable", async () => {
    const api = makeFetch([responseWithRejectedText(503)]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.TransientUnavailable
      );
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("classifies network failures as retryable unavailable without burning budget", async () => {
    const api = makeFetch([new Error("ECONNRESET")]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.TransientUnavailable
      );
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("classifies timeout failures as retryable unavailable without burning budget", async () => {
    const api = makeFetch([
      new DOMException("The operation timed out", "TimeoutError"),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.TransientUnavailable
      );
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("does not fetch when the API origin is missing", async () => {
    const api = makeFetch([]);

    const result = await callGitPullRequestApi(
      {
        fetch: api.fetch,
        getAccessToken: () => Promise.resolve("desktop-token"),
        getApiOrigin: () => undefined,
      },
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.OperationUnavailable
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
    assert.equal(api.calls.length, 0);
  });

  test("does not fetch when the session token is missing", async () => {
    const api = makeFetch([]);

    const result = await callGitPullRequestApi(
      {
        fetch: api.fetch,
        getAccessToken: () => Promise.resolve(null),
        getApiOrigin: () => "https://api.closedloop.test",
      },
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.AuthenticationRequired
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
    assert.equal(api.calls.length, 0);
  });

  test("uses first-party failure details when the API returns them", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "repo denied",
          code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
          details: {
            reason: DesktopGithubPullRequestReason.AuthorizationDenied,
            denial: GitHubAccessDenialReason.NoInstallation,
            stage: DesktopGithubPullRequestStage.ApiCreate,
            retryable: false,
            burnRetryBudget: false,
          },
        },
        403
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.AuthorizationDenied
      );
      assert.equal(
        result.error.denial,
        GitHubAccessDenialReason.NoInstallation
      );
      assert.equal(result.error.stage, DesktopGithubPullRequestStage.ApiCreate);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("maps unknown first-party failure details through the PR-specific status classifier", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "unknown reason",
          code: DesktopGithubPullRequestErrorCode.ProviderRejected,
          details: {
            reason: "new_future_reason",
            stage: DesktopGithubPullRequestStage.ApiCreate,
            retryable: true,
            burnRetryBudget: false,
          },
        },
        503
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.TransientUnavailable
      );
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("carries first-party retry budget details from failure bodies", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "rate limited",
          code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
          details: {
            reason: DesktopGithubPullRequestReason.ProviderRateLimited,
            stage: DesktopGithubPullRequestStage.ApiCreate,
            retryable: true,
            burnRetryBudget: true,
          },
        },
        429
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.ProviderRateLimited
      );
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.burnRetryBudget, true);
    }
  });

  test("defaults missing first-party retry budget details to no burn", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "old first-party failure body",
          code: DesktopGithubPullRequestErrorCode.ProviderRejected,
          details: {
            reason: DesktopGithubPullRequestReason.ProviderRejected,
            stage: DesktopGithubPullRequestStage.ApiCreate,
            retryable: false,
          },
        },
        409
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.ProviderRejected
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("accepts extra response fields without breaking the known success contract", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: true,
          data: {
            success: true,
            contractVersion: DesktopGithubPullRequestContractVersion,
            mode: DesktopGithubPullRequestSuccessMode.Preflight,
            status: DesktopGithubPullRequestStatus.Available,
            repository: {
              fullName: "closedloop-ai/closedloop-ai",
              defaultBranch: "main",
            },
            identity: { login: "daveth" },
            futureField: "ignored",
          },
        },
        200
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.value.status,
        DesktopGithubPullRequestStatus.Available
      );
      if (result.value.mode === DesktopGithubPullRequestSuccessMode.Preflight) {
        assert.equal(result.value.repository.defaultBranch, "main");
      }
    }
  });

  test("classifies create success without PR identity as API-incompatible", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: true,
          data: {
            success: true,
            contractVersion: DesktopGithubPullRequestContractVersion,
            mode: DesktopGithubPullRequestSuccessMode.Create,
            status: DesktopGithubPullRequestStatus.Created,
            pullRequest: {
              headBranch: "feature/no-gh-pr-create",
            },
          },
        },
        200
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.ApiIncompatible
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("classifies preflight success with the wrong mode as API-incompatible", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: true,
          data: {
            success: true,
            contractVersion: DesktopGithubPullRequestContractVersion,
            mode: DesktopGithubPullRequestSuccessMode.Create,
            status: DesktopGithubPullRequestStatus.Created,
            pullRequest: {
              number: 42,
              url: "https://github.test/closedloop-ai/closedloop-ai/pull/42",
            },
          },
        },
        200
      ),
    ]);

    const result = await callGitPullRequestApi(
      sessionOptions(api.fetch),
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.reason,
        DesktopGithubPullRequestReason.ApiIncompatible
      );
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.burnRetryBudget, false);
    }
  });

  test("invalidates the rejected access token on HTTP 401", async () => {
    const api = makeFetch([jsonResponse({ success: false, error: "no" }, 401)]);
    let invalidatedToken: string | null = null;

    const result = await callGitPullRequestApi(
      {
        ...sessionOptions(api.fetch),
        invalidateAccessToken: (rejectedToken) => {
          invalidatedToken = rejectedToken;
        },
      },
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    assert.equal(invalidatedToken, "desktop-token");
  });

  test("does not invalidate the desktop session token for first-party GitHub auth failures", async () => {
    const api = makeFetch([
      jsonResponse(
        {
          success: false,
          error: "GitHub authentication is required",
          code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
          details: {
            reason: DesktopGithubPullRequestReason.AuthenticationRequired,
            denial: GitHubAccessDenialReason.NotConnected,
            stage: DesktopGithubPullRequestStage.ApiPreflight,
            retryable: false,
            burnRetryBudget: false,
          },
        },
        401
      ),
    ]);
    let invalidatedToken: string | null = null;

    const result = await callGitPullRequestApi(
      {
        ...sessionOptions(api.fetch),
        invalidateAccessToken: (rejectedToken) => {
          invalidatedToken = rejectedToken;
        },
      },
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    assert.equal(invalidatedToken, null);
  });

  test("does not fetch when no session token provider is wired", async () => {
    const api = makeFetch([]);

    const result = await callGitPullRequestApi(
      { fetch: api.fetch, getApiOrigin: () => "https://api.closedloop.test" },
      preflightRequest(),
      DesktopGithubPullRequestStage.ApiPreflight
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.OperationUnavailable
      );
      assert.equal(
        result.error.stage,
        DesktopGithubPullRequestStage.ApiPreflight
      );
      assert.equal(result.error.retryable, false);
    }
    assert.equal(api.calls.length, 0);
  });

  test("does not fetch when no API origin provider is wired", async () => {
    const api = makeFetch([]);

    const result = await callGitPullRequestApi(
      { fetch: api.fetch, getAccessToken: () => Promise.resolve("t") },
      createRequest(),
      DesktopGithubPullRequestStage.ApiCreate
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        DesktopGithubPullRequestErrorCode.OperationUnavailable
      );
      assert.equal(result.error.stage, DesktopGithubPullRequestStage.ApiCreate);
    }
    assert.equal(api.calls.length, 0);
  });
});

describe("buildGitPullRequestApiOptions", () => {
  test("returns undefined when neither session access nor an origin getter is given", () => {
    assert.equal(
      buildGitPullRequestApiOptions(undefined, undefined),
      undefined
    );
  });

  test("returns an options object without getAccessToken when only the origin getter is given", () => {
    const options = buildGitPullRequestApiOptions(
      undefined,
      () => "https://api.closedloop.test"
    );
    assert.ok(options);
    assert.equal(options?.getApiOrigin?.(), "https://api.closedloop.test");
    assert.equal(Object.hasOwn(options ?? {}, "getAccessToken"), false);
  });

  test("delegates getAccessToken and forwards the rejected token to invalidateAccessToken", async () => {
    const invalidated: Array<string | undefined> = [];
    const sessionAccess: DesktopGatewayGitPullRequestSessionAccess = {
      getAccessToken: () => Promise.resolve("session-token"),
      invalidateAccessToken: (rejectedToken) => {
        invalidated.push(rejectedToken);
      },
    };

    const options = buildGitPullRequestApiOptions(sessionAccess, undefined);

    assert.ok(options);
    assert.equal(await options?.getAccessToken?.(), "session-token");
    options?.invalidateAccessToken?.("rejected-token");
    assert.deepEqual(invalidated, ["rejected-token"]);
  });
});

type DesktopGithubPullRequestPreflightRequest = Extract<
  DesktopGithubPullRequestRequest,
  { mode: typeof DesktopGithubPullRequestMode.Preflight }
>;

type DesktopGithubPullRequestCreateRequest = Extract<
  DesktopGithubPullRequestRequest,
  { mode: typeof DesktopGithubPullRequestMode.Create }
>;

function preflightRequest(): DesktopGithubPullRequestPreflightRequest {
  return {
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "closedloop-ai/closedloop-ai",
  };
}

function createRequest(): DesktopGithubPullRequestCreateRequest {
  return {
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Create,
    repoFullName: "closedloop-ai/closedloop-ai",
    headBranch: "feature/no-gh-pr-create",
    title: "Retire gh",
    body: "Use server-backed PR creation",
  };
}

function sessionOptions(fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve("desktop-token"),
    getApiOrigin: () => "https://api.closedloop.test",
  };
}

type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
};

function makeFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responseWithRejectedText(status: number): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "text", {
    value: () => Promise.reject(new Error("body stream reset")),
  });
  return response;
}
