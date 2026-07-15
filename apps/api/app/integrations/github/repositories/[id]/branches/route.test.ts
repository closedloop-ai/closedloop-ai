import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const findOrCreateUserMock = vi.fn();
const getBranchesMock = vi.fn();
const isPublicGithubReposEnabledMock = vi.fn();
const getDesktopManagedPopRequestFailureMock = vi.fn();
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

vi.mock("../../../service", () => ({
  githubService: {
    getBranches: getBranchesMock,
  },
}));

vi.mock("@/lib/public-github-repos-feature", () => ({
  isPublicGithubReposEnabled: isPublicGithubReposEnabledMock,
}));

const { GET } = await import("./route");

const ROUTE_CONTEXT = { params: Promise.resolve({ id: "repo-1" }) };

function request(input: { limit?: string; token?: string } = {}): NextRequest {
  const url = new URL(
    "http://localhost:3002/integrations/github/repositories/repo-1/branches"
  );
  if (input.limit !== undefined) {
    url.searchParams.set("limit", input.limit);
  }
  const headers = new Headers();
  if (input.token) {
    headers.set("Authorization", `Bearer ${input.token}`);
  }
  return new NextRequest(url, { headers });
}

describe("GET /integrations/github/repositories/[id]/branches", () => {
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
    getBranchesMock.mockResolvedValue([]);
    // Default fail-closed: the public-repo fallback stays gated unless a test
    // opts into the rollout.
    isPublicGithubReposEnabledMock.mockResolvedValue(false);
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

  it("allows desktop API-key principals to read repository branches", async () => {
    await GET(request({ token: "sk_live_desktop" }), ROUTE_CONTEXT);

    expect(getBranchesMock).toHaveBeenCalledWith("repo-1", "org-1", 20, false);
  });

  it("allows Clerk principals to read repository branches", async () => {
    await GET(request({ token: "clerk-session" }), ROUTE_CONTEXT);

    expect(getBranchesMock).toHaveBeenCalledWith("repo-1", "org-1", 20, false);
  });

  it("forwards the public-repos rollout so the public fallback stays gated when disabled", async () => {
    isPublicGithubReposEnabledMock.mockResolvedValue(false);

    await GET(request({ token: "sk_live_desktop" }), ROUTE_CONTEXT);

    expect(getBranchesMock).toHaveBeenCalledWith("repo-1", "org-1", 20, false);
  });

  it("permits the public fallback when the rollout is enabled for the principal", async () => {
    isPublicGithubReposEnabledMock.mockResolvedValue(true);

    await GET(request({ token: "sk_live_desktop" }), ROUTE_CONTEXT);

    expect(getBranchesMock).toHaveBeenCalledWith("repo-1", "org-1", 20, true);
  });

  it("rejects unauthenticated reads before the service boundary", async () => {
    authMock.mockResolvedValueOnce({
      userId: null,
      orgId: null,
      orgRole: null,
    });

    const response = await GET(request(), ROUTE_CONTEXT);

    expect(response.status).toBe(401);
    expect(getBranchesMock).not.toHaveBeenCalled();
  });

  it("rejects invalid API keys before the service boundary", async () => {
    const response = await GET(
      request({ token: "sk_live_invalid" }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(401);
    expect(getBranchesMock).not.toHaveBeenCalled();
  });

  it("fails closed when the repository is outside the authenticated organization", async () => {
    getBranchesMock.mockRejectedValueOnce(new Error("repository not found"));

    const response = await GET(
      request({
        token: "sk_live_wrong_org",
      }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(500);
    expect(getBranchesMock).toHaveBeenCalledWith(
      "repo-1",
      "wrong-org",
      20,
      false
    );
  });

  it("clamps over-limit values", async () => {
    await GET(
      request({ limit: "500", token: "sk_live_desktop" }),
      ROUTE_CONTEXT
    );

    expect(getBranchesMock).toHaveBeenCalledWith("repo-1", "org-1", 100, false);
  });

  it("rejects zero, negative, and non-numeric limits", async () => {
    for (const value of ["0", "-5", "nope"]) {
      const response = await GET(
        request({ limit: value, token: "sk_live_desktop" }),
        ROUTE_CONTEXT
      );

      expect(response.status).toBe(400);
    }
    expect(getBranchesMock).not.toHaveBeenCalled();
  });
});
