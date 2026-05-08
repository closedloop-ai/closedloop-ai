import { vi } from "vitest";
import { dashboardService } from "@/app/dashboard/service";
import { GET } from "@/app/dashboard/stats/route";
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
vi.mock("@/app/dashboard/service");

describe("GET /api/dashboard/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns dashboard stats for authenticated user", async () => {
    const mockStats = {
      prds: { count: 5, trend: [{ date: "2025-01-20", count: 2 }] },
      features: { count: 10, trend: [{ date: "2025-01-20", count: 3 }] },
      plans: { count: 3, trend: [{ date: "2025-01-20", count: 1 }] },
      landedCode: { count: 8, trend: [{ date: "2025-01-20", count: 4 }] },
      agenticWorkflows: {
        count: 12,
        trend: [{ date: "2025-01-20", count: 5 }],
      },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(mockStats);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockStats);
  });

  it("calls service with organization ID from auth context", async () => {
    mockAuthContext = createTestAuthContext({
      user: { organizationId: "org-abc-123" } as any,
    });

    vi.mocked(dashboardService.getDashboardStats).mockResolvedValue({
      prds: { count: 0, trend: [] },
      features: { count: 0, trend: [] },
      plans: { count: 0, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    });

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    await GET(request, createMockRouteContext({}));

    expect(dashboardService.getDashboardStats).toHaveBeenCalledWith(
      "org-abc-123"
    );
  });

  it("returns error response when service fails", async () => {
    vi.mocked(dashboardService.getDashboardStats).mockRejectedValue(
      new Error("Database connection failed")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch dashboard stats");
  });

  it("returns stats with empty trends when no recent data", async () => {
    const mockStats = {
      prds: { count: 5, trend: [] },
      features: { count: 10, trend: [] },
      plans: { count: 3, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(mockStats);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.prds.trend).toEqual([]);
    expect(json.data.landedCode.count).toBe(0);
  });

  it("includes correct Content-Type header", async () => {
    vi.mocked(dashboardService.getDashboardStats).mockResolvedValue({
      prds: { count: 0, trend: [] },
      features: { count: 0, trend: [] },
      plans: { count: 0, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    });

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns stats with placeholder counts as undefined", async () => {
    const mockStats = {
      prds: { count: 5, trend: [] },
      features: { count: 10, trend: [] },
      plans: { count: 3, trend: [] },
      landedCode: { count: 8, trend: [] },
      agenticWorkflows: { count: 12, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(mockStats);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/stats",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.agentsCount).toBeUndefined();
    expect(json.data.leaderboardsCount).toBeUndefined();
  });
});
