import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PUT } from "@/app/teams/[teamId]/route";
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
vi.mock("@/app/teams/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/teams/service")>();
  return {
    ...original,
    teamsService: {
      findById: vi.fn(),
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
      user: { id: "user-1", organizationId: "org-1" } as any,
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
      _count: { members: 5, projects: 3 },
    };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);

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
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
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
    vi.mocked(teamsService.update).mockResolvedValue(mockUpdatedTeam as any);

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
    expect(teamsService.hasRole).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      "ADMIN"
    );
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
    vi.mocked(teamsService.update).mockResolvedValue(mockUpdatedTeam as any);

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

  it("returns 404 when team not found after update", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.update).mockResolvedValue(null as any);

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
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("deletes team when user is owner", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.delete).mockResolvedValue(undefined as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(teamsService.hasRole).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      "OWNER"
    );
    expect(teamsService.delete).toHaveBeenCalledWith("team-1", "org-1");
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
    expect(teamsService.hasRole).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      "OWNER"
    );
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
