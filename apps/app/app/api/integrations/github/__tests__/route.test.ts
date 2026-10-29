import { GITHUB_ERROR_CODES } from "@repo/api/src/types/github-status";
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
  NEXT_PUBLIC_GITHUB_APP_SLUG: "test-app-slug",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

vi.mock("@/env", () => ({
  get env() {
    return mockEnv;
  },
}));

vi.mock("../github-utils", () => ({
  GITHUB_OAUTH_STATE_COOKIE: "github_oauth_state",
  GITHUB_OAUTH_RETURN_TO_COOKIE: "github_oauth_return_to",
  GITHUB_OAUTH_RETURN_TO_COOKIE_PATH: "/api/integrations/github",
  createGitHubOAuthReturnToCookie:
    githubUtilsMocks.createGitHubOAuthReturnToCookie,
  getErrorRedirectUrl: (code: string) =>
    `http://localhost:3000/settings?github=error&code=${code}`,
}));

// PLN-1742 M3 moved the canonicalizer into its own crypto-free module.
vi.mock("../github-return-path", () => ({
  getCanonicalBranchViewReturnPath:
    githubUtilsMocks.getCanonicalBranchViewReturnPath,
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
      NEXT_PUBLIC_GITHUB_APP_SLUG: "test-app-slug",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };
    mockAuth.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      orgSlug: "acme",
    });
  });

  // PLN-1742 M5: the in-house authorize flow is retired. Authorize-mode
  // requests (old desktop builds, bookmarks, pre-M5 bundles) redirect to the
  // Clerk linking page with the RAW returnTo preserved -- canonicalization is
  // the page's job -- and set no cookies.
  test("redirects authorize-mode requests to the Clerk linking page", async () => {
    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/connect/github/link"
    );
    expect(mockCookiesSet).not.toHaveBeenCalled();
  });

  test("forwards the raw returnTo to the Clerk linking page", async () => {
    const response = await GET(createRequest({ returnTo: "/branches" }));

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/connect/github/link?returnTo=%2Fbranches"
    );
    expect(
      githubUtilsMocks.createGitHubOAuthReturnToCookie
    ).not.toHaveBeenCalled();
  });

  test("redirects to /installations/new when ?install=true", async () => {
    const response = await GET(createRequest({ install: "true" }));
    const location = response.headers.get("location") ?? "";

    expect(location).toContain(
      "github.com/apps/test-app-slug/installations/new"
    );
    expect(location).toContain("state=");
  });

  test("returns not_configured when ?install=true but slug is not set", async () => {
    mockEnv = {
      NEXT_PUBLIC_GITHUB_APP_SLUG: undefined,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };

    const response = await GET(createRequest({ install: "true" }));
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("code=not_configured");
  });

  test("returns not_authenticated for install mode with no session", async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(createRequest({ install: "true" }));
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("code=not_authenticated");
  });

  test("sets CSRF state cookie for install mode", async () => {
    await GET(createRequest({ install: "true" }));

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

  test("canonicalizes desktop Branches return targets for install mode", async () => {
    await GET(createRequest({ install: "true", returnTo: "/branches" }));

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

  test("canonicalizes desktop Insights return targets for install mode", async () => {
    await GET(createRequest({ install: "true", returnTo: "/insights" }));

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

  test("does not set a return cookie for unsafe install-mode return targets", async () => {
    await GET(
      createRequest({
        install: "true",
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

  test("returns oauth_failed when the install-entry cookie write throws", async () => {
    mockCookiesSet.mockImplementationOnce(() => {
      throw new Error("cookie store unavailable");
    });

    const response = await GET(createRequest({ install: "true" }));

    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings?github=error&code=${GITHUB_ERROR_CODES.OAUTH_FAILED}`
    );
  });
});
