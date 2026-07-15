import { GitHubRepositorySource } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const findOrCreateUserMock = vi.fn();
const getDesktopManagedPopRequestFailureMock = vi.fn();
const getPublicRepositoriesMock = vi.fn();
const getRepositoriesMock = vi.fn();
const isPublicGithubReposEnabledMock = vi.fn();
const organizationFindByIdMock = vi.fn();
const resolveOrgHeaderMock = vi.fn();
const touchLastUsedAtMock = vi.fn();
const userFindByIdMock = vi.fn();
const verifyKeyWithMetadataMock = vi.fn();

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    touchLastUsedAt: touchLastUsedAtMock,
    verifyKeyWithMetadata: verifyKeyWithMetadataMock,
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findById: organizationFindByIdMock,
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: userFindByIdMock,
  },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: getDesktopManagedPopRequestFailureMock,
}));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: findOrCreateUserMock,
}));

vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: resolveOrgHeaderMock,
}));

vi.mock("@/lib/public-github-repos-feature", () => ({
  isPublicGithubReposEnabled: isPublicGithubReposEnabledMock,
}));

vi.mock("../public-repositories/service", () => ({
  publicRepositoryService: {
    getPublicRepositories: getPublicRepositoriesMock,
  },
}));

vi.mock("../service", () => ({
  githubService: {
    getRepositories: getRepositoriesMock,
  },
}));

const { GET } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

function request(input: { token?: string } = {}): NextRequest {
  const headers = new Headers();
  if (input.token) {
    headers.set("Authorization", `Bearer ${input.token}`);
  }
  return new NextRequest(
    "http://localhost:3002/integrations/github/repositories",
    { headers }
  );
}

describe("GET /integrations/github/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      userId: "clerk-user-1",
      orgId: "clerk-org-1",
      orgRole: "org:admin",
    });
    findOrCreateUserMock.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
      active: true,
    });
    getDesktopManagedPopRequestFailureMock.mockResolvedValue(null);
    isPublicGithubReposEnabledMock.mockResolvedValue(true);
    getRepositoriesMock.mockResolvedValue([
      {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
        name: "symphony-alpha",
        owner: "closedloop-ai",
        private: true,
        githubRepoId: "123",
        lastPushedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ]);
    getPublicRepositoriesMock.mockResolvedValue([
      {
        id: "public-repo-1",
        fullName: "closedloop-ai/public",
        name: "public",
        owner: "closedloop-ai",
        githubRepoId: "456",
      },
    ]);
    organizationFindByIdMock.mockResolvedValue({ clerkId: "clerk-org-1" });
    resolveOrgHeaderMock.mockResolvedValue({
      kind: "session",
      clerkOrgId: "clerk-org-1",
      orgRole: "org:admin",
    });
    touchLastUsedAtMock.mockResolvedValue(undefined);
    userFindByIdMock.mockImplementation(
      (_userId: string, organizationId: string) => ({
        id: "user-1",
        clerkId: "clerk-user-1",
        organizationId,
        active: true,
      })
    );
    verifyKeyWithMetadataMock.mockImplementation((token: string) => {
      if (token === "sk_live_invalid") {
        return null;
      }
      return {
        apiKeyId: "key-1",
        organizationId: token === "sk_live_wrong_org" ? "wrong-org" : "org-1",
        scopes: ["read"],
        userId: "user-1",
      };
    });
  });

  it("allows desktop API-key principals to read repository lists", async () => {
    const response = await GET(
      request({ token: "sk_live_desktop" }),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getRepositoriesMock).toHaveBeenCalledWith("org-1");
    expect(getPublicRepositoriesMock).toHaveBeenCalledWith("org-1");
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "repo-1",
        source: GitHubRepositorySource.Installation,
      }),
      expect.objectContaining({
        id: "public-repo-1",
        source: GitHubRepositorySource.Public,
      }),
    ]);
  });

  it("allows Clerk principals to read repository lists", async () => {
    await GET(request({ token: "clerk-session" }), EMPTY_CONTEXT);

    expect(getRepositoriesMock).toHaveBeenCalledWith("org-1");
    expect(getPublicRepositoriesMock).toHaveBeenCalledWith("org-1");
  });

  it("rejects unauthenticated reads before the service boundary", async () => {
    authMock.mockResolvedValueOnce({
      userId: null,
      orgId: null,
      orgRole: null,
    });

    const response = await GET(request(), EMPTY_CONTEXT);

    expect(response.status).toBe(401);
    expect(getRepositoriesMock).not.toHaveBeenCalled();
    expect(getPublicRepositoriesMock).not.toHaveBeenCalled();
  });

  it("rejects invalid API keys before the service boundary", async () => {
    const response = await GET(
      request({ token: "sk_live_invalid" }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(401);
    expect(getRepositoriesMock).not.toHaveBeenCalled();
    expect(getPublicRepositoriesMock).not.toHaveBeenCalled();
  });

  it("scopes API-key repository-list reads to the authenticated organization", async () => {
    await GET(request({ token: "sk_live_wrong_org" }), EMPTY_CONTEXT);

    expect(getRepositoriesMock).toHaveBeenCalledWith("wrong-org");
    expect(getPublicRepositoriesMock).toHaveBeenCalledWith("wrong-org");
  });

  it("omits public repositories when the feature flag is disabled", async () => {
    isPublicGithubReposEnabledMock.mockResolvedValue(false);

    const response = await GET(
      request({ token: "clerk-session" }),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getRepositoriesMock).toHaveBeenCalledWith("org-1");
    expect(getPublicRepositoriesMock).not.toHaveBeenCalled();
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "repo-1",
        source: GitHubRepositorySource.Installation,
      }),
    ]);
  });
});
