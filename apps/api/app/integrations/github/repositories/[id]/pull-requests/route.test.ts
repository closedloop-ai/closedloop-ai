import { GitHubPullRequestTrackingScope } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubReadCostRoute } from "@/lib/github/github-read-cost-log";

const authMock = vi.fn();
const findOrCreateUserMock = vi.fn();
const getDesktopManagedPopRequestFailureMock = vi.fn();
const getPullRequestsMock = vi.fn();
const servePullRequestsFromProjectionMock = vi.fn();
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
    getPullRequests: getPullRequestsMock,
  },
}));

vi.mock("../../../projection-read", () => ({
  serveRepositoryPullRequestsFromProjection:
    servePullRequestsFromProjectionMock,
}));

const { GET } = await import("./route");

const ROUTE_CONTEXT = { params: Promise.resolve({ id: "repo-1" }) };

function request(
  input: {
    limit?: string;
    projectId?: string;
    token?: string;
    trackingScope?: string;
  } = {}
): NextRequest {
  const url = new URL(
    "http://localhost:3002/integrations/github/repositories/repo-1/pull-requests"
  );
  if (input?.limit !== undefined) {
    url.searchParams.set("limit", input.limit);
  }
  if (input?.projectId !== undefined) {
    url.searchParams.set("projectId", input.projectId);
  }
  if (input.trackingScope !== undefined) {
    url.searchParams.set("trackingScope", input.trackingScope);
  }
  const headers = new Headers();
  if (input.token) {
    headers.set("Authorization", `Bearer ${input.token}`);
  }
  return new NextRequest(url, { headers });
}

describe("GET /integrations/github/repositories/[id]/pull-requests", () => {
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
    getPullRequestsMock.mockResolvedValue({ pullRequests: [] });
    // ISS-8049 retired the projection-reads flag: the projection lane runs
    // first on every request. Defaulting the serve mock to null keeps the live
    // lane the branch under test for the cases that assert it, exactly as a
    // projection miss behaves in production.
    servePullRequestsFromProjectionMock.mockResolvedValue(null);
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

  it("allows desktop API-key principals and preserves project filtering", async () => {
    await GET(
      request({ projectId: "project-1", token: "sk_live_desktop" }),
      ROUTE_CONTEXT
    );

    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      "project-1",
      { limit: 30 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("allows Clerk principals to read repository pull requests", async () => {
    await GET(request({ token: "clerk-session" }), ROUTE_CONTEXT);

    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      { limit: 30 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("serves from the projection by default, bypassing live GraphQL (ISS-8049)", async () => {
    servePullRequestsFromProjectionMock.mockResolvedValue({
      pullRequests: [{ number: 7 }],
      trackedPrUrls: [],
    });

    const response = await GET(
      request({ projectId: "project-1", token: "sk_live_desktop" }),
      ROUTE_CONTEXT
    );

    expect(servePullRequestsFromProjectionMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      "project-1",
      30,
      undefined
    );
    expect(getPullRequestsMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.pullRequests).toEqual([{ number: 7 }]);
  });

  it("falls through to the live lane when the projection resolves the repo but has no rows yet", async () => {
    // PR #6037 review: a fresh installation (or an unswept repo) has a
    // resolvable id and ZERO projected rows. Serving that empty list would
    // hide real PRs until reconciliation catches up, so the empty projection
    // must not short-circuit the live read.
    servePullRequestsFromProjectionMock.mockResolvedValue({
      pullRequests: [],
      trackedPrUrls: [],
    });

    const response = await GET(
      request({ token: "clerk-session" }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      { limit: 30 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("falls through to the live lane for an id the projection cannot resolve", async () => {
    // A null from the projection lane means neither the installation table nor
    // a verified observation row owns this id (ISS-8049 taught the lane the
    // observed selector); the live lane still owns the not-found verdict.
    servePullRequestsFromProjectionMock.mockResolvedValue(null);

    const response = await GET(
      request({ token: "clerk-session" }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      { limit: 30 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("still surfaces not-found when neither lane can resolve the id", async () => {
    servePullRequestsFromProjectionMock.mockResolvedValue(null);
    getPullRequestsMock.mockRejectedValue(new Error("Repository not found"));

    const response = await GET(
      request({ token: "clerk-session" }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(500);
  });

  it("passes explicit organization tracking scope through live and projection reads", async () => {
    const scopedRequest = () =>
      request({
        token: "sk_live_desktop",
        trackingScope: GitHubPullRequestTrackingScope.Organization,
      });

    await GET(scopedRequest(), ROUTE_CONTEXT);
    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      {
        limit: 30,
        trackingScope: GitHubPullRequestTrackingScope.Organization,
      },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );

    servePullRequestsFromProjectionMock.mockResolvedValue({
      pullRequests: [],
      trackedPrUrls: [],
    });
    await GET(scopedRequest(), ROUTE_CONTEXT);
    expect(servePullRequestsFromProjectionMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      30,
      GitHubPullRequestTrackingScope.Organization
    );
  });

  it("preserves additive live fork-head authority in the response", async () => {
    const headRepository = {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "5826",
        fullName: "fork-owner/widgets",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: "trunk",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "graphql-page-1",
        observedAt: "2026-02-11T09:01:00.000Z",
      },
    } satisfies RepositoryDefaultAuthority;
    getPullRequestsMock.mockResolvedValue({
      pullRequests: [{ headRepository }],
    });

    const response = await GET(
      request({ token: "sk_live_desktop" }),
      ROUTE_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.pullRequests[0].headRepository).toEqual(headRepository);
  });

  it("rejects unauthenticated reads before the service boundary", async () => {
    authMock.mockResolvedValueOnce({
      userId: null,
      orgId: null,
      orgRole: null,
    });

    const response = await GET(request(), ROUTE_CONTEXT);

    expect(response.status).toBe(401);
    expect(getPullRequestsMock).not.toHaveBeenCalled();
  });

  it("rejects invalid API keys before the service boundary", async () => {
    const response = await GET(
      request({ token: "sk_live_invalid" }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(401);
    expect(getPullRequestsMock).not.toHaveBeenCalled();
  });

  it("fails closed when the repository is outside the authenticated organization", async () => {
    getPullRequestsMock.mockRejectedValueOnce(
      new Error("repository not found")
    );

    const response = await GET(
      request({
        token: "sk_live_wrong_org",
      }),
      ROUTE_CONTEXT
    );

    expect(response.status).toBe(500);
    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "wrong-org",
      null,
      { limit: 30 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("clamps over-limit values", async () => {
    await GET(
      request({ limit: "500", token: "sk_live_desktop" }),
      ROUTE_CONTEXT
    );

    expect(getPullRequestsMock).toHaveBeenCalledWith(
      "repo-1",
      "org-1",
      null,
      { limit: 100 },
      GitHubReadCostRoute.RepositoryPullRequests,
      "user-1"
    );
  });

  it("rejects zero, negative, and non-numeric limits", async () => {
    for (const value of ["0", "-5", "nope"]) {
      const response = await GET(
        request({ limit: value, token: "sk_live_desktop" }),
        ROUTE_CONTEXT
      );

      expect(response.status).toBe(400);
    }
    expect(getPullRequestsMock).not.toHaveBeenCalled();
  });
});
