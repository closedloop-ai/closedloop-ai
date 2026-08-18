import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "viewer-1", organizationId: "org-1" },
    authMethod: "session",
  },
  findById: vi.fn(),
  getUserContributionHeatmap: vi.fn(),
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
    getUserContributionHeatmap: mocks.getUserContributionHeatmap,
  },
}));

import { GET } from "./route";

describe("GET /users/[id]/contributions (FEA-4064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: "viewer-1", organizationId: "org-1" };
    mocks.findById.mockResolvedValue({ id: "user-2", organizationId: "org-1" });
    mocks.getUserContributionHeatmap.mockResolvedValue({
      contributionHeatmap: [],
    });
  });

  it("returns the fixed-window heatmap without taking any range param", async () => {
    const response = await GET(
      request(
        // A stray startDate param must be ignored — this widget is unranged.
        "https://api.example.test/users/user-2/contributions?startDate=2026-05-01T00:00:00.000Z"
      ),
      routeContext("user-2")
    );

    expect(response.status).toBe(200);
    expect(mocks.getUserContributionHeatmap).toHaveBeenCalledTimes(1);
    // Only (userId, organizationId) — no startDate is threaded through, so the
    // toggle can never re-scope this read.
    expect(mocks.getUserContributionHeatmap).toHaveBeenCalledWith(
      "user-2",
      "org-1"
    );
  });

  it("returns 404 when the target user is not in the viewer's org", async () => {
    mocks.findById.mockResolvedValue(null);

    const response = await GET(
      request("https://api.example.test/users/ghost/contributions"),
      routeContext("ghost")
    );

    expect(response.status).toBe(404);
    expect(mocks.getUserContributionHeatmap).not.toHaveBeenCalled();
  });
});

function request(url: string) {
  return new NextRequest(url, { method: "GET" });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
