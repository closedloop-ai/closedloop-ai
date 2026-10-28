import { GitHubConnectErrorCode } from "@repo/api/src/types/github-clerk-link";
import { GITHUB_ERROR_CODES } from "@repo/api/src/types/github-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubOAuthReturnToCookie,
  GITHUB_OAUTH_RETURN_TO_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
} from "../github-utils";

const mockAuth = vi.fn();
const mockCookieGet = vi.fn();

vi.mock("@repo/auth/server", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: mockCookieGet }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_API_URL: "http://api.example.test",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

const { GET } = await import("../callback/route");

describe("GET /api/integrations/github/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { connected: true } }),
      })
    );
    mockAuth.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      getToken: vi.fn().mockResolvedValue("clerk-token"),
    });
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      return undefined;
    });
  });

  it("clears OAuth cookies on unauthenticated callbacks", async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toContain(
      "code=not_authenticated"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a user-cancelled install before checking required params", async () => {
    const response = await GET(
      callbackRequest({
        error: "access_denied",
        error_description: "The user denied the request",
        state: "state-1",
      })
    );

    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings?github=error&code=${GITHUB_ERROR_CODES.OAUTH_FAILED}`
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns to the verified Branch View path after successful OAuth", async () => {
    const returnCookie = createGitHubOAuthReturnToCookie({
      issuedAt: Date.now(),
      returnTo: "/acme/build/branch-1",
      state: "state-1",
    });
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      if (name === GITHUB_OAUTH_RETURN_TO_COOKIE) {
        return { value: returnCookie };
      }
      return undefined;
    });

    const response = await GET(
      // GitHub still appends `code` while OAuth-during-install stays enabled
      // on the App; the callback must ignore it (PLN-1742 M5).
      callbackRequest({
        code: "code-1",
        installation_id: "42",
        state: "state-1",
      })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/acme/build/branch-1?github=connected"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(fetch).toHaveBeenCalledWith(
      "http://api.example.test/integrations/github/connect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ installationId: "42" }),
      })
    );
  });

  it("rejects a callback without an installation_id", async () => {
    const response = await GET(callbackRequest({ state: "state-1" }));

    expect(response.headers.get("location")).toContain("code=missing_params");
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a callback whose state does not match the OAuth cookie", async () => {
    const response = await GET(
      callbackRequest({
        installation_id: "42",
        state: "attacker-state",
      })
    );

    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings?github=error&code=${GITHUB_ERROR_CODES.INVALID_STATE}`
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a replay after the OAuth state cookie has been cleared", async () => {
    mockCookieGet.mockReturnValue(undefined);

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings?github=error&code=${GITHUB_ERROR_CODES.INVALID_STATE}`
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears OAuth cookies and falls back to settings when the callback throws", async () => {
    mockAuth.mockRejectedValueOnce(new Error("clerk down"));

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings?github=error&code=${GITHUB_ERROR_CODES.OAUTH_FAILED}`
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to settings when the return cookie state does not match", async () => {
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      if (name === GITHUB_OAUTH_RETURN_TO_COOKIE) {
        return {
          value: createGitHubOAuthReturnToCookie({
            issuedAt: Date.now(),
            returnTo: "/acme/build/branch-1",
            state: "other-state",
          }),
        };
      }
      return undefined;
    });

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=connected"
    );
  });

  it("redirects account changes to confirmation without carrying returnTo", async () => {
    const returnCookie = createGitHubOAuthReturnToCookie({
      issuedAt: Date.now(),
      returnTo: "/acme/build/branch-1",
      state: "state-1",
    });
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      if (name === GITHUB_OAUTH_RETURN_TO_COOKIE) {
        return { value: returnCookie };
      }
      return undefined;
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            status: "requires_confirmation",
            priorAccount: {
              accountId: "account-old",
              accountLogin: "old-org",
            },
            newAccount: {
              accountId: "account-new",
              accountLogin: "new-org",
            },
            newInstallationId: "99",
          },
        }),
    } as Response);

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=requires_confirmation&priorAccountId=account-old&priorAccountLogin=old-org&newAccountId=account-new&newAccountLogin=new-org&newInstallationId=99"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
  });

  it("returns connection failures to a verified Branch View path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("provider unavailable"),
    } as Response);
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      if (name === GITHUB_OAUTH_RETURN_TO_COOKIE) {
        return {
          value: createGitHubOAuthReturnToCookie({
            issuedAt: Date.now(),
            returnTo: "/acme/build/branch-1",
            state: "state-1",
          }),
        };
      }
      return undefined;
    });

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/acme/build/branch-1?github=error&code=connection_failed"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
  });

  it("falls back to settings for connection failures with mismatched return cookies", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("provider unavailable"),
    } as Response);
    mockCookieGet.mockImplementation((name: string) => {
      if (name === GITHUB_OAUTH_STATE_COOKIE) {
        return { value: "state-1" };
      }
      if (name === GITHUB_OAUTH_RETURN_TO_COOKIE) {
        return {
          value: createGitHubOAuthReturnToCookie({
            issuedAt: Date.now(),
            returnTo: "/acme/build/branch-1",
            state: "other-state",
          }),
        };
      }
      return undefined;
    });

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=error&code=connection_failed"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
  });
  it("routes a link-required refusal to the linking page with the pending installation", async () => {
    // The App is installed by now, so a generic "try again" would be a dead
    // end: linking is the one action that completes this claim.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: false,
            error:
              "Connect your GitHub account before claiming this installation.",
            code: GitHubConnectErrorCode.LinkRequired,
          })
        ),
    } as Response);

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/connect/github/link?resumeInstallationId=42"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
  });

  it("keeps the generic error for refusals the caller cannot act on", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: false,
            error:
              "You must be an owner of the acme GitHub organization to claim this installation.",
          })
        ),
    } as Response);

    const response = await GET(
      callbackRequest({ installation_id: "42", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=error&code=connection_failed"
    );
  });
});

function callbackRequest(params: Record<string, string>) {
  const url = new URL("http://localhost:3000/api/integrations/github/callback");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString()) as Parameters<typeof GET>[0];
}

function setCookieHeader(response: Response): string {
  const getSetCookie =
    (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [];
  return [...getSetCookie, response.headers.get("set-cookie") ?? ""].join(";");
}
