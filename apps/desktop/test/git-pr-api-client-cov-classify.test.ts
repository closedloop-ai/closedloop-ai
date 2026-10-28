/**
 * ISS-11282 — branch coverage for git-pr-api-client.ts response
 * classification: unreadable bodies on incompatible and server-error statuses,
 * a 2xx carrying a failure body, a create stage answered in preflight mode,
 * non-first-party 403 / 429 / 4xx statuses, a first-party failure without an
 * error string, and the global-fetch default when no fetch is injected.
 */
import {
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  type DesktopGithubPullRequestPreflightRequest,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  callGitPullRequestApi,
  type GitPullRequestApiOptions,
} from "../src/server/operations/git-pr-api-client.js";

const API_ORIGIN = "https://api.closedloop.test";

const PREFLIGHT_REQUEST: DesktopGithubPullRequestPreflightRequest = {
  contractVersion: DesktopGithubPullRequestContractVersion,
  mode: DesktopGithubPullRequestMode.Preflight,
  repoFullName: "acme/widgets",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function options(response: Response): GitPullRequestApiOptions {
  return {
    fetch: () => Promise.resolve(response),
    getAccessToken: () => Promise.resolve("desktop-token"),
    getApiOrigin: () => API_ORIGIN,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function callPreflight(response: Response) {
  return callGitPullRequestApi(
    options(response),
    PREFLIGHT_REQUEST,
    DesktopGithubPullRequestStage.ApiPreflight
  );
}

function expectedFailure(input: {
  status: number;
  code: DesktopGithubPullRequestErrorCode;
  reason: DesktopGithubPullRequestReason;
  error: string;
  retryable: boolean;
  stage?: DesktopGithubPullRequestStage;
}) {
  return {
    ok: false,
    error: {
      success: false,
      error: input.error,
      code: input.code,
      reason: input.reason,
      stage: input.stage ?? DesktopGithubPullRequestStage.ApiPreflight,
      retryable: input.retryable,
      burnRetryBudget: false,
      status: input.status,
    },
  };
}

const API_INCOMPATIBLE_ERROR =
  "Desktop pull request API is incompatible or missing on the configured server.";

describe("callGitPullRequestApi — unreadable bodies", () => {
  test("an empty body on a 5xx that is also an incompatible status is API-incompatible, not transient", async () => {
    const result = await callPreflight(new Response("", { status: 501 }));

    expect(result).toEqual(
      expectedFailure({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
        reason: DesktopGithubPullRequestReason.ApiIncompatible,
        error: API_INCOMPATIBLE_ERROR,
        retryable: false,
      })
    );
  });

  test("an invalid JSON body on HTTP 500 is transient and retryable", async () => {
    const result = await callPreflight(
      new Response("<html>bad gateway</html>", { status: 500 })
    );

    expect(result).toEqual(
      expectedFailure({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
        reason: DesktopGithubPullRequestReason.TransientUnavailable,
        error: "Desktop pull request API is temporarily unavailable.",
        retryable: true,
      })
    );
  });
});

describe("callGitPullRequestApi — 2xx bodies", () => {
  test("a 2xx carrying a contract failure body is returned as that failure with status 500", async () => {
    const failure = {
      success: false,
      error: "GitHub refused the request",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage: DesktopGithubPullRequestStage.Provider,
      retryable: false,
      burnRetryBudget: true,
    };

    const result = await callPreflight(jsonResponse(failure, 200));

    expect(result).toEqual({ ok: false, error: { ...failure, status: 500 } });
  });

  test("a create stage answered with a preflight-mode success is API-incompatible", async () => {
    const preflightSuccess = {
      success: true,
      data: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Preflight,
        status: DesktopGithubPullRequestStatus.Available,
        repository: { fullName: "acme/widgets" },
        identity: { login: "daveth" },
      },
    };

    const result = await callGitPullRequestApi(
      options(jsonResponse(preflightSuccess, 200)),
      PREFLIGHT_REQUEST,
      DesktopGithubPullRequestStage.ApiCreate
    );

    expect(result).toEqual(
      expectedFailure({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
        reason: DesktopGithubPullRequestReason.ApiIncompatible,
        error: API_INCOMPATIBLE_ERROR,
        retryable: false,
        stage: DesktopGithubPullRequestStage.ApiCreate,
      })
    );
  });
});

describe("callGitPullRequestApi — non-first-party error statuses", () => {
  test.each([
    {
      status: 401,
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      error: "Desktop session authentication is required.",
      retryable: false,
    },
    {
      status: 403,
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      error: "Desktop GitHub pull request operation is not authorized.",
      retryable: false,
    },
    {
      status: 429,
      code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
      reason: DesktopGithubPullRequestReason.ProviderRateLimited,
      error: "GitHub rate limited pull request creation.",
      retryable: true,
    },
    {
      status: 500,
      code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
      reason: DesktopGithubPullRequestReason.TransientUnavailable,
      error: "Desktop pull request API is temporarily unavailable.",
      retryable: true,
    },
    {
      status: 422,
      code: DesktopGithubPullRequestErrorCode.OperationUnavailable,
      reason: DesktopGithubPullRequestReason.OperationUnavailable,
      error: "Desktop GitHub pull request operation is unavailable.",
      retryable: false,
    },
  ])(
    "HTTP $status with a body that is not a failure envelope maps to $code",
    async (expected) => {
      const result = await callPreflight(
        jsonResponse({ message: "upstream said no" }, expected.status)
      );

      const failureStatus = expected.status >= 500 ? 503 : expected.status;
      expect(result).toEqual(
        expectedFailure({ ...expected, status: failureStatus })
      );
    }
  );

  test("a first-party failure without an error string falls back to 'Request failed'", async () => {
    const result = await callPreflight(
      jsonResponse(
        {
          success: false,
          error: 42,
          code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
          details: {
            reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
            retryable: false,
          },
        },
        409
      )
    );

    expect(result).toEqual(
      expectedFailure({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
        reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
        error: "Request failed",
        retryable: false,
      })
    );
  });
});

describe("callGitPullRequestApi — fetch default", () => {
  test("without an injected fetch the global fetch carries the request", async () => {
    const globalFetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 404 }))
    );
    vi.stubGlobal("fetch", globalFetch);

    const result = await callGitPullRequestApi(
      {
        getAccessToken: () => Promise.resolve("desktop-token"),
        getApiOrigin: () => API_ORIGIN,
      },
      PREFLIGHT_REQUEST,
      DesktopGithubPullRequestStage.ApiPreflight
    );

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        DesktopGithubPullRequestErrorCode.ApiIncompatible
      );
    }
  });
});

