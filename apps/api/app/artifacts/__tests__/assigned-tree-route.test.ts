import { ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM } from "@repo/api/src/types/project-tree";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-7222-8222-222222222222",
    organizationId: "11111111-1111-7111-8111-111111111111",
  },
  getAssignedArtifactTree: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("../assigned-artifact-tree-service", () => ({
  assignedArtifactTreeService: {
    getAssignedArtifactTree: mocks.getAssignedArtifactTree,
  },
}));

import { GET } from "../assigned-tree/route";

const ASSIGNEE_ID = "33333333-3333-7333-8333-333333333333";
const OTHER_ORGANIZATION_ID = "99999999-9999-7999-8999-999999999999";

function request(query: string) {
  return new NextRequest(
    `https://api.example.test/artifacts/assigned-tree?${query}`
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /artifacts/assigned-tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the merged tree for the requested assignee in one request", async () => {
    const tree = {
      nodes: [
        {
          root: { id: "root-1", name: "PRD" },
          children: [{ id: "child-1", depth: 1, parentId: "root-1" }],
        },
      ],
      externalParents: [],
    };
    mocks.getAssignedArtifactTree.mockResolvedValue(tree);

    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(tree);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId
    );
  });

  it("scopes to the authenticated caller's organization, never a caller-supplied one", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&organizationId=${OTHER_ORGANIZATION_ID}`
      ),
      routeContext()
    );

    // The unsupported `organizationId` param is rejected outright rather than
    // accepted and quietly dropped.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects an unsupported filter param instead of silently ignoring it", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&updatedSince=2026-01-01`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a missing assigneeId", async () => {
    const response = await GET(request(""), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid assigneeId", async () => {
    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=not-a-uuid`),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("returns a 500 envelope when the service throws", async () => {
    mocks.getAssignedArtifactTree.mockRejectedValue(new Error("boom"));

    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`),
      routeContext()
    );

    expect(response.status).toBe(500);
  });
});
