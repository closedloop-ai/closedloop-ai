import { Priority } from "@repo/api/src/types/common";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toWireJson } from "@/__tests__/support/wire-json.test-helpers";
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
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/custom-fields/route-helpers", () => ({
  mergeCustomFieldsIntoResponse: vi.fn(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      customFields: [],
    })
  ),
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

const mockProjectWithDetails: ProjectWithDetails = {
  id: "project-1",
  organizationId: "org-1",
  name: "Test Project",
  description: null,
  priority: Priority.Medium,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "user-1",
  slug: "PROJ-1",
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  completionPercentage: 0,
  teams: [],
};

describe("GET /api/projects/by-slug/:slug", () => {
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

  it("returns project when found by slug", async () => {
    vi.mocked(projectsService.findBySlug).mockResolvedValue(
      mockProjectWithDetails
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/projects/by-slug/PROJ-1",
    });
    const routeContext = createMockRouteContext({ slug: "PROJ-1" });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(
      toWireJson({ ...mockProjectWithDetails, customFields: [] })
    );
  });

  it("calls findBySlug with slug and organizationId from auth context", async () => {
    vi.mocked(projectsService.findBySlug).mockResolvedValue(
      mockProjectWithDetails
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
