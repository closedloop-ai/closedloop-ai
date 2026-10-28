import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { linearConfig, mockLinearClient, mockLog, mockParseError, mockFetch } =
  vi.hoisted(() => ({
    linearConfig: {
      LINEAR_CLIENT_ID: "linear-client-id" as string | undefined,
      LINEAR_CLIENT_SECRET: "linear-client-secret" as string | undefined,
    },
    mockLinearClient: vi.fn(function (this: Record<string, unknown>, options) {
      this.options = options;
    }),
    mockLog: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    mockParseError: vi.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    ),
    mockFetch: vi.fn(),
  }));

vi.mock("@linear/sdk", () => ({
  LinearClient: mockLinearClient,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: mockParseError,
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

vi.mock("./keys", () => ({
  keys: () => linearConfig,
}));

import {
  createIssue,
  createIssues,
  createLinearClient,
  exchangeCodeForTokens,
  getTeams,
  getViewer,
  refreshAccessToken,
  revokeToken,
} from "./index";

describe("Linear OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    linearConfig.LINEAR_CLIENT_ID = "linear-client-id";
    linearConfig.LINEAR_CLIENT_SECRET = "linear-client-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects OAuth calls when either required credential is absent", async () => {
    linearConfig.LINEAR_CLIENT_SECRET = undefined;

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow("Linear integration not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("exchanges an authorization code and preserves optional token fields", async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read,write",
      })
    );

    const result = await exchangeCodeForTokens(
      "authorization-code",
      "pkce-verifier",
      "https://app.test/callback"
    );

    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: ["read", "write"],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.linear.app/oauth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(firstRequestBody()).toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "linear-client-id",
        client_secret: "linear-client-secret",
        redirect_uri: "https://app.test/callback",
        code: "authorization-code",
        code_verifier: "pkce-verifier",
      })
    );
  });

  it("defaults absent exchange response fields and reports a redacted HTTP failure", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({ access_token: "access-token", token_type: "Bearer" })
      )
      .mockResolvedValueOnce(
        response(
          `{"error":"invalid_grant","access_token":"${SYNTHETIC_ACCESS_TOKEN}"}`,
          {
            status: 401,
          }
        )
      );

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: "Bearer",
      scope: [],
    });
    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow("Token exchange failed: 401");
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token exchange failed",
      {
        status: 401,
        error: '{"error":"invalid_grant","access_token":"[REDACTED]"}',
      }
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token exchange error",
      { error: "Token exchange failed: 401" }
    );
  });

  it("refreshes tokens with both populated and absent optional fields", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 7200,
          token_type: "Bearer",
          scope: "read,issues:create",
        })
      )
      .mockResolvedValueOnce(
        response({ access_token: "sparse-token", token_type: "Bearer" })
      );

    await expect(refreshAccessToken("old-refresh-token")).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 7200,
      tokenType: "Bearer",
      scope: ["read", "issues:create"],
    });
    await expect(refreshAccessToken("next-refresh-token")).resolves.toEqual({
      accessToken: "sparse-token",
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: "Bearer",
      scope: [],
    });
    expect(firstRequestBody()).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "linear-client-id",
        client_secret: "linear-client-secret",
        refresh_token: "old-refresh-token",
      })
    );
  });

  it("redacts refresh HTTP failures before rethrowing", async () => {
    mockFetch.mockResolvedValueOnce(
      response(
        `{"error":"invalid_grant","refresh_token":"${SYNTHETIC_REFRESH_TOKEN}"}`,
        {
          status: 403,
        }
      )
    );

    await expect(refreshAccessToken("refresh-token")).rejects.toThrow(
      "Token refresh failed: 403"
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token refresh failed",
      {
        status: 403,
        error: '{"error":"invalid_grant","refresh_token":"[REDACTED]"}',
      }
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token refresh error",
      { error: "Token refresh failed: 403" }
    );
  });

  it("revokes successfully and treats HTTP or network failures as best effort", async () => {
    mockFetch
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response("already revoked", { status: 409 }))
      .mockRejectedValueOnce(new Error("offline"));

    await expect(revokeToken("first-access-token")).resolves.toBeUndefined();
    await expect(revokeToken("second-access-token")).resolves.toBeUndefined();
    await expect(revokeToken("third-access-token")).resolves.toBeUndefined();

    expect(firstRequestBody()).toEqual(
      new URLSearchParams({ token: "first-access-token" })
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[linear/oauth] Token revocation failed (continuing anyway)",
      { status: 409, error: "already revoked" }
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[linear/oauth] Token revocation error (continuing anyway)",
      { error: "offline" }
    );
  });

  // ISS-6078. The two non-OK branches were already covered; these drive the
  // sinks that were NOT — the outer catches, the revoke response body, and the
  // no-match path — through the real exported functions, asserting on what the
  // logger actually received.
  //
  // Secret-sensitive assertions compare BOOLEANS: an `expect(text)
  // .not.toContain(secret)` renders the credential into stdout, the HTML
  // report, and the JSON results the moment it fails.
  it("redacts token material reaching the exchange OUTER catch", async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(
        `socket hang up posting client_secret=${SYNTHETIC_CLIENT_SECRET}&code=${SYNTHETIC_AUTH_CODE}`
      )
    );

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow("socket hang up");

    const logged = loggedErrorText(
      mockLog.error.mock.calls,
      "[linear/oauth] Token exchange error"
    );
    expect(logged).toBeTypeOf("string");
    expect(containsSecret(logged, SYNTHETIC_CLIENT_SECRET)).toBe(false);
    expect(containsSecret(logged, SYNTHETIC_AUTH_CODE)).toBe(false);
    expect(logged).toContain("[REDACTED]");
  });

  it("redacts token material reaching the refresh OUTER catch", async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(
        `socket hang up posting client_secret=${SYNTHETIC_CLIENT_SECRET}&refresh_token=${SYNTHETIC_REFRESH_TOKEN}`
      )
    );

    await expect(refreshAccessToken(SYNTHETIC_REFRESH_TOKEN)).rejects.toThrow(
      "socket hang up"
    );

    const logged = loggedErrorText(
      mockLog.error.mock.calls,
      "[linear/oauth] Token refresh error"
    );
    expect(logged).toBeTypeOf("string");
    expect(containsSecret(logged, SYNTHETIC_CLIENT_SECRET)).toBe(false);
    expect(containsSecret(logged, SYNTHETIC_REFRESH_TOKEN)).toBe(false);
    expect(logged).toContain("[REDACTED]");
  });

  /**
   * ISS-6078 acceptance criterion 3, answered against the pinned Zod (4.3.x): a
   * `linearTokenResponseSchema.parse` failure CANNOT carry the raw token
   * response into `parseError`. A v4 `invalid_type` issue serializes
   * `expected`/`code`/`path`/`message` only — the received VALUE is not in the
   * `ZodError` message. This test pins that, so a Zod upgrade that starts
   * echoing the input fails here instead of shipping a token into the logs.
   */
  it("keeps a malformed token response out of the outer-catch log", async () => {
    mockFetch.mockResolvedValueOnce(
      response({ access_token: SYNTHETIC_ACCESS_TOKEN, token_type: 42 })
    );

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow();

    // Assert on the PRE-redaction text. `redactTokensFromError` masks any 20+
    // char run unconditionally, so asserting the log sink here would stay green
    // no matter what Zod put in the message — it would pin the redactor, not the
    // Zod invariant this test is named for. `parseError`'s return value is the
    // ZodError message before redaction touches it, so a Zod version that starts
    // echoing the received input turns THIS red.
    const zodErrorMessage = mockParseError.mock.results[0]?.value;
    expect(zodErrorMessage).toBeTypeOf("string");
    expect(containsSecret(zodErrorMessage, SYNTHETIC_ACCESS_TOKEN)).toBe(false);

    const logged = loggedErrorText(
      mockLog.error.mock.calls,
      "[linear/oauth] Token exchange error"
    );
    expect(containsSecret(logged, SYNTHETIC_ACCESS_TOKEN)).toBe(false);
  });

  it("redacts a token-shaped revocation failure body", async () => {
    mockFetch.mockResolvedValueOnce(
      response(`token ${SYNTHETIC_ACCESS_TOKEN} was already revoked`, {
        status: 400,
      })
    );

    await expect(revokeToken(SYNTHETIC_ACCESS_TOKEN)).resolves.toBeUndefined();

    const logged = loggedErrorText(
      mockLog.warn.mock.calls,
      "[linear/oauth] Token revocation failed (continuing anyway)"
    );
    expect(logged).toBeTypeOf("string");
    expect(containsSecret(logged, SYNTHETIC_ACCESS_TOKEN)).toBe(false);
    expect(logged).toContain("[REDACTED]");
  });

  it("leaves an error body with nothing token-shaped unchanged, adding no marker", async () => {
    mockFetch.mockResolvedValueOnce(
      response("invalid grant: code expired", { status: 400 })
    );

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow("Token exchange failed: 400");

    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token exchange failed",
      { status: 400, error: "invalid grant: code expired" }
    );
  });

  /**
   * ISS-6709 (review). The redactor previously masked ANY run of 20+
   * token-alphabet characters, so ordinary diagnostics — a request id, a
   * hostname segment, an error-code name — were destroyed and a `[REDACTED]`
   * marker falsely claimed a secret had been matched. Matching only recognized
   * forms (provider shapes, credential-keyed pairs, and the exact credentials
   * the operation was handed) is what keeps these intact.
   */
  it("keeps long non-sensitive identifiers intact and emits no marker for them", async () => {
    mockFetch.mockResolvedValueOnce(
      response(
        `{"error":"invalid_grant","request_id":"${NON_SENSITIVE_REQUEST_ID}","host":"${NON_SENSITIVE_HOST}","error_code":"${NON_SENSITIVE_ERROR_CODE}"}`,
        { status: 400 }
      )
    );

    await expect(
      exchangeCodeForTokens("code", "verifier", "https://app.test/callback")
    ).rejects.toThrow("Token exchange failed: 400");

    const logged = loggedErrorText(
      mockLog.error.mock.calls,
      "[linear/oauth] Token exchange failed"
    );
    expect(logged).toContain(NON_SENSITIVE_REQUEST_ID);
    expect(logged).toContain(NON_SENSITIVE_HOST);
    expect(logged).toContain(NON_SENSITIVE_ERROR_CODE);
    // Nothing sensitive matched, so no marker may be emitted at all.
    expect(logged).not.toContain("[REDACTED]");
  });

  /**
   * ISS-6709 (review). Sanitizing the log line was not redaction: `throw error`
   * handed the ORIGINAL secret-bearing error to the service layer, and both
   * production callers log `parseError(error)` again in their own catch. This
   * drives the real exported function and inspects what a caller would actually
   * log one frame up.
   */
  it("rethrows a sanitized exchange error that a caller can re-log safely", async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(
        `socket hang up posting client_secret=${SYNTHETIC_CLIENT_SECRET}&code=${SYNTHETIC_AUTH_CODE} (request ${NON_SENSITIVE_REQUEST_ID})`
      )
    );

    const rethrown = await exchangeCodeForTokens(
      SYNTHETIC_AUTH_CODE,
      "verifier",
      "https://app.test/callback"
    ).catch((error: unknown) => error);

    // Exactly what `apps/api/app/integrations/linear/service.ts` does with it.
    const callerLogged = mockParseError(rethrown);
    expect(containsSecret(callerLogged, SYNTHETIC_CLIENT_SECRET)).toBe(false);
    expect(containsSecret(callerLogged, SYNTHETIC_AUTH_CODE)).toBe(false);
    expect(callerLogged).toContain("[REDACTED]");
    // The diagnostic context a responder needs must survive the sanitizing.
    expect(callerLogged).toContain("socket hang up");
    expect(callerLogged).toContain(NON_SENSITIVE_REQUEST_ID);
    // An attached `cause` would put the raw message back within reach.
    expect((rethrown as Error).cause).toBeUndefined();
  });

  it("rethrows a sanitized refresh error that a caller can re-log safely", async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(
        `socket hang up posting client_secret=${SYNTHETIC_CLIENT_SECRET}&refresh_token=${SYNTHETIC_REFRESH_TOKEN}`
      )
    );

    const rethrown = await refreshAccessToken(SYNTHETIC_REFRESH_TOKEN).catch(
      (error: unknown) => error
    );

    const callerLogged = mockParseError(rethrown);
    expect(containsSecret(callerLogged, SYNTHETIC_CLIENT_SECRET)).toBe(false);
    expect(containsSecret(callerLogged, SYNTHETIC_REFRESH_TOKEN)).toBe(false);
    expect(callerLogged).toContain("[REDACTED]");
    expect(callerLogged).toContain("socket hang up");
    expect((rethrown as Error).cause).toBeUndefined();
  });
});

