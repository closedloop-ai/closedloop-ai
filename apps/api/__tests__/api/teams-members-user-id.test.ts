import { TeamRole } from "@repo/api/src/types/teams";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service");

describe("PUT /teams/:teamId/members/:userId", () => {
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

  it("updates member role", async () => {
    const mockExistingMember = makeMember({ role: TeamRole.Member });
    const mockUpdatedMember = makeMember({
      role: TeamRole.Admin,
      user: {
        id: "target-user",
        firstName: "Target",
        lastName: "User",
        email: "target@example.com",
        avatarUrl: null,
      },
    });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockExistingMember);
    vi.mocked(teamsService.updateMemberRole).mockResolvedValue(
      mockUpdatedMember
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
    const mockExistingMember = makeMember({ role: TeamRole.Member });
    const mockUpdatedMember = makeMember({ role: TeamRole.Owner });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockExistingMember);
    vi.mocked(teamsService.updateMemberRole).mockResolvedValue(
      mockUpdatedMember
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

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

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
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);

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
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);

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
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);
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

  it("removes member from team", async () => {
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);
    vi.mocked(teamsService.removeMember).mockResolvedValue(makeMember());

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
    const mockMember = makeMember({ role: TeamRole.Admin });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);
    vi.mocked(teamsService.removeMember).mockResolvedValue(makeMember());

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

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

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
    const mockOwnerMember = makeMember({ role: TeamRole.Owner });
    const mockAllMembers = [makeMember({ role: TeamRole.Owner })]; // Only one owner

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockOwnerMember);
    vi.mocked(teamsService.getMembers).mockResolvedValue(mockAllMembers);

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
    const mockOwnerMember = makeMember({ role: TeamRole.Owner });
    const mockAllMembers = [
      makeMember({ role: TeamRole.Owner }),
      makeMember({ id: "member-2", role: TeamRole.Owner }), // Another owner exists
    ];

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockOwnerMember);
    vi.mocked(teamsService.getMembers).mockResolvedValue(mockAllMembers);
    vi.mocked(teamsService.removeMember).mockResolvedValue(makeMember());

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
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);
    vi.mocked(teamsService.removeMember).mockResolvedValue(makeMember());

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
    const mockMember = makeMember({ role: TeamRole.Member });

    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.getMember).mockResolvedValue(mockMember);
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

type TeamMemberRow = NonNullable<
  Awaited<ReturnType<typeof teamsService.getMember>>
>;

function makeMember(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "member-1",
    teamId: "team-1",
    userId: "target-user",
    role: TeamRole.Member,
    createdAt: new Date(),
    user: {
      id: "target-user",
      firstName: null,
      lastName: null,
      email: "target@example.com",
      avatarUrl: null,
    },
    ...overrides,
  };
}
