import { vi } from "vitest";
import { DELETE, PUT } from "@/app/teams/[teamId]/members/[userId]/route";
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

describe("PUT /teams/:teamId/members/:userId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("updates member role", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockExistingMember = {
      id: "member-1",
      teamId: "team-1",
      userId: "target-user",
      role: "MEMBER",
    };
    const mockUpdatedMember = {
      id: "member-1",
      teamId: "team-1",
      userId: "target-user",
      role: "ADMIN",
      createdAt: new Date(),
      user: {
        id: "target-user",
        firstName: "Target",
        lastName: "User",
        email: "target@example.com",
        avatarUrl: null,
      },
    };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(
      mockExistingMember as any
    );
    vi.mocked(teamsService.updateMemberRole).mockResolvedValue(
      mockUpdatedMember as any
    );

    const request = createMockRequest({
      method: "PUT",
      body: { role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.role).toBe("ADMIN");
    expect(teamsService.updateMemberRole).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: "target-user",
      role: "ADMIN",
    });
  });

  it("promotes member to owner", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockExistingMember = { id: "member-1", role: "MEMBER" };
    const mockUpdatedMember = {
      id: "member-1",
      teamId: "team-1",
      userId: "target-user",
      role: "OWNER",
      createdAt: new Date(),
      user: { id: "target-user" },
    };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(
      mockExistingMember as any
    );
    vi.mocked(teamsService.updateMemberRole).mockResolvedValue(
      mockUpdatedMember as any
    );

    const request = createMockRequest({
      method: "PUT",
      body: { role: "OWNER" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.updateMemberRole).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: "target-user",
      role: "OWNER",
    });
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      method: "PUT",
      body: { role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "nonexistent",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team not found");
    expect(teamsService.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not admin/owner", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({
      method: "PUT",
      body: { role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(403);
    expect(teamsService.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 404 when member not found", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(null);

    const request = createMockRequest({
      method: "PUT",
      body: { role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "nonexistent-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team member not found");
    expect(teamsService.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns validation error for missing role", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);

    const request = createMockRequest({
      method: "PUT",
      body: {},
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(400);
    expect(teamsService.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns validation error for invalid role", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);

    const request = createMockRequest({
      method: "PUT",
      body: { role: "SUPERADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(400);
    expect(teamsService.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);
    vi.mocked(teamsService.updateMemberRole).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      method: "PUT",
      body: { role: "ADMIN" },
    });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await PUT(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to update team member");
  });
});

describe("DELETE /teams/:teamId/members/:userId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("removes member from team", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);
    vi.mocked(teamsService.removeMember).mockResolvedValue(undefined as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(teamsService.removeMember).toHaveBeenCalledWith(
      "team-1",
      "target-user"
    );
  });

  it("removes admin from team", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "ADMIN" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);
    vi.mocked(teamsService.removeMember).mockResolvedValue(undefined as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-admin",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.removeMember).toHaveBeenCalledWith(
      "team-1",
      "target-admin"
    );
  });

  it("returns 404 when team not found", async () => {
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "nonexistent",
      userId: "target-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team not found");
    expect(teamsService.removeMember).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not admin/owner", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(403);
    expect(teamsService.removeMember).not.toHaveBeenCalled();
  });

  it("returns 404 when member not found", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(null);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "nonexistent-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Team member not found");
    expect(teamsService.removeMember).not.toHaveBeenCalled();
  });

  it("returns 400 when removing last owner", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockOwnerMember = { id: "member-1", role: "OWNER" };
    const mockAllMembers = [{ id: "member-1", role: "OWNER" }]; // Only one owner

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockOwnerMember as any);
    vi.mocked(teamsService.getMembers).mockResolvedValue(mockAllMembers as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "owner-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Cannot remove the last owner of a team");
    expect(teamsService.removeMember).not.toHaveBeenCalled();
  });

  it("allows removing owner when multiple owners exist", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockOwnerMember = { id: "member-1", role: "OWNER" };
    const mockAllMembers = [
      { id: "member-1", role: "OWNER" },
      { id: "member-2", role: "OWNER" }, // Another owner exists
    ];

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockOwnerMember as any);
    vi.mocked(teamsService.getMembers).mockResolvedValue(mockAllMembers as any);
    vi.mocked(teamsService.removeMember).mockResolvedValue(undefined as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "owner-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.removeMember).toHaveBeenCalledWith(
      "team-1",
      "owner-user"
    );
  });

  it("does not check owner count for non-owner members", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);
    vi.mocked(teamsService.removeMember).mockResolvedValue(undefined as any);

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "member-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    // getMembers should not be called for non-owner
    expect(teamsService.getMembers).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    const mockTeam = { id: "team-1", organizationId: "org-1" };
    const mockMember = { id: "member-1", role: "MEMBER" };

    vi.mocked(teamsService.findById).mockResolvedValue(mockTeam as any);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember as any);
    vi.mocked(teamsService.removeMember).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({ method: "DELETE" });
    const routeContext = createMockRouteContext({
      teamId: "team-1",
      userId: "target-user",
    });
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to remove team member");
  });
});
