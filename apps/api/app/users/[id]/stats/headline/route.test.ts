import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "viewer-1", organizationId: "org-1" },
    authMethod: "session",
  },
  findById: vi.fn(),
  getUserProfileHeadline: vi.fn(),
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

vi.mock("../../../service", () => ({
  usersService: {
    findById: mocks.findById,
  },
}));

vi.mock("../../../user-profile-service", () => ({
  userProfileService: {
    getUserProfileHeadline: mocks.getUserProfileHeadline,
  },
}));

import { GET } from "./route";

describe("GET /users/[id]/stats/headline (FEA-4064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: "viewer-1", organizationId: "org-1" };
    mocks.findById.mockResolvedValue({ id: "user-2", organizationId: "org-1" });
    mocks.getUserProfileHeadline.mockResolvedValue(emptyHeadline());
  });

  it("parses a valid startDate query param and forwards it to the org-scoped service", async () => {
    const iso = "2026-05-01T00:00:00.000Z";
    const response = await GET(
      request(
        `https://api.example.test/users/user-2/stats/headline?startDate=${iso}`
      ),
      routeContext("user-2")
    );

    expect(response.status).toBe(200);
    expect(mocks.getUserProfileHeadline).toHaveBeenCalledTimes(1);
    const [userId, organizationId, startDate] =
      mocks.getUserProfileHeadline.mock.calls[0];
    expect(userId).toBe("user-2");
    expect(organizationId).toBe("org-1");
    expect(startDate).toBeInstanceOf(Date);
    expect((startDate as Date).toISOString()).toBe(iso);
  });

  it("rejects a malformed startDate with 400 before touching the service", async () => {
    const response = await GET(
      request(
        "https://api.example.test/users/user-2/stats/headline?startDate=not-a-date"
      ),
      routeContext("user-2")
    );

    expect(response.status).toBe(400);
    // Fail fast at the boundary: neither the headline aggregation nor the
    // existence lookup runs for a bad window.
    expect(mocks.getUserProfileHeadline).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("omits startDate (all-time totals) when the query param is absent", async () => {
    const response = await GET(
      request("https://api.example.test/users/user-2/stats/headline"),
      routeContext("user-2")
    );

    expect(response.status).toBe(200);
    expect(mocks.getUserProfileHeadline).toHaveBeenCalledWith(
      "user-2",
      "org-1",
      undefined
    );
  });

  it("returns 404 when the target user is not in the viewer's org", async () => {
    mocks.findById.mockResolvedValue(null);

    const response = await GET(
      request("https://api.example.test/users/ghost/stats/headline"),
      routeContext("ghost")
    );

    expect(response.status).toBe(404);
    expect(mocks.getUserProfileHeadline).not.toHaveBeenCalled();
  });
});

function request(url: string) {
  return new NextRequest(url, { method: "GET" });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function emptyHeadline() {
  return {
    totalDocuments: 0,
    documentsByType: [],
    totalComments: 0,
    totalPRsLanded: 0,
    totalLoops: 0,
    avgConcurrency: 0,
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalEstimatedCost: 0,
  };
}