describe("Linear API operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs an authenticated SDK client", () => {
    const client = createLinearClient("access-token");

    expect(mockLinearClient).toHaveBeenCalledWith({
      accessToken: "access-token",
    });
    expect(client).toMatchObject({ options: { accessToken: "access-token" } });
  });

  it("returns viewer organization data and falls back to null on SDK errors", async () => {
    const client = {
      viewer: Promise.resolve({
        organization: Promise.resolve({ id: "org-1", name: "Acme" }),
      }),
    };

    await expect(getViewer(client as never)).resolves.toEqual({
      id: "org-1",
      name: "Acme",
    });
    await expect(
      getViewer({
        viewer: Promise.reject(new Error("viewer unavailable")),
      } as never)
    ).resolves.toBeNull();
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/api] Failed to get viewer",
      { error: "viewer unavailable" }
    );
  });

  it("maps teams and falls back to an empty collection on SDK errors", async () => {
    const client = {
      teams: vi.fn().mockResolvedValue({
        nodes: [
          { id: "team-1", name: "Platform", key: "PLAT" },
          { id: "team-2", name: "Product", key: "PROD" },
        ],
      }),
    };

    await expect(getTeams(client as never)).resolves.toEqual([
      { id: "team-1", name: "Platform", key: "PLAT" },
      { id: "team-2", name: "Product", key: "PROD" },
    ]);
    await expect(
      getTeams({
        teams: vi.fn().mockRejectedValue(new Error("teams down")),
      } as never)
    ).resolves.toEqual([]);
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/api] Failed to get teams",
      { error: "teams down" }
    );
  });

  it("creates an issue and forwards every optional input field", async () => {
    const client = {
      createIssue: vi.fn().mockResolvedValue({
        issue: Promise.resolve({
          id: "issue-id",
          identifier: "ENG-42",
          url: "https://linear.app/issue/ENG-42",
          title: "Ship it",
        }),
      }),
    };

    await expect(
      createIssue(client as never, {
        teamId: "team-1",
        title: "Ship it",
        description: "Behavior first",
        priority: 1,
      })
    ).resolves.toEqual({
      id: "issue-id",
      identifier: "ENG-42",
      url: "https://linear.app/issue/ENG-42",
      title: "Ship it",
    });
    expect(client.createIssue).toHaveBeenCalledWith({
      teamId: "team-1",
      title: "Ship it",
      description: "Behavior first",
      priority: 1,
    });
  });

  it("rejects and logs when the SDK omits the created issue", async () => {
    const client = {
      createIssue: vi.fn().mockResolvedValue({ issue: Promise.resolve(null) }),
    };

    await expect(
      createIssue(client as never, { teamId: "team-1", title: "Missing" })
    ).rejects.toThrow("Failed to create issue");
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/api] Create issue error",
      { title: "Missing", error: "Failed to create issue" }
    );
  });

  it("creates batches sequentially and stops after the first failure", async () => {
    const order: string[] = [];
    const client = {
      createIssue: vi.fn(({ title }: { title: string }) => {
        order.push(`start:${title}`);
        if (title === "Fails") {
          throw new Error("rate limited");
        }
        order.push(`finish:${title}`);
        return {
          issue: Promise.resolve({
            id: title,
            identifier: `ENG-${title}`,
            url: `https://linear.app/issue/${title}`,
            title,
          }),
        };
      }),
    };

    await expect(
      createIssues(client as never, [
        { teamId: "team-1", title: "First" },
        { teamId: "team-1", title: "Second" },
      ])
    ).resolves.toHaveLength(2);
    expect(order).toEqual([
      "start:First",
      "finish:First",
      "start:Second",
      "finish:Second",
    ]);
    expect(mockLog.info).toHaveBeenCalledTimes(2);

    order.length = 0;
    await expect(
      createIssues(client as never, [
        { teamId: "team-1", title: "Before" },
        { teamId: "team-1", title: "Fails" },
        { teamId: "team-1", title: "Never" },
      ])
    ).rejects.toThrow("rate limited");
    expect(order).toEqual(["start:Before", "finish:Before", "start:Fails"]);
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/api] Failed to create issue",
      { title: "Fails", error: "rate limited" }
    );
  });
});

