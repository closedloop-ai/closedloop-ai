/**
 * Route dispatch tests for GET /artifact-links/resolved.
 *
 * Why this file exists
 * --------------------
 * The route multiplexes two service methods by `?mode=`:
 *   - `mode=direct` (default) → artifactLinksService.findResolvedLinks
 *   - `mode=tree`             → artifactLinksService.findResolvedLinkTree
 *
 * In the artifact refactor (PR #920), the `tree` branch regressed: the
 * handler fell through to `findResolvedLinks`, so consumers like
 * BranchesSection, PreviewSection and the MCP `list-artifact-links` tool
 * lost transitive traversal (feature → plan → PR → deployment). The bug
 * shipped because there were no route-level dispatch tests — only service
 * unit tests, which both methods passed in isolation.
 *
 * These tests pin the dispatch contract at the route layer: each query
 * param value routes to the right service method with the right arguments.
 */

import { LinkDirection, LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: any, context: any) =>
    handler(
      { user: { id: "user-1", organizationId: "org-1" } },
      request,
      context.params
    ),
}));

// Partial mock: override resolveArtifactIdentifier but keep uuidOrSlug et al.,
// which the shared validators import at module load.
vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return {
    ...actual,
    resolveArtifactIdentifier: vi.fn(),
  };
});

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    findResolvedLinks: vi.fn(),
    findResolvedLinkTree: vi.fn(),
  },
}));

// Imports after mocks
import { GET } from "@/app/artifact-links/resolved/route";
import { artifactLinksService } from "@/app/artifact-links/service";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

const ARTIFACT_UUID = "11111111-1111-1111-1111-111111111111";
const ORG_ID = "org-1";

function makeRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/artifact-links/resolved?${query}`,
  });
}

describe("GET /artifact-links/resolved — mode dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveArtifactIdentifier).mockResolvedValue(ARTIFACT_UUID);
    vi.mocked(artifactLinksService.findResolvedLinks).mockResolvedValue([]);
    vi.mocked(artifactLinksService.findResolvedLinkTree).mockResolvedValue([]);
  });

  it("dispatches to findResolvedLinks when mode is omitted (default=direct)", async () => {
    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(artifactLinksService.findResolvedLinks).toHaveBeenCalledTimes(1);
    expect(artifactLinksService.findResolvedLinkTree).not.toHaveBeenCalled();
    expect(artifactLinksService.findResolvedLinks).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Both, // default from validator
      undefined
    );
  });

  it("dispatches to findResolvedLinks when mode=direct", async () => {
    await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=direct`),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinks).toHaveBeenCalledTimes(1);
    expect(artifactLinksService.findResolvedLinkTree).not.toHaveBeenCalled();
  });

  it("dispatches to findResolvedLinkTree when mode=tree", async () => {
    await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinkTree).toHaveBeenCalledTimes(1);
    expect(artifactLinksService.findResolvedLinks).not.toHaveBeenCalled();
    // Tree mode receives the extra `maxDepth` argument (default=10 per validator).
    expect(artifactLinksService.findResolvedLinkTree).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Both,
      10,
      undefined
    );
  });

  it("forwards direction and linkType query params in tree mode", async () => {
    await GET(
      makeRequest(
        `artifactId=${ARTIFACT_UUID}&mode=tree&direction=${LinkDirection.Source}&linkType=${LinkType.Produces}&maxDepth=3`
      ),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinkTree).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Source,
      3,
      LinkType.Produces
    );
  });

  it("forwards direction and linkType query params in direct mode", async () => {
    await GET(
      makeRequest(
        `artifactId=${ARTIFACT_UUID}&mode=direct&direction=${LinkDirection.Target}&linkType=${LinkType.Produces}`
      ),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinks).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Target,
      LinkType.Produces
    );
  });

  it("returns 400 when mode is an unknown value", async () => {
    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=bogus`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinks).not.toHaveBeenCalled();
    expect(artifactLinksService.findResolvedLinkTree).not.toHaveBeenCalled();
  });

  it("returns 400 when artifactId is missing", async () => {
    const response = await GET(makeRequest(""), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinks).not.toHaveBeenCalled();
    expect(artifactLinksService.findResolvedLinkTree).not.toHaveBeenCalled();
  });

  it("returns 404 when the artifact cannot be resolved", async () => {
    vi.mocked(resolveArtifactIdentifier).mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    expect(artifactLinksService.findResolvedLinks).not.toHaveBeenCalled();
    expect(artifactLinksService.findResolvedLinkTree).not.toHaveBeenCalled();
  });
});
