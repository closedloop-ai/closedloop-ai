import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock dependencies
const mockAuth = vi.fn();
const mockCookiesSet = vi.fn();
const githubUtilsMocks = vi.hoisted(() => ({
  createGitHubOAuthReturnToCookie: vi.fn(() => "signed-return-to-cookie"),
  getCanonicalBranchViewReturnPath: vi.fn(
    (returnTo: string | null, options?: { orgSlug?: string | null }) => {
      const orgSlug = options?.orgSlug;
      if (!(returnTo && orgSlug)) {
        return null;
      }
      if (returnTo === "/branches") {
        return `/${orgSlug}/branches`;
      }
      if (returnTo === "/insights") {
        return `/${orgSlug}/insights`;
      }
      if (
        returnTo === `/${orgSlug}/branches` ||
        returnTo === `/${orgSlug}/insights`
      ) {
        return returnTo;
      }
      return null;
    }
  ),
}));

vi.mock("@repo/auth/server", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: mockCookiesSet }),
}));

let mockEnv: Record<string, string | undefined> = {
  GITHUB_APP_CLIENT_ID: "test-client-id",
  NEXT_PUBLIC_GITHUB_APP_SLUG: "test-app-slug",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

vi.mock("@/env", () => ({
  get env() {
    return mockEnv;
  },
}));

vi.mock("../github-utils", () => ({
  GITHUB_ERROR_CODES: {
    NOT_AUTHENTICATED: "not_authenticated",
    NOT_CONFIGURED: "not_configured",
    OAUTH_FAILED: "oauth_failed",
  },
  GITHUB_OAUTH_STATE_COOKIE: "github_oauth_state",
  GITHUB_OAUTH_RETURN_TO_COOKIE: "github_oauth_return_to",
  GITHUB_OAUTH_RETURN_TO_COOKIE_PATH: "/api/integrations/github",
  createGitHubOAuthReturnToCookie:
    githubUtilsMocks.createGitHubOAuthReturnToCookie,
  getCanonicalBranchViewReturnPath:
    githubUtilsMocks.getCanonicalBranchViewReturnPath,
  getErrorRedirectUrl: (code: string) =>
    `http://localhost:3000/settings?github=error&code=${code}`,
  getGitHubCallbackUrl: () =>
    "http://localhost:3000/api/integrations/github/callback",
}));

// Import after mocks
const { GET } = await import("../route");

function createRequest(searchParams?: Record<string, string>) {
  const url = new URL("http://localhost:3000/api/integrations/github");
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  // NextRequest needs a nextUrl property with searchParams
  const request = new Request(url.toString());
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as Parameters<typeof GET>[0];
}

describe("GET /api/integrations/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      GITHUB_APP_CLIENT_ID: "test-client-id",
      NEXT_PUBLIC_GITHUB_APP_SLUG: "test-app-slug",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };
    mockAuth.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      orgSlug: "acme",
    });
  });

  test("redirects to standard OAuth URL by default when client_id is set", async () => {
    const response = await GET(createRequest());
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("redirect_uri=");
    expect(location).toContain("state=");
  });

  test("redirects to /installations/new when ?install=true", async () => {
    const response = await GET(createRequest({ install: "true" }));
    const location = response.headers.get("location") ?? "";

    expect(location).toContain(
      "github.com/apps/test-app-slug/installations/new"
    );
    expect(location).toContain("state=");
  });

  test("falls back to /installations/new when only slug is configured", async () => {
    mockEnv = {
      GITHUB_APP_CLIENT_ID: undefined,
      NEXT_PUBLIC_GITHUB_APP_SLUG: "test-app-slug",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };

    const response = await GET(createRequest());
    const location = response.headers.get("location") ?? "";

    expect(location).toContain(
      "github.com/apps/test-app-slug/installations/new"
    );
  });

  test("returns not_configured when neither client_id nor slug is set", async () => {
    mockEnv = {
      GITHUB_APP_CLIENT_ID: undefined,
      NEXT_PUBLIC_GITHUB_APP_SLUG: undefined,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };

    const response = await GET(createRequest());
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("code=not_configured");
  });

  test("returns not_configured when ?install=true but slug is not set", async () => {
    mockEnv = {
      GITHUB_APP_CLIENT_ID: "test-client-id",
      NEXT_PUBLIC_GITHUB_APP_SLUG: undefined,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };

    const response = await GET(createRequest({ install: "true" }));
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("code=not_configured");
  });

  test("returns not_authenticated when user has no session", async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(createRequest());
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("code=not_authenticated");
  });

  test("sets CSRF state cookie", async () => {
    await GET(createRequest());

    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_state",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      })
    );
  });

  test("sets signed Branches return cookie for authorize-mode return target", async () => {
    await GET(createRequest({ returnTo: "/acme/branches" }));

    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_return_to",
      "signed-return-to-cookie",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/integrations/github",
      })
    );
  });

  test("sets signed Branches return cookie for install mode", async () => {
    await GET(createRequest({ install: "true", returnTo: "/acme/branches" }));

    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_return_to",
      "signed-return-to-cookie",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/integrations/github",
      })
    );
  });

  test("sets signed Insights return cookie for install mode", async () => {
    await GET(createRequest({ install: "true", returnTo: "/acme/insights" }));

    expect(
      githubUtilsMocks.createGitHubOAuthReturnToCookie
    ).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/acme/insights" })
    );
    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_return_to",
      "signed-return-to-cookie",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/integrations/github",
      })
    );
  });

  test("canonicalizes desktop Branches return targets with the active org slug", async () => {
    await GET(createRequest({ returnTo: "/branches" }));

    expect(
      githubUtilsMocks.createGitHubOAuthReturnToCookie
    ).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/acme/branches" })
    );
    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_return_to",
      "signed-return-to-cookie",
      expect.objectContaining({
        path: "/api/integrations/github",
      })
    );
  });

  test("canonicalizes desktop Insights return targets with the active org slug", async () => {
    await GET(createRequest({ returnTo: "/insights" }));

    expect(
      githubUtilsMocks.createGitHubOAuthReturnToCookie
    ).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/acme/insights" })
    );
    expect(mockCookiesSet).toHaveBeenCalledWith(
      "github_oauth_return_to",
      "signed-return-to-cookie",
      expect.objectContaining({
        path: "/api/integrations/github",
      })
    );
  });

  test("does not set a return cookie for unsafe return targets", async () => {
    await GET(
      createRequest({
        returnTo: "https://evil.example.test/acme/insights",
      })
    );

    expect(
      githubUtilsMocks.createGitHubOAuthReturnToCookie
    ).not.toHaveBeenCalled();
    expect(
      mockCookiesSet.mock.calls.some(
        ([name]) => name === "github_oauth_return_to"
      )
    ).toBe(false);
  });
});
