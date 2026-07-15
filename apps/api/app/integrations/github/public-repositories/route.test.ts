import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const findOrCreateUserMock = vi.fn();
const getDesktopManagedPopRequestFailureMock = vi.fn();
const addPublicRepositoryMock = vi.fn();
const removePublicRepositoryMock = vi.fn();
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

vi.mock("./service", () => ({
  publicRepositoryService: {
    addPublicRepository: addPublicRepositoryMock,
    removePublicRepository: removePublicRepositoryMock,
  },
}));

const { DELETE, POST } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

function postRequest(url = "https://example.com/repo"): NextRequest {
  return new NextRequest(
    "http://localhost:3002/integrations/github/public-repositories",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }
  );
}

function deleteRequest(id = "public-repo-1"): NextRequest {
  return new NextRequest(
    `http://localhost:3002/integrations/github/public-repositories?id=${id}`,
    { method: "DELETE" }
  );
}

describe("public-repositories route feature gating", () => {
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
    addPublicRepositoryMock.mockResolvedValue({
      ok: true,
      value: {
        id: "public-repo-1",
        htmlUrl: "https://github.com/closedloop-ai/public",
        fullName: "closedloop-ai/public",
        name: "public",
        owner: "closedloop-ai",
      },
    });
    removePublicRepositoryMock.mockResolvedValue(undefined);
  });

  describe("when the feature flag is disabled", () => {
    beforeEach(() => {
      isPublicGithubReposEnabledMock.mockResolvedValue(false);
    });

    it("rejects POST before mutating", async () => {
      const response = await POST(postRequest(), EMPTY_CONTEXT);

      expect(response.status).toBe(403);
      expect(addPublicRepositoryMock).not.toHaveBeenCalled();
    });

    it("rejects DELETE before mutating", async () => {
      const response = await DELETE(deleteRequest(), EMPTY_CONTEXT);

      expect(response.status).toBe(403);
      expect(removePublicRepositoryMock).not.toHaveBeenCalled();
    });
  });

  describe("when the feature flag is enabled", () => {
    beforeEach(() => {
      isPublicGithubReposEnabledMock.mockResolvedValue(true);
    });

    it("allows POST to add a public repository", async () => {
      const response = await POST(postRequest(), EMPTY_CONTEXT);

      expect(response.status).toBe(200);
      expect(addPublicRepositoryMock).toHaveBeenCalledWith(
        "org-1",
        "https://example.com/repo"
      );
    });

    it("allows DELETE to remove a public repository", async () => {
      const response = await DELETE(deleteRequest(), EMPTY_CONTEXT);

      expect(response.status).toBe(200);
      expect(removePublicRepositoryMock).toHaveBeenCalledWith(
        "org-1",
        "public-repo-1"
      );
    });
  });
});
