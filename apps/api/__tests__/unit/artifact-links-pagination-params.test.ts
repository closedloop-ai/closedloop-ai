/**
 * Which route accepts `paginated` / `cursor`, at the route layer.
 *
 * `/artifact-links` and `/artifact-links/resolved` shared ONE query validator
 * until #7368. Only the resolved route pages, so the raw route would have
 * accepted `?paginated=true&cursor=1000`, let Zod strip both, and answer 200
 * with the entire unbounded match set as a bare array — which a caller that
 * asked for a page reads as page one of an envelope it never received (#7368
 * review, whitlockk). The split is only real if the raw route REFUSES them, so that
 * refusal is pinned here rather than inferred from two schema objects existing.
 *
 * The resolved route's own half is the cursor's page alignment: every cursor it
 * emits is a whole number of `ARTIFACT_LINK_PAGE_SIZE` pages, so an arbitrary
 * offset is one a caller invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        { user: { id: "user-1", organizationId: "org-1" } },
        request,
        context.params
      ),
}));

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
    findLinkTree: vi.fn(),
    findLinksByDirection: vi.fn(),
    findResolvedLinksPage: vi.fn(),
    findResolvedLinkTreePage: vi.fn(),
  },
}));

import { GET as GET_RESOLVED } from "@/app/artifact-links/resolved/route";
import { ARTIFACT_LINK_PAGE_SIZE } from "@/app/artifact-links/resolved-page";
// Imports after mocks
import { GET as GET_RAW } from "@/app/artifact-links/route";
import { artifactLinksService } from "@/app/artifact-links/service";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

const ARTIFACT_UUID = "11111111-1111-1111-1111-111111111111";

function rawRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/artifact-links?${query}`,
  });
}

function resolvedRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/artifact-links/resolved?${query}`,
  });
}

describe("pagination params are accepted only where they page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveArtifactIdentifier).mockResolvedValue(ARTIFACT_UUID);
    vi.mocked(artifactLinksService.findLinksByDirection).mockResolvedValue([]);
    vi.mocked(artifactLinksService.findLinkTree).mockResolvedValue([]);
    vi.mocked(artifactLinksService.findResolvedLinksPage).mockResolvedValue({
      items: [],
    });
  });

  it("GET /artifact-links rejects paginated rather than answering unbounded", async () => {
    const response = await GET_RAW(
      rawRequest(`artifactId=${ARTIFACT_UUID}&paginated=true`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findLinksByDirection).not.toHaveBeenCalled();
  });

  it("GET /artifact-links rejects cursor rather than answering unbounded", async () => {
    const response = await GET_RAW(
      rawRequest(
        `artifactId=${ARTIFACT_UUID}&cursor=${ARTIFACT_LINK_PAGE_SIZE}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findLinksByDirection).not.toHaveBeenCalled();
  });

  it("GET /artifact-links still serves a read that sends neither", async () => {
    const response = await GET_RAW(
      rawRequest(`artifactId=${ARTIFACT_UUID}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(artifactLinksService.findLinksByDirection).toHaveBeenCalledTimes(1);
  });

  it("GET /artifact-links/resolved rejects a cursor it could not have emitted", async () => {
    const response = await GET_RESOLVED(
      resolvedRequest(`artifactId=${ARTIFACT_UUID}&paginated=true&cursor=7`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
  });

  it("GET /artifact-links/resolved accepts a page-aligned cursor", async () => {
    const response = await GET_RESOLVED(
      resolvedRequest(
        `artifactId=${ARTIFACT_UUID}&paginated=true&cursor=${ARTIFACT_LINK_PAGE_SIZE * 2}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(artifactLinksService.findResolvedLinksPage).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed snapshot identities", async () => {
    const response = await GET_RESOLVED(
      resolvedRequest(
        `artifactId=${ARTIFACT_UUID}&mode=tree&cursor=1000&snapshotId=bad`
      ),
      createMockRouteContext({})
    );
    expect(response.status).toBe(400);
  });

  it.each(["", "&mode=direct"])(
    "rejects snapshot identities for direct reads (%s)",
    async (mode) => {
      const response = await GET_RESOLVED(
        resolvedRequest(
          `artifactId=${ARTIFACT_UUID}${mode}&cursor=1000&snapshotId=00000000-0000-4000-8000-000000000001`
        ),
        createMockRouteContext({})
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "snapshotId is only supported in tree mode"
      );
      expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
      expect(
        artifactLinksService.findResolvedLinkTreePage
      ).not.toHaveBeenCalled();
    }
  );
});
