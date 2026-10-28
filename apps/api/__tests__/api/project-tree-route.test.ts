import {
  type Artifact,
  ArtifactSubtype,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import {
  PROJECT_TREE_CATEGORY_PARAM,
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_HIERARCHY_REVISION_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  ProjectTreeCategory,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
} from "@repo/api/src/types/project-tree";
import { TagColor } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toWireJson } from "@/__tests__/support/wire-json.test-helpers";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { GET } from "@/app/projects/[id]/tree/route";
import { projectHierarchyCompatibilityService } from "@/app/projects/project-hierarchy-compatibility-service";
import { projectsService } from "@/app/projects/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockIsManualArtifactOrderingEnabled = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/artifacts/project-tree-service");
vi.mock("@/app/projects/project-hierarchy-compatibility-service");
vi.mock("@/app/projects/service");
vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  isManualArtifactOrderingEnabled: mockIsManualArtifactOrderingEnabled,
}));

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const CONTRIBUTOR_USER_ID = "22222222-2222-7222-8222-222222222222";

const mockTree: ProjectTreeDetailsResponse = {
  nodes: [],
  externalParents: [],
};

function bridgeProjectTreeResultMocks() {
  vi.mocked(projectTreeService.getProjectTreeResult).mockImplementation(
    async (...args) => ({
      ok: true,
      value: await projectTreeService.getProjectTree(...args),
    })
  );
  vi.mocked(
    projectTreeService.getProjectTreeWithDetailsResult
  ).mockImplementation(async (...args) => ({
    ok: true,
    value: await projectTreeService.getProjectTreeWithDetails(...args),
  }));
}

