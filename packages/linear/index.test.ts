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
  generatePKCE,
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

  it("generates a URL-safe PKCE verifier and SHA-256 challenge", async () => {
    const pkce = await generatePKCE();

    expect(pkce.codeVerifier).toMatch(PKCE_VALUE_PATTERN);
    expect(pkce.codeChallenge).toMatch(PKCE_VALUE_PATTERN);
    expect(pkce.codeChallengeMethod).toBe("S256");
    expect(pkce.codeChallenge).toBe(
      await createPkceChallenge(pkce.codeVerifier)
    );
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
    expect(
      (mockFetch.mock.calls[0]?.[1] as { body: URLSearchParams }).body
    ).toEqual(
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
        response("secret_token_abcdefghijklmnop", { status: 401 })
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
      { status: 401, error: "[REDACTED]" }
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
    expect(
      (mockFetch.mock.calls[0]?.[1] as { body: URLSearchParams }).body
    ).toEqual(
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
      response("refresh_secret_abcdefghijklmnop", { status: 403 })
    );

    await expect(refreshAccessToken("refresh-token")).rejects.toThrow(
      "Token refresh failed: 403"
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      "[linear/oauth] Token refresh failed",
      { status: 403, error: "[REDACTED]" }
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

    expect(
      (mockFetch.mock.calls[0]?.[1] as { body: URLSearchParams }).body
    ).toEqual(new URLSearchParams({ token: "first-access-token" }));
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[linear/oauth] Token revocation failed (continuing anyway)",
      { status: 409, error: "already revoked" }
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[linear/oauth] Token revocation error (continuing anyway)",
      { error: "offline" }
    );
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

async function createPkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

const PKCE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
