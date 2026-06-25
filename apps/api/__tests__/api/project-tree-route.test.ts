import {
  PROJECT_TREE_INCLUDE_PARAM,
  ProjectTreeInclude,
} from "@repo/api/src/types/project-tree";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { GET } from "@/app/projects/[id]/tree/route";
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
    handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/artifacts/project-tree-service");
vi.mock("@/app/projects/service");

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";

const mockTree = {
  nodes: [],
  externalParents: [],
};

describe("GET /projects/[id]/tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: { organizationId: "test-org-id" } as any,
    });
    vi.mocked(projectsService.findById).mockResolvedValue({
      id: PROJECT_ID,
    } as any);
    vi.mocked(projectTreeService.getProjectTree).mockResolvedValue(
      mockTree as any
    );
  });

  it("returns the plain tree without the details lookup", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual(mockTree);
    expect(projectTreeService.getProjectTreeWithDetails).not.toHaveBeenCalled();
  });

  it("returns the detail-enriched tree with ?include=details", async () => {
    const detailedTree = {
      nodes: [
        {
          root: { id: "doc-1", tags: [{ id: "t1", name: "infra" }] },
          children: [],
        },
      ],
      externalParents: [],
    };
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      detailedTree as any
    );

    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual(detailedTree);
    expect(projectTreeService.getProjectTreeWithDetails).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id"
    );
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("returns 404 for a project outside the org", async () => {
    vi.mocked(projectsService.findById).mockResolvedValue(null);

    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(404);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });
});
