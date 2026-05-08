import { TeamRole } from "@repo/api/src/types/teams";
import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { GET, POST } from "@/app/teams/[teamId]/repositories/route";
import { AddRepositoryError, teamsService } from "@/app/teams/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service");

const buildMockTeamRepo = (overrides: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  teamId: "team-1",
  installationRepositoryId: uuidv7(),
  isDefaultSelected: false,
  isPrimary: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  repository: {
    id: uuidv7(),
    installationId: uuidv7(),
    githubRepoId: "12345",
    fullName: "acme/repo",
    name: "repo",
    owner: "acme",
    private: false,
  },
  ...overrides,
});

describe("GET /teams/:teamId/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("returns repositories for a team member", async () => {
    const repos = [buildMockTeamRepo({ isPrimary: true })];
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.isMember).mockResolvedValue(true);
    vi.mocked(teamsService.getRepositories).mockResolvedValue(repos as any);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/repositories",
    });
    const response = await GET(
      request,
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(teamsService.getRepositories).toHaveBeenCalledWith("team-1");
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "missing" })
    );

    expect(response.status).toBe(404);
    expect(teamsService.getRepositories).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a member", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.isMember).mockResolvedValue(false);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(403);
    expect(teamsService.getRepositories).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.isMember).mockResolvedValue(true);
    vi.mocked(teamsService.getRepositories).mockRejectedValue(
      new Error("Database error")
    );

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(500);
  });
});

describe("POST /teams/:teamId/repositories", () => {
  const installationRepositoryId = uuidv7();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("adds a repository with valid data", async () => {
    const created = buildMockTeamRepo({ installationRepositoryId });
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: true,
      value: created as any,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId, isDefaultSelected: true },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    expect(teamsService.hasRole).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      TeamRole.Admin
    );
    expect(teamsService.addRepository).toHaveBeenCalledWith("team-1", "org-1", {
      installationRepositoryId,
      isDefaultSelected: true,
    });
  });

  it("returns 403 when caller is not admin", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(403);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "missing" })
    );

    expect(response.status).toBe(404);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("returns 400 on validation error", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId: "not-a-uuid" },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(400);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("returns 400 when repo is not in org installations", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: false,
      error: AddRepositoryError.RepoNotAvailable,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(400);
  });

  it("returns 409 when repo is already added", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: false,
      error: AddRepositoryError.AlreadyAdded,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(409);
  });
});
