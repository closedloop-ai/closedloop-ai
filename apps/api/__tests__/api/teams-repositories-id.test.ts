import { Status } from "@repo/api/src/types/result";
import { TeamRole } from "@repo/api/src/types/teams";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTeamRepository } from "@/__tests__/support/teams/team.test-fixtures";
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
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service");

const teamRepositoryId = uuidv7();

describe("PUT /teams/:teamId/repositories/:teamRepositoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    // `clearAllMocks` does not reset implementations, so this default must be
    // set per-block rather than inherited from a sibling describe.
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
  });

  it("updates flags with valid data", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.updateRepository).mockResolvedValue({
      ok: true,
      value: buildTeamRepository({
        id: teamRepositoryId,
        isDefaultSelected: true,
        isPrimary: true,
      }),
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
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await PUT(
      createMockRequest({ method: "PUT", body: { isPrimary: true } }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(403);
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
    expect(teamsService.updateRepository).not.toHaveBeenCalled();
  });

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await PUT(
      createMockRequest({ method: "PUT", body: { isPrimary: true } }),
      createMockRouteContext({ teamId: "missing", teamRepositoryId })
    );

    expect(response.status).toBe(404);
    expect(teamsService.updateRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team repository not found", async () => {
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
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    // `clearAllMocks` does not reset implementations, so this default must be
    // set per-block rather than inherited from a sibling describe.
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
  });

  it("removes a repository", async () => {
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
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "team-1", teamRepositoryId })
    );

    expect(response.status).toBe(403);
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
    expect(teamsService.removeRepository).not.toHaveBeenCalled();
  });

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ teamId: "missing", teamRepositoryId })
    );

    expect(response.status).toBe(404);
    expect(teamsService.removeRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when team repository not found", async () => {
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
