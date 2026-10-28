import { TeamRole } from "@repo/api/src/types/teams";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service");
vi.mock("@/app/users/service");

describe("GET /teams/:teamId/members", () => {
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

  it("returns all team members", async () => {
    const mockMembers = [
      {
        id: "member-1",
        teamId: "team-1",
        userId: "user-1",
        role: TeamRole.Owner,
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
        role: TeamRole.Member,
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

    vi.mocked(teamsService.getMembers).mockResolvedValue(mockMembers);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/members",
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(teamsService.existsInOrganization).toHaveBeenCalledWith(
      "team-1",
      "org-1"
    );
    expect(teamsService.getMembers).toHaveBeenCalledWith("team-1");
  });

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

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
    vi.mocked(teamsService.existsInOrganization).mockRejectedValue(
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

  it("adds member with valid data", async () => {
    const mockMember = {
      id: "member-1",
      teamId: "team-1",
      userId: targetUserId,
      role: TeamRole.Member,
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
      ...createTestAuthContext().user,
      id: targetUserId,
    });
    vi.mocked(teamsService.addMember).mockResolvedValue(mockMember);

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
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
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
      role: TeamRole.Admin,
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
      ...createTestAuthContext().user,
      id: targetUserId,
    });
    vi.mocked(teamsService.addMember).mockResolvedValue(mockMember);

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

  it("maps a team the caller cannot see to 404, before consulting the role", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const request = createMockRequest({
      method: "POST",
      body: { userId: targetUserId },
    });
    const routeContext = createMockRouteContext({ teamId: "team-1" });
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    // This route has a SECOND 404 (`notFoundResponse("User")`) further down, so
    // asserting the status alone would stay green even if the guard's response
    // were computed and dropped. The body plus the not-called set is what pins
    // which 404 this is.
    const json = await response.json();
    expect(json.error).toBe("Team not found");
    expect(teamsService.hasRole).not.toHaveBeenCalled();
    expect(usersService.findById).not.toHaveBeenCalled();
    expect(teamsService.addMember).not.toHaveBeenCalled();
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
      ...createTestAuthContext().user,
      id: targetUserId,
    });
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
