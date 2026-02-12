import { vi } from "vitest";
import { GET } from "@/app/dashboard/workstreams/route";
import { workstreamsService } from "@/app/workstreams/service";
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
vi.mock("@/app/workstreams/service");

describe("GET /api/dashboard/workstreams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns in-progress workstreams for authenticated user", async () => {
    const mockWorkstreams = [
      {
        id: "ws-1",
        title: "Authentication Feature",
        description: "Implement auth system",
        state: "IN_PROGRESS",
        type: "FEATURE_DELIVERY",
        project: { name: "Core Platform" },
        updatedAt: new Date("2025-01-20"),
      },
      {
        id: "ws-2",
        title: "Dashboard UI",
        description: "Build dashboard",
        state: "IN_REVIEW",
        type: "FEATURE_DELIVERY",
        project: { name: "Frontend" },
        updatedAt: new Date("2025-01-19"),
      },
    ];

    vi.mocked(workstreamsService.findAllByOrganization).mockResolvedValue(
      mockWorkstreams as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(json.data[0].project.name).toBe("Core Platform");
  });

  it("calls service with organization ID and excluded states", async () => {
    mockAuthContext = createTestAuthContext({
      user: { organizationId: "org-xyz-789" } as any,
    });

    vi.mocked(workstreamsService.findAllByOrganization).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    await GET(request, createMockRouteContext({}));

    expect(workstreamsService.findAllByOrganization).toHaveBeenCalledWith(
      "org-xyz-789",
      {
        excludeStates: ["COMPLETED", "CANCELLED", "DEPLOYED"],
      }
    );
  });

  it("returns empty array when no workstreams exist", async () => {
    vi.mocked(workstreamsService.findAllByOrganization).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual([]);
  });

  it("returns error response when service fails", async () => {
    vi.mocked(workstreamsService.findAllByOrganization).mockRejectedValue(
      new Error("Database query timeout")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch in-progress workstreams");
  });

  it("includes project name in workstream data", async () => {
    const mockWorkstreams = [
      {
        id: "ws-1",
        title: "Feature A",
        state: "IN_PROGRESS",
        project: { name: "Project Alpha" },
        updatedAt: new Date(),
      },
    ];

    vi.mocked(workstreamsService.findAllByOrganization).mockResolvedValue(
      mockWorkstreams as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    const response = await GET(request, createMockRouteContext({}));

    const json = await response.json();
    expect(json.data[0].project).toEqual({ name: "Project Alpha" });
  });

  it("includes correct Content-Type header", async () => {
    vi.mocked(workstreamsService.findAllByOrganization).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/dashboard/workstreams",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
