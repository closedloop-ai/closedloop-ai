import { vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

// Create a mock authContext that tests can configure
let mockAuthContext: AuthContext = {
  user: { id: "test-user", organizationId: "test-org" } as any,
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
};

// Module-level mocks
vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/users/service");

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
    user: { organizationId: "test-org-id" } as any,
  });
});

describe("GET /api/users", () => {
  it("returns all users in organization", async () => {
    const mockUsers = [
      {
        id: "1",
        email: "user1@example.com",
        firstName: "User",
        lastName: "One",
      },
      {
        id: "2",
        email: "user2@example.com",
        firstName: "User",
        lastName: "Two",
      },
    ];
    vi.mocked(usersService.findByOrganization).mockResolvedValue(
      mockUsers as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/users",
    });
    const routeContext = createMockRouteContext({});
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockUsers);
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
});