describe("callGitPullRequestApi — unreadable bodies on client-error statuses", () => {
  test.each([
    { label: "an empty 400", body: "", status: 400, invalidated: [] },
    {
      label: "an empty 401",
      body: "",
      status: 401,
      invalidated: ["desktop-token"],
    },
    {
      label: "an invalid JSON 401",
      body: "<html>login</html>",
      status: 401,
      invalidated: ["desktop-token"],
    },
  ])("$label is API-incompatible", async ({ body, status, invalidated }) => {
    const rejected: string[] = [];

    const result = await callGitPullRequestApi(
      {
        ...options(new Response(body, { status })),
        invalidateAccessToken: (token) => {
          rejected.push(token);
        },
      },
      PREFLIGHT_REQUEST,
      DesktopGithubPullRequestStage.ApiPreflight
    );

    // pins current behavior; looks odd because an unreadable 401 is reported
    // as API-incompatible rather than authentication-required, even though the
    // session token is invalidated for it.
    expect(result).toEqual(
      expectedFailure({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
        reason: DesktopGithubPullRequestReason.ApiIncompatible,
        error: API_INCOMPATIBLE_ERROR,
        retryable: false,
      })
    );
    expect(rejected).toEqual(invalidated);
  });

  test("a body that cannot be read on an incompatible status is transient, not incompatible", async () => {
    const response = new Response(null, { status: 404 });
    Object.defineProperty(response, "text", {
      value: () => Promise.reject(new Error("body stream reset")),
    });

    const result = await callPreflight(response);

    expect(result).toEqual(
      expectedFailure({
        status: 503,
        code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
        reason: DesktopGithubPullRequestReason.TransientUnavailable,
        error: "Desktop pull request API is temporarily unavailable.",
        retryable: true,
      })
    );
  });
});

describe("callGitPullRequestApi — first-party failure recognition", () => {
  test("a 403 with contract fields but no success:false is a plain authorization denial", async () => {
    const result = await callPreflight(
      jsonResponse(
        {
          error: "GitHub refused",
          code: DesktopGithubPullRequestErrorCode.ProviderRejected,
          details: {
            reason: DesktopGithubPullRequestReason.ProviderRejected,
            retryable: false,
          },
        },
        403
      )
    );

    expect(result).toEqual(
      expectedFailure({
        status: 403,
        code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
        reason: DesktopGithubPullRequestReason.AuthorizationDenied,
        error: "Desktop GitHub pull request operation is not authorized.",
        retryable: false,
      })
    );
  });

  test("a success:false failure without a boolean retryable is not first-party", async () => {
    const result = await callPreflight(
      jsonResponse(
        {
          success: false,
          error: "GitHub refused",
          code: DesktopGithubPullRequestErrorCode.ProviderRejected,
          details: { reason: DesktopGithubPullRequestReason.ProviderRejected },
        },
        409
      )
    );

    expect(result).toEqual(
      expectedFailure({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.OperationUnavailable,
        reason: DesktopGithubPullRequestReason.OperationUnavailable,
        error: "Desktop GitHub pull request operation is unavailable.",
        retryable: false,
      })
    );
  });

  test("a first-party failure keeps the server's error string", async () => {
    const result = await callPreflight(
      jsonResponse(
        {
          success: false,
          error: "GitHub said no",
          code: DesktopGithubPullRequestErrorCode.ProviderRejected,
          details: {
            reason: DesktopGithubPullRequestReason.ProviderRejected,
            retryable: true,
          },
        },
        409
      )
    );

    expect(result).toEqual(
      expectedFailure({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.ProviderRejected,
        reason: DesktopGithubPullRequestReason.ProviderRejected,
        error: "GitHub said no",
        retryable: true,
      })
    );
  });
});
