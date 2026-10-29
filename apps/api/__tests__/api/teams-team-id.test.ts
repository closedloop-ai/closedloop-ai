import { Result, Status } from "@repo/api/src/types/result";
import { TeamRole } from "@repo/api/src/types/teams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PUT } from "@/app/teams/[teamId]/route";
import { TEAM_SLUG_CONFLICT_MESSAGE, teamsService } from "@/app/teams/service";
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
vi.mock("@/app/teams/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/teams/service")>();
  return {
    ...original,
    teamsService: {
      findById: vi.fn(),
      existsInOrganization: vi.fn(),
      hasRole: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

describe("GET /teams/:teamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
  });

  it("returns team with counts", async () => {
    const mockTeam = {
      id: "team-1",
      name: "Test Team",
      slug: "test-team",
      organizationId: "org-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
      _count: { members: 5, projects: 3 },
    };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("team-1");
    expect(json.data.memberCount).toBe(5);
    expect(json.data.projectCount).toBe(3);
    expect(teamsService.findById).toHaveBeenCalledWith("team-1", "org-1");
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/nonexistent",
    });
    const routeContext = createMockRouteContext({ teamId: "nonexistent" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Team not found");
  });

  it("returns error response on service failure", async () => {
    vi.mocked(teamsService.findById).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch team");
  });
});

describe("PUT /teams/:teamId", () => {
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

  it("updates team with valid data", async () => {
    const mockUpdatedTeam = {
      id: "team-1",
      name: "Updated Team",
      slug: "updated-team",
      organizationId: "org-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockResolvedValue(
      Result.ok(mockUpdatedTeam)
    );

    const request = createMockRequest({
      method: "PUT",
      body: { name: "Updated Team" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("Updated Team");
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
    expect(teamsService.update).toHaveBeenCalledWith("team-1", "org-1", {
      name: "Updated Team",
    });
  });

  it("updates team slug", async () => {
    const mockUpdatedTeam = {
      id: "team-1",
      name: "Test Team",
      slug: "new-slug",
      organizationId: "org-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockResolvedValue(
      Result.ok(mockUpdatedTeam)
    );

    const request = createMockRequest({
      method: "PUT",
      body: { slug: "new-slug" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.update).toHaveBeenCalledWith("team-1", "org-1", {
      slug: "new-slug",
    });
  });

  it("maps a team the caller cannot see to 404, before consulting the role", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const request = createMockRequest({
      method: "PUT",
      body: { name: "Updated Team" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team not found");
    // Ordering is the contract ISS-7533 restores: a caller who cannot see the
    // team never reaches the role gate.
    expect(teamsService.hasRole).not.toHaveBeenCalled();
    expect(teamsService.update).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not admin/owner", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({
      method: "PUT",
      body: { name: "Updated Team" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.update).not.toHaveBeenCalled();
  });

  // `requireTeamRole` already answers 404 for every team the caller cannot see,
  // so this service-level NotFound is the narrower residue: a team that was
  // visible at the gate and disappeared before the write. The gate's own
  // ordering is pinned in `app/teams/require-team-role.test.ts`.
  it("maps a NotFound result from the service to 404", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockResolvedValue(
      Result.err(Status.NotFound)
    );

    const request = createMockRequest({
      method: "PUT",
      body: { name: "Updated Team" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Team not found");
  });

  it("maps a Conflict result from the service to 409", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockResolvedValue(
      Result.err(Status.Conflict)
    );

    const request = createMockRequest({
      method: "PUT",
      body: { slug: "taken-slug" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(TEAM_SLUG_CONFLICT_MESSAGE);
  });

  it("returns validation error for empty name", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const request = createMockRequest({
      method: "PUT",
      body: { name: "" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.update).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      method: "PUT",
      body: { name: "Updated Team" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to update team");
  });
});

describe("DELETE /teams/:teamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
  });

  it("deletes team when user is owner", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.delete).mockResolvedValue(Result.ok(true));

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Owner,
    });
    expect(teamsService.delete).toHaveBeenCalledWith("team-1", "org-1");
  });

  it("maps a team the caller cannot see to 404, before consulting the role", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team not found");
    expect(teamsService.hasRole).not.toHaveBeenCalled();
    expect(teamsService.delete).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not owner", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.delete).not.toHaveBeenCalled();
  });

  it("returns 403 when user is admin but not owner", async () => {
    // Admin role is not sufficient for DELETE - requires OWNER
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(403);
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Owner,
    });
  });

  // Same ordering as PUT: the gate has already 404'd anything the caller cannot
  // see, so this 404 is the delete that races another delete.
  it("maps a NotFound result from the service to 404", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.delete).mockResolvedValue(
      Result.err(Status.NotFound)
    );

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Team not found");
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.delete).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to delete team");
  });
});
