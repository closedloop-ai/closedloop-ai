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
      callbackRequest({ code: "code-1", state: "state-1" })
    );

    expect(response.headers.get("location")).toContain(
      "code=not_authenticated"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(setCookieHeader(response)).toContain("onboarding_return=");
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
      callbackRequest({ code: "code-1", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/acme/build/branch-1?github=connected"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(fetch).toHaveBeenCalledWith(
      "http://api.example.test/integrations/github/connect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "code-1" }),
      })
    );
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
      callbackRequest({ code: "code-1", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=connected"
    );
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
      callbackRequest({ code: "code-1", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/acme/build/branch-1?github=error&code=connection_failed"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_state=");
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
    expect(setCookieHeader(response)).toContain("onboarding_return=");
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
      callbackRequest({ code: "code-1", state: "state-1" })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?github=error&code=connection_failed"
    );
    expect(setCookieHeader(response)).toContain("github_oauth_return_to=");
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
