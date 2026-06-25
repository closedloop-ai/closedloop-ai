import { Status } from "@repo/api/src/types/result";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  PUT,
} from "@/app/teams/[teamId]/repositories/[teamRepositoryId]/route";
import { teamsService } from "@/app/teams/service";
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

const teamRepositoryId = uuidv7();

const buildUpdatedRepo = (overrides: Record<string, unknown> = {}) => ({
  id: teamRepositoryId,
  teamId: "team-1",
  installationRepositoryId: uuidv7(),
  isDefaultSelected: true,
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

describe("PUT /teams/:teamId/repositories/:teamRepositoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("updates flags with valid data", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.updateRepository).mockResolvedValue({
      ok: true,
      value: buildUpdatedRepo({ isPrimary: true }) as any,
    });

    const response = await PUT(
      createMockRequest({
        method: "PUT",
        body: { isPrimary: true },
      }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.isPrimary).toBe(true);
    expect(teamsService.updateRepository).toHaveBeenCalledWith(
      "team-1",
      teamRepositoryId,
      { isPrimary: true }
    );
  });

  it("returns 403 when caller is not admin", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await PUT(
      createMockRequest({ method: "PUT", body: { isPrimary: true } }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(403);
    expect(teamsService.updateRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const response = await PUT(
      createMockRequest({ method: "PUT", body: { isPrimary: true } }),
      createMockRouteContext({ teamId: "missing", teamRepositoryId })
    );

    expect(response.status).toBe(404);
    expect(teamsService.updateRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team repository not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.updateRepository).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await PUT(
      createMockRequest({ method: "PUT", body: { isPrimary: true } }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 when body has no fields", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const response = await PUT(
      createMockRequest({ method: "PUT", body: {} }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(400);
    expect(teamsService.updateRepository).not.toHaveBeenCalled();
  });
});

describe("DELETE /teams/:teamId/repositories/:teamRepositoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("removes a repository", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.removeRepository).mockResolvedValue({
      ok: true,
      value: true,
    });

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(true);
    expect(teamsService.removeRepository).toHaveBeenCalledWith(
      "team-1",
      teamRepositoryId
    );
  });

  it("returns 403 when caller is not admin", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(403);
    expect(teamsService.removeRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "missing", teamRepositoryId })
    );

    expect(response.status).toBe(404);
    expect(teamsService.removeRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team repository not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue({
      id: "team-1",
      organizationId: "org-1",
    } as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.removeRepository).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(404);
  });
});
