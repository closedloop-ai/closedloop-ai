import { vi } from "vitest";
import { GET } from "@/app/projects/by-slug/[slug]/route";
import { projectsService } from "@/app/projects/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/projects/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/projects/service")>();
  return {
    ...original,
    projectsService: {
      findBySlug: vi.fn(),
    },
  };
});

const mockProjectWithDetails = {
  id: "project-1",
  organizationId: "org-1",
  name: "Test Project",
  slug: "PROJ-1",
  completionPercentage: 0,
  teams: [],
};

describe("GET /api/projects/by-slug/:slug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });
  });

  it("returns project when found by slug", async () => {
    vi.mocked(projectsService.findBySlug).mockResolvedValue(
      mockProjectWithDetails as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/projects/by-slug/PROJ-1",
    });
    const routeContext = createMockRouteContext({ slug: "PROJ-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockProjectWithDetails);
  });

  it("calls findBySlug with slug and organizationId from auth context", async () => {
    vi.mocked(projectsService.findBySlug).mockResolvedValue(
      mockProjectWithDetails as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/projects/by-slug/PROJ-42",
    });
    const routeContext = createMockRouteContext({ slug: "PROJ-42" });
    await GET(request, routeContext);

    expect(projectsService.findBySlug).toHaveBeenCalledWith("PROJ-42", "org-1");
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(projectsService.findBySlug).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/api/projects/by-slug/PROJ-999",
    });
    const routeContext = createMockRouteContext({ slug: "PROJ-999" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Project not found");
  });

  it("returns 500 when service throws an error", async () => {
    vi.mocked(projectsService.findBySlug).mockRejectedValue(
      new Error("Database connection failed")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/projects/by-slug/PROJ-1",
    });
    const routeContext = createMockRouteContext({ slug: "PROJ-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch project");
  });
});
