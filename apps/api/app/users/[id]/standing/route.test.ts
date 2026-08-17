import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "viewer-1", organizationId: "org-1" },
    authMethod: "session",
  },
  findById: vi.fn(),
  getUserProfileStanding: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        ctx: unknown,
        request: NextRequest,
        params: unknown
      ) => Promise<Response>
    ) =>
    (request: NextRequest, context: unknown) =>
      handler(mocks.auth, request, (context as { params: unknown }).params),
}));

vi.mock("../../service", () => ({
  usersService: {
    findById: mocks.findById,
  },
}));

vi.mock("../../user-profile-service", () => ({
  userProfileService: {
    getUserProfileStanding: mocks.getUserProfileStanding,
  },
}));

import { GET } from "./route";

describe("GET /users/[id]/standing (FEA-4108)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: "viewer-1", organizationId: "org-1" };
    mocks.findById.mockResolvedValue({ id: "user-2", organizationId: "org-1" });
    mocks.getUserProfileStanding.mockResolvedValue({ streak: null });
  });

  it("returns the streak standing scoped to the viewer's org", async () => {
    const response = await GET(
      request("https://api.example.test/users/user-2/standing"),
      routeContext("user-2")
    );

    expect(response.status).toBe(200);
    expect(mocks.getUserProfileStanding).toHaveBeenCalledTimes(1);
    expect(mocks.getUserProfileStanding).toHaveBeenCalledWith(
      "user-2",
      "org-1"
    );
  });

  it("returns 404 when the target user is not in the viewer's org", async () => {
    mocks.findById.mockResolvedValue(null);

    const response = await GET(
      request("https://api.example.test/users/ghost/standing"),
      routeContext("ghost")
    );

    expect(response.status).toBe(404);
    expect(mocks.getUserProfileStanding).not.toHaveBeenCalled();
  });
});

function request(url: string) {
  return new NextRequest(url, { method: "GET" });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