describe("GET /projects/[id]/tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsManualArtifactOrderingEnabled.mockResolvedValue(false);
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, organizationId: "test-org-id" },
    });
    vi.mocked(projectsService.findById).mockResolvedValue(
      makeProject({ id: PROJECT_ID })
    );
    vi.mocked(projectTreeService.getProjectTree).mockResolvedValue(mockTree);
    bridgeProjectTreeResultMocks();
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
      expect.objectContaining({ contributorUserId: undefined })
    );
    expect(projectTreeService.getProjectTreeWithDetails).not.toHaveBeenCalled();
  });

  it("returns the opt-in hierarchy revision beside the ordinary tree version", async () => {
    const transaction = vi
      .spyOn(withDb, "tx")
      .mockImplementation(async (run) => run({} as never));
    try {
      vi.mocked(projectTreeService.getProjectTree).mockResolvedValue({
        ...mockTree,
        projectVersion: "document-version",
      });
      vi.mocked(
        projectHierarchyCompatibilityService.getRevision
      ).mockResolvedValue({
        projectId: PROJECT_ID,
        revision: "rendered-hierarchy-version",
      });
      const request = createMockRequest({
        url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_HIERARCHY_REVISION_PARAM}=true`,
      });
      const response = await GET(
        request,
        createMockRouteContext({ id: PROJECT_ID })
      );
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        projectVersion: "document-version",
        hierarchyRevision: "rendered-hierarchy-version",
      });
      expect(
        projectHierarchyCompatibilityService.getRevision
      ).toHaveBeenCalledWith(
        PROJECT_ID,
        "test-org-id",
        expect.objectContaining({ userId: mockAuthContext.user.id }),
        "current"
      );
    } finally {
      transaction.mockRestore();
    }
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
      expect.objectContaining({ contributorUserId: CONTRIBUTOR_USER_ID })
    );
    expect(projectTreeService.getProjectTreeWithDetails).not.toHaveBeenCalled();
  });

  it("enables ranked tree output only for viewers in the rollout", async () => {
    mockIsManualArtifactOrderingEnabled.mockResolvedValue(true);
    vi.mocked(
      projectTreeService.getManuallyOrderedProjectTree
    ).mockResolvedValue(mockTree);
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree`,
    });

    const response = await GET(
      request,
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    expect(
      projectTreeService.getManuallyOrderedProjectTree
    ).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ contributorUserId: undefined })
    );
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });
  it("returns the detail-enriched tree with ?include=details", async () => {
    const detailedTree: ProjectTreeDetailsResponse = {
      nodes: [
        {
          root: {
            ...makeArtifact({ id: "doc-1" }),
            tags: [{ id: "t1", name: "infra", color: TagColor.Red }],
          },
          children: [],
        },
      ],
      externalParents: [],
    };
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      detailedTree
    );

    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}`,
    });
    const routeContext = createMockRouteContext({ id: PROJECT_ID });
    const response = await GET(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual(toWireJson(detailedTree));
    expect(projectTreeService.getProjectTreeWithDetails).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ contributorUserId: undefined })
    );
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });

  it("passes a contributor user filter to the detail-enriched tree service", async () => {
    const detailedTree: ProjectTreeDetailsResponse = {
      nodes: [],
      externalParents: [],
    };
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      detailedTree
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
      expect.objectContaining({ contributorUserId: CONTRIBUTOR_USER_ID })
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
    mockIsManualArtifactOrderingEnabled.mockResolvedValue(false);
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, organizationId: "test-org-id" },
    });
    vi.mocked(projectsService.findById).mockResolvedValue(
      makeProject({ id: PROJECT_ID })
    );
    vi.mocked(projectTreeService.getProjectTree).mockResolvedValue(mockTree);
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      mockTree
    );
    bridgeProjectTreeResultMocks();
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

describe("GET /projects/[id]/tree — category filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsManualArtifactOrderingEnabled.mockResolvedValue(false);
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, organizationId: "test-org-id" },
    });
    vi.mocked(projectsService.findById).mockResolvedValue(
      makeProject({ id: PROJECT_ID })
    );
    vi.mocked(projectTreeService.getProjectTree).mockResolvedValue(mockTree);
    vi.mocked(projectTreeService.getProjectTreeWithDetails).mockResolvedValue(
      mockTree
    );
    bridgeProjectTreeResultMocks();
  });

  async function getTree(query: string) {
    const request = createMockRequest({
      url: `http://localhost:3002/api/projects/${PROJECT_ID}/tree${query}`,
    });
    return await GET(request, createMockRouteContext({ id: PROJECT_ID }));
  }

  it("passes a supplied category through to the service", async () => {
    const response = await getTree(
      `?${PROJECT_TREE_CATEGORY_PARAM}=${ProjectTreeCategory.Prds}`
    );

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ category: ProjectTreeCategory.Prds })
    );
  });

  it("passes the category through on the details variant too", async () => {
    const response = await getTree(
      `?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_CATEGORY_PARAM}=${ProjectTreeCategory.Branches}`
    );

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTreeWithDetails).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ category: ProjectTreeCategory.Branches })
    );
  });

  it("leaves the read unfiltered when no category is supplied", async () => {
    const response = await getTree("");

    expect(response.status).toBe(200);
    expect(projectTreeService.getProjectTree).toHaveBeenCalledWith(
      PROJECT_ID,
      "test-org-id",
      expect.objectContaining({ category: undefined })
    );
  });

  it("rejects an unknown category rather than silently reading unfiltered", async () => {
    const response = await getTree(`?${PROJECT_TREE_CATEGORY_PARAM}=sessions`);

    // Answering the whole project to a client that asked for one category
    // would leave that client paging and counting a population its tab does
    // not render — the exact defect the parameter exists to fix.
    expect(response.status).toBe(400);
    expect(projectTreeService.getProjectTree).not.toHaveBeenCalled();
  });
});

function makeProject(
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  return {
    id: "project-1",
    organizationId: "test-org-id",
    name: "Test Project",
    description: null,
    priority: Priority.Medium,
    status: ProjectStatus.InProgress,
    assigneeId: null,
    createdById: "test-user-id",
    slug: null,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    completionPercentage: 0,
    teams: [],
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    organizationId: "test-org-id",
    projectId: PROJECT_ID,
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Artifact",
    slug: null,
    status: DocumentStatus.Draft,
    priority: null,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    createdById: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
