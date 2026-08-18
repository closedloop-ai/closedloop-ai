import {
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_MAX_ROOT_LIMIT,
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
const CONTRIBUTOR_USER_ID = "22222222-2222-7222-8222-222222222222";

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
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      { contributorUserId: undefined }
    );
    expect(projectTreeService.getProjectTreeWithDetails).not.toHaveBeenCalled();
  });

  it("passes a contributor user filter to the plain tree service", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM}=${CONTRIBUTOR_USER_ID}`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      { contributorUserId: CONTRIBUTOR_USER_ID }
    );
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
      "test-org-id",
      { contributorUserId: undefined }
    );
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("passes a contributor user filter to the detail-enriched tree service", async () => {
    const detailedTree = {
      nodes: [],
      externalParents: [],
    };
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      detailedTree as any
    );

    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM}=${CONTRIBUTOR_USER_ID}`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTreeWithDetails).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      { contributorUserId: CONTRIBUTOR_USER_ID }
    );
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("rejects an invalid contributor user filter before reading the tree", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM}=not-a-user-id`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(400);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
    expect(projectTreeService.getProjectTreeWithDetails).not.toHaveBeenCalled();
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

describe("GET /projects/[id]/tree — root bound (ISS-5307)", () => {
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
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      mockTree as any
    );
  });

  async function getTree(query: string) {
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree${query}`,
    });
    return await GET(request, createMockRouteContext({ id: PROJECT_ID }));
  }

  it("leaves the read unbounded when no limit is supplied", async () => {
    const response = await getTree("");

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: undefined })
    );
  });

  it("passes a supplied bound through to the service", async () => {
    const response = await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=25`);

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: 25 })
    );
  });

  it("passes the bound through on the details variant too", async () => {
    const response = await getTree(
      `?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_LIMIT_PARAM}=10`
    );

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTreeWithDetails).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: 10 })
    );
  });

  it("clamps a bound above the ceiling instead of rejecting it", async () => {
    const response = await getTree(
      `?${PROJECT_TREE_LIMIT_PARAM}=${PROJECT_TREE_MAX_ROOT_LIMIT + 1000}`
    );

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: PROJECT_TREE_MAX_ROOT_LIMIT })
    );
  });

  it("floors a zero or negative bound at one root, never an empty page", async () => {
    await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=0`);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: 1 })
    );

    vi.mocked(projectTreeService.getProjectTree).mockClear();
    await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=-5`);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ limit: 1 })
    );
  });

  it("rejects a non-numeric bound rather than silently reading unbounded", async () => {
    const response = await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=all`);

    // Answering the whole project to a client that asked to be bounded would
    // leave that client's footer describing a bound the server never applied.
    expect(response.status).toBe(400);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("rejects an empty bound rather than coercing it to zero", async () => {
    const response = await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=`);

    expect(response.status).toBe(400);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("rejects a fractional bound", async () => {
    const response = await getTree(`?${PROJECT_TREE_LIMIT_PARAM}=12.5`);

    expect(response.status).toBe(400);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });
});