function response(body: unknown, { status = 200 }: { status?: number } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi
      .fn()
      .mockResolvedValue(
        typeof body === "string" ? body : JSON.stringify(body)
      ),
  };
}

// ISS-6078 fixtures. Obviously synthetic, but each is a >=20 char run of the
// token alphabet, so it matches the same redaction pattern a real credential
// would. Never a real-looking Linear token.
const SYNTHETIC_CLIENT_SECRET = "SYNTHETICclientsecret0000000000";
const SYNTHETIC_AUTH_CODE = "SYNTHETICauthorizationcode000000";
const SYNTHETIC_REFRESH_TOKEN = "SYNTHETICrefreshtoken00000000000";
const SYNTHETIC_ACCESS_TOKEN = "SYNTHETICaccesstoken000000000000";

// ISS-6709 (review). Ordinary diagnostics that are ALSO 20+ character runs of
// the token alphabet — the exact shape the old length-only rule could not tell
// apart from a credential. They must survive redaction untouched.
const NON_SENSITIVE_REQUEST_ID = "req-01JQ8ZT4X9YB3K7NM2VW5DPHRC";
const NON_SENSITIVE_HOST = "api-gateway-prod-eu-west-1";
const NON_SENSITIVE_ERROR_CODE = "INVALID_GRANT_EXPIRED_CREDENTIAL";

/** The `error` string a `log.*` mock received for `message`, if any. */
function loggedErrorText(
  calls: unknown[][],
  message: string
): string | undefined {
  const payload = calls.find((entry) => entry[0] === message)?.[1];
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error: unknown }).error;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Boolean containment for secret-sensitive assertions. Vitest embeds the
 * received value in a failed `toContain` message, so asserting the credential
 * directly would print it to stdout and every report artifact on failure.
 */
function containsSecret(text: unknown, secret: string): boolean {
  return typeof text === "string" && text.includes(secret);
}

/**
 * The form body the FIRST fetch carried. The presence check names a request
 * that was never issued, rather than surfacing it as a property access on
 * undefined inside the assertion.
 */
function firstRequestBody(): URLSearchParams {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("no fetch was issued");
  }
  return (call[1] as { body: URLSearchParams }).body;
}
