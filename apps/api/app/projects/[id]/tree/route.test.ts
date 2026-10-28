import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/projects/service", () => ({
  projectsService: { findById: vi.fn() },
}));
vi.mock("@/app/artifacts/project-tree-service", () => ({
  projectTreeService: {
    getProjectTreeResult: vi.fn(),
    getProjectTreeWithDetailsResult: vi.fn(),
  },
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { ProjectTreeCategory } from "@repo/api/src/types/project-tree";
import { log } from "@repo/observability/log";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { ProjectHierarchyReadErrorCode } from "@/app/artifacts/project-tree-service/hierarchy-projection";
import { projectsService } from "@/app/projects/service";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";
import { GET } from "./route";

const projectId = "11111111-1111-7111-8111-111111111111";
const parentId = "22222222-2222-7222-8222-222222222222";
const getTree = vi.mocked(projectTreeService.getProjectTreeResult);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  vi.mocked(log.flush).mockResolvedValue(undefined);
  vi.mocked(projectsService.findById).mockResolvedValue({
    id: projectId,
  } as never);
  getTree.mockResolvedValue({
    ok: true,
    value: { externalParents: [], nodes: [] },
  });
});

describe("GET /projects/[id]/tree hierarchy options", () => {
  it("passes every response-shaping child-page option to the service", async () => {
    const response = await GET(
      request(`?hierarchy=true&parentArtifactId=${parentId}&childLimit=25`),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(200);
    expect(getTree).toHaveBeenCalledWith(
      projectId,
      mockAuthContext.user.organizationId,
      expect.objectContaining({
        childLimit: 25,
        hierarchy: true,
        parentArtifactId: parentId,
      })
    );
  });

  it("passes the distinct root cursor only on hierarchy root reads", async () => {
    const response = await GET(
      request("?hierarchy=true&rootCursor=opaque-root"),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(200);
    expect(getTree).toHaveBeenCalledWith(
      projectId,
      mockAuthContext.user.organizationId,
      expect.objectContaining({ hierarchy: true, rootCursor: "opaque-root" })
    );
  });

  it("passes category filters through hierarchy root reads", async () => {
    const response = await GET(
      request("?hierarchy=true&category=prds&limit=1"),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(200);
    expect(getTree).toHaveBeenCalledWith(
      projectId,
      mockAuthContext.user.organizationId,
      expect.objectContaining({
        category: ProjectTreeCategory.Prds,
        hierarchy: true,
        limit: 1,
      })
    );
  });

  it.each([
    "?childLimit=5",
    `?parentArtifactId=${parentId}`,
    `?hierarchy=true&parentArtifactId=${parentId}&limit=5`,
    `?hierarchy=true&parentArtifactId=${parentId}&category=prds`,
    `?hierarchy=true&contributorUserId=${parentId}`,
    "?rootCursor=opaque-root",
    `?hierarchy=true&parentArtifactId=${parentId}&rootCursor=opaque-root`,
  ])("rejects unsupported hierarchy query %s", async (query) => {
    const response = await GET(
      request(query),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(400);
    expect(getTree).not.toHaveBeenCalled();
  });

  it("returns not found for an unavailable or cross-project parent", async () => {
    getTree.mockResolvedValue({
      error: { code: ProjectHierarchyReadErrorCode.ParentUnavailable },
      ok: false,
    });
    const response = await GET(
      request(`?hierarchy=true&parentArtifactId=${parentId}`),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(404);
  });

  it("returns the current revision when a keyset cursor is stale", async () => {
    getTree.mockResolvedValue({
      error: {
        code: ProjectHierarchyReadErrorCode.StaleCursor,
        version: "revision-8",
      },
      ok: false,
    });
    const response = await GET(
      request(`?hierarchy=true&parentArtifactId=${parentId}&childCursor=stale`),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      details: { version: "revision-8" },
    });
  });

  it("returns 404 without reading the tree when the project is unavailable", async () => {
    vi.mocked(projectsService.findById).mockResolvedValue(null);
    const response = await GET(
      request("?hierarchy=true"),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(404);
    expect(getTree).not.toHaveBeenCalled();
  });

  it("maps unexpected read failures to 500", async () => {
    getTree.mockRejectedValue(new Error("read failed"));
    const response = await GET(
      request("?hierarchy=true"),
      createMockRouteContext({ id: projectId })
    );
    expect(response.status).toBe(500);
  });
});

function request(query: string) {
  return createMockRequest({
    method: "GET",
    url: `http://localhost:3002/api/projects/${projectId}/tree${query}`,
  });
}
