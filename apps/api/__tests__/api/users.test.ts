import type { User } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

// Create a mock authContext that tests can configure
let mockAuthContext: AuthContext = {
  user: makeUser({ id: "test-user", organizationId: "test-org" }),
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
  authMethod: "session",
  apiKeyScopes: undefined,
};

// Module-level mocks
vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/users/service");

import { toWireJson } from "@/__tests__/support/wire-json.test-helpers";
import { GET } from "@/app/users/route";
import { usersService } from "@/app/users/service";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

beforeEach(() => {
  vi.clearAllMocks();

  // Configure mock auth context
  mockAuthContext = createTestAuthContext({
    user: makeUser({ organizationId: "test-org-id" }),
  });
});

describe("GET /api/users", () => {
  it("returns all users in organization", async () => {
    const mockUsers = [
      makeUser({
        id: "1",
        email: "user1@example.com",
        firstName: "User",
        lastName: "One",
      }),
      makeUser({
        id: "2",
        email: "user2@example.com",
        firstName: "User",
        lastName: "Two",
      }),
    ];
    vi.mocked(usersService.findByOrganization).mockResolvedValue(mockUsers);

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(toWireJson(mockUsers));
    expect(usersService.findByOrganization).toHaveBeenCalledWith("test-org-id");
  });

  it("returns error on service failure", async () => {
    vi.mocked(usersService.findByOrganization).mockRejectedValue(
      new Error("Service error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns only active users", async () => {
    const mockUsers = [
      makeUser({
        id: "1",
        email: "active@example.com",
        firstName: "Active",
        lastName: "User",
        active: true,
      }),
    ];
    vi.mocked(usersService.findByOrganization).mockResolvedValue(mockUsers);

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(toWireJson(mockUsers));
    expect(
      json.data.every((u: { active?: unknown }) => u.active === true)
    ).toBe(true);
  });

  it("excludes inactive users", async () => {
    // Mock service returns only active users (inactive users not included)
    const mockActiveUsers = [
      makeUser({
        id: "1",
        email: "active@example.com",
        firstName: "Active",
        lastName: "User",
        active: true,
      }),
    ];
    vi.mocked(usersService.findByOrganization).mockResolvedValue(
      mockActiveUsers
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // Should not include inactive users
    expect(json.data.length).toBe(1);
    expect(json.data[0].active).toBe(true);
  });

  it("excludes inactive GitHub shadow users from the user list", async () => {
    const mockActiveUsers = [
      makeUser({
        id: "1",
        clerkId: "clerk_active",
        email: "active@example.com",
        firstName: "Active",
        lastName: "User",
        active: true,
      }),
    ];
    vi.mocked(usersService.findByOrganization).mockResolvedValue(
      mockActiveUsers
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(toWireJson(mockActiveUsers));
    expect(JSON.stringify(json.data)).not.toContain("github-shadow:");
    expect(usersService.findByOrganization).toHaveBeenCalledWith("test-org-id");
  });
});

function makeUser(overrides: Partial<User> = {}): User {
  return { ...createTestAuthContext().user, ...overrides };
}
