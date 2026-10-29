import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/teams/route";
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
// GET /teams is `withAnyAuth` (ISS-6966); POST is still `withAuth`. Which
// wrapper each verb actually uses is asserted in teams-route-auth.test.ts —
// this stub only supplies an authenticated context to the handler bodies.
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/teams/service")>();
  return {
    ...original,
    teamsService: {
      findByOrganization: vi.fn(),
      createWithOwner: vi.fn(),
      findById: vi.fn(),
    },
  };
});

describe("GET /teams", () => {
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

  it("returns all teams for user's organization", async () => {
    const mockTeams = [
      {
        id: "team-1",
        name: "Team One",
        slug: "team-one",
        organizationId: "org-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { members: 3, projects: 2 },
      },
      {
        id: "team-2",
        name: "Team Two",
        slug: "team-two",
        organizationId: "org-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { members: 1, projects: 0 },
      },
    ];

    vi.mocked(teamsService.findByOrganization).mockResolvedValue(mockTeams);

    const request = createMockRequest({ url: "http://localhost:3002/teams" });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(json.data[0].memberCount).toBe(3);
    expect(json.data[0].projectCount).toBe(2);
    expect(teamsService.findByOrganization).toHaveBeenCalledWith("org-1");
  });

  it("returns empty array when no teams exist", async () => {
    vi.mocked(teamsService.findByOrganization).mockResolvedValue([]);

    const request = createMockRequest({ url: "http://localhost:3002/teams" });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns error response on service failure", async () => {
    vi.mocked(teamsService.findByOrganization).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({ url: "http://localhost:3002/teams" });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch teams");
  });
});

describe("POST /teams", () => {
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

  it("creates team with valid data", async () => {
    const mockTeam = {
      id: "new-team-id",
      name: "New Team",
      slug: "new-team",
      organizationId: "org-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mockTeamWithCounts = {
      ...mockTeam,
      members: [],
      _count: { members: 1, projects: 0 },
    };

    vi.mocked(teamsService.createWithOwner).mockResolvedValue(
      Result.ok(mockTeam)
    );
    vi.mocked(teamsService.findById).mockResolvedValue(mockTeamWithCounts);

    const request = createMockRequest({
      method: "POST",
      body: { name: "New Team" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("New Team");
    expect(json.data.memberCount).toBe(1);
    expect(teamsService.createWithOwner).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      { name: "New Team" }
    );
  });

  it("creates team with custom slug", async () => {
    const mockTeam = {
      id: "new-team-id",
      name: "New Team",
      slug: "custom-slug",
      organizationId: "org-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mockTeamWithCounts = {
      ...mockTeam,
      members: [],
      _count: { members: 1, projects: 0 },
    };

    vi.mocked(teamsService.createWithOwner).mockResolvedValue(
      Result.ok(mockTeam)
    );
    vi.mocked(teamsService.findById).mockResolvedValue(mockTeamWithCounts);

    const request = createMockRequest({
      method: "POST",
      body: { name: "New Team", slug: "custom-slug" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    expect(teamsService.createWithOwner).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      { name: "New Team", slug: "custom-slug" }
    );
  });

  it("returns validation error for missing name", async () => {
    const request = createMockRequest({
      method: "POST",
      body: {},
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns validation error for empty name", async () => {
    const request = createMockRequest({
      method: "POST",
      body: { name: "" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 500 when service fails", async () => {
    vi.mocked(teamsService.createWithOwner).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      method: "POST",
      body: { name: "New Team" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to create team");
  });

  it("maps a Conflict result from the service to 409", async () => {
    vi.mocked(teamsService.createWithOwner).mockResolvedValue(
      Result.err(Status.Conflict)
    );

    const request = createMockRequest({
      method: "POST",
      body: { name: "New Team", slug: "taken-slug" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(TEAM_SLUG_CONFLICT_MESSAGE);
    // The conflict short-circuits before the read-back.
    expect(teamsService.findById).not.toHaveBeenCalled();
  });

  it("returns error when team created but cannot be retrieved", async () => {
    vi.mocked(teamsService.createWithOwner).mockResolvedValue(
      Result.ok({ id: "new-team-id" } as never)
    );
    vi.mocked(teamsService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: { name: "New Team" },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Team created but could not be retrieved");
  });
});
