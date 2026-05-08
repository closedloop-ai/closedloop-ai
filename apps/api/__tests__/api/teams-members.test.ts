import { v7 as uuidv7 } from "uuid";
import { vi } from "vitest";
import { GET, POST } from "@/app/teams/[teamId]/members/route";
import { teamsService } from "@/app/teams/service";
import { usersService } from "@/app/users/service";
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
vi.mock("@/app/users/service");

describe("GET /teams/:teamId/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("returns all team members", async () => {
    const mockTeam = {
      id: "team-1",
      organizationId: "org-1",
    };
    const mockMembers = [
      {
        id: "member-1",
        teamId: "team-1",
        userId: "user-1",
        role: "OWNER",
        createdAt: new Date(),
        user: {
          id: "user-1",
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
          avatarUrl: null,
        },
      },
      {
        id: "member-2",
        teamId: "team-1",
        userId: "user-2",
        role: "MEMBER",
        createdAt: new Date(),
        user: {
          id: "user-2",
          firstName: "Jane",
          lastName: "Smith",
          email: "jane@example.com",
          avatarUrl: null,
        },
      },
    ];

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.getMembers).mockResolvedValue(mockMembers as any);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/members",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(teamsService.findById).toHaveBeenCalledWith("team-1", "org-1");
    expect(teamsService.getMembers).toHaveBeenCalledWith("team-1");
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/nonexistent/members",
    });
    const routeContext = createMockRouteContext({ teamId: "nonexistent" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Team not found");
    expect(teamsService.getMembers).not.toHaveBeenCalled();
  });

  it("returns empty array when team has no members", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.getMembers).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/members",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.findById).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/members",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch team members");
  });
});

describe("POST /teams/:teamId/members", () => {
  const targetUserId = uuidv7();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("adds member with valid data", async () => {
    const mockMember = {
      id: "member-1",
      teamId: "team-1",
      userId: targetUserId,
      role: "MEMBER",
      createdAt: new Date(),
      user: {
        id: targetUserId,
        firstName: "New",
        lastName: "Member",
        email: "new@example.com",
        avatarUrl: null,
      },
    };

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: targetUserId,
    } as any);
    vi.mocked(teamsService.addMember).mockResolvedValue(mockMember as any);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.userId).toBe(targetUserId);
    expect(teamsService.hasRole).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      "ADMIN"
    );
    expect(teamsService.addMember).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: targetUserId,
    });
  });

  it("adds member with specified role", async () => {
    const mockMember = {
      id: "member-1",
      teamId: "team-1",
      userId: targetUserId,
      role: "ADMIN",
      createdAt: new Date(),
      user: {
        id: targetUserId,
        firstName: "New",
        lastName: "Admin",
        email: "admin@example.com",
        avatarUrl: null,
      },
    };

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: targetUserId,
    } as any);
    vi.mocked(teamsService.addMember).mockResolvedValue(mockMember as any);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId, role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.addMember).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: targetUserId,
      role: "ADMIN",
    });
  });

  it("returns 403 when user is not admin/owner", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.addMember).not.toHaveBeenCalled();
  });

  it("returns 404 when target user not found", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(usersService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("User not found");
    expect(teamsService.addMember).not.toHaveBeenCalled();
  });

  it("returns validation error for missing userId", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const request = createMockRequest({
      method: "POST",
      body: {},
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.addMember).not.toHaveBeenCalled();
  });

  it("returns validation error for invalid userId format", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const request = createMockRequest({
      method: "POST",
      body: { userId: "invalid-uuid" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.addMember).not.toHaveBeenCalled();
  });

  it("returns validation error for invalid role", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId, role: "INVALID_ROLE" },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(teamsService.addMember).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: targetUserId,
    } as any);
    vi.mocked(teamsService.addMember).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to add team member");
  });
});
