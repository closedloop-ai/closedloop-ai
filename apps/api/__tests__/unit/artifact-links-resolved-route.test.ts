/**
 * Route dispatch tests for GET /artifact-links/resolved.
 *
 * Why this file exists
 * --------------------
 * The route multiplexes two service methods by `?mode=`:
 *   - `mode=direct` (default) → artifactLinksService.findResolvedLinksPage
 *   - `mode=tree`             → artifactLinksService.findResolvedLinkTreePage
 *
 * In the artifact refactor (PR #920), the `tree` branch regressed: the
 * handler fell through to `findResolvedLinksPage`, so consumers like
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
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        { user: { id: "user-1", clerkId: "clerk-1", organizationId: "org-1" } },
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
    findResolvedLinksPage: vi.fn(),
    findResolvedLinkTreePage: vi.fn(),
  },
}));

import { ARTIFACT_LINK_CONTINUATION_HEADERS } from "@repo/api/src/types/artifact";
// Imports after mocks
import { GET } from "@/app/artifact-links/resolved/route";
import {
  ARTIFACT_LINK_PAGE_SIZE,
  windowForCursor,
} from "@/app/artifact-links/resolved-page";
import { artifactLinksService } from "@/app/artifact-links/service";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

const ARTIFACT_UUID = "11111111-1111-1111-1111-111111111111";
const ORG_ID = "org-1";
const FIRST_PAGE_WINDOW = windowForCursor();

function makeRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/artifact-links/resolved?${query}`,
  });
}

describe("GET /artifact-links/resolved — mode dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveArtifactIdentifier).mockResolvedValue(ARTIFACT_UUID);
    vi.mocked(artifactLinksService.findResolvedLinksPage).mockResolvedValue({
      items: [],
    });
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [],
    });
  });

  it("dispatches to findResolvedLinksPage when mode is omitted (default=direct)", async () => {
    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(artifactLinksService.findResolvedLinksPage).toHaveBeenCalledTimes(1);
    expect(
      artifactLinksService.findResolvedLinkTreePage
    ).not.toHaveBeenCalled();
    expect(artifactLinksService.findResolvedLinksPage).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Both, // default from validator
      FIRST_PAGE_WINDOW,
      undefined
    );
  });

  it("dispatches to findResolvedLinksPage when mode=direct", async () => {
    await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=direct`),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinksPage).toHaveBeenCalledTimes(1);
    expect(
      artifactLinksService.findResolvedLinkTreePage
    ).not.toHaveBeenCalled();
  });

  it("dispatches to findResolvedLinkTreePage when mode=tree", async () => {
    await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    expect(artifactLinksService.findResolvedLinkTreePage).toHaveBeenCalledTimes(
      1
    );
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
    // Tree mode receives the extra `maxDepth` argument (default=10 per validator).
    expect(artifactLinksService.findResolvedLinkTreePage).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Both,
      10,
      FIRST_PAGE_WINDOW,
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

    expect(artifactLinksService.findResolvedLinkTreePage).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Source,
      3,
      FIRST_PAGE_WINDOW,
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

    expect(artifactLinksService.findResolvedLinksPage).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Target,
      FIRST_PAGE_WINDOW,
      LinkType.Produces
    );
  });

  it("returns 400 when mode is an unknown value", async () => {
    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=bogus`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
    expect(
      artifactLinksService.findResolvedLinkTreePage
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when artifactId is missing", async () => {
    const response = await GET(makeRequest(""), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
    expect(
      artifactLinksService.findResolvedLinkTreePage
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the artifact cannot be resolved", async () => {
    vi.mocked(resolveArtifactIdentifier).mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
    expect(
      artifactLinksService.findResolvedLinkTreePage
    ).not.toHaveBeenCalled();
  });
});

/**
 * ISS-10102. The response BODY is what crosses the deploy boundary, so these
 * assert the serialized payload rather than the value handed to
 * `successResponse` — an in-process object with an `undefined` property and one
 * without it are the same object, and only `JSON.stringify` tells them apart.
 */
describe("GET /artifact-links/resolved — pagination contract (ISS-10102)", () => {
  const LINK = {
    id: "link-1",
    organizationId: ORG_ID,
    sourceId: ARTIFACT_UUID,
    targetId: "artifact-2",
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    source: { id: ARTIFACT_UUID },
    target: { id: "artifact-2" },
  } as unknown as Awaited<
    ReturnType<typeof artifactLinksService.findResolvedLinkTreePage>
  >["items"][number];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveArtifactIdentifier).mockResolvedValue(ARTIFACT_UUID);
  });

  async function readBody(query: string): Promise<{
    success: boolean;
    data: unknown;
  }> {
    const response = await GET(makeRequest(query), createMockRouteContext({}));
    return await response.json();
  }

  /**
   * The arm an external `sk_live_*` client lands on. `withAnyAuth` admits API
   * keys as well as Clerk sessions, so this caller reaches the route without
   * ever learning about `paginated` — and the bound would otherwise remove its
   * ability to tell a complete lineage from one capped at
   * ARTIFACT_LINK_PAGE_SIZE. Asserted on the real `Response` headers, since that
   * is where the claim has to survive.
   */
  it("states continuation in headers on the bare-array arm when more links exist", async () => {
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [LINK],
      nextCursor: "1000",
    });

    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    expect(
      response.headers.get(ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore)
    ).toBe("true");
    expect(
      response.headers.get(ARTIFACT_LINK_CONTINUATION_HEADERS.NextCursor)
    ).toBe("1000");
    // The body is still the array it always was — the whole point of putting
    // the continuation in headers rather than wrapping it.
    expect(Array.isArray((await response.json()).data)).toBe(true);
  });

  it("states has-more FALSE rather than staying silent when the page is the last", async () => {
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [LINK],
    });

    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&mode=tree`),
      createMockRouteContext({})
    );

    // A positive "false" and not an absent header: absence is also what an
    // older api build and a header-stripping proxy look like, so silence could
    // not be read as completeness.
    expect(
      response.headers.get(ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore)
    ).toBe("false");
    expect(
      response.headers.get(ARTIFACT_LINK_CONTINUATION_HEADERS.NextCursor)
    ).toBeNull();
  });

  it("answers a client that never asks to page with the bare array it always got", async () => {
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [LINK],
      nextCursor: "1000",
    });

    const body = await readBody(`artifactId=${ARTIFACT_UUID}&mode=tree`);

    // The whole version-skew guarantee: an already-installed Desktop build or
    // an external REST client `.map`s this directly, so a page it did not ask
    // for must not arrive as an object it cannot index.
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.success).toBe(true);
  });

  it("returns the envelope with nextCursor when paginated=true", async () => {
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [LINK],
      nextCursor: "1000",
    });

    const body = await readBody(
      `artifactId=${ARTIFACT_UUID}&mode=tree&paginated=true`
    );

    expect(body.data).toMatchObject({ nextCursor: "1000" });
    expect((body.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it("OMITS nextCursor from the serialized last page rather than nulling it", async () => {
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [LINK],
    });

    const body = await readBody(
      `artifactId=${ARTIFACT_UUID}&mode=tree&paginated=true`
    );

    // `in` on the PARSED WIRE object, not `toBeUndefined()`: a `null` would pass
    // a truthiness check while putting a key on the wire that the cross-repo
    // contract says is absent.
    expect("nextCursor" in (body.data as object)).toBe(false);
  });

  it("forwards the cursor and snapshot identity", async () => {
    const snapshotId = "00000000-0000-4000-8000-000000000001";
    vi.mocked(artifactLinksService.findResolvedLinkTreePage).mockResolvedValue({
      items: [],
    });

    await readBody(
      `artifactId=${ARTIFACT_UUID}&mode=tree&paginated=true&cursor=${ARTIFACT_LINK_PAGE_SIZE}&snapshotId=${snapshotId}`
    );

    expect(artifactLinksService.findResolvedLinkTreePage).toHaveBeenCalledWith(
      ORG_ID,
      ARTIFACT_UUID,
      LinkDirection.Both,
      10,
      windowForCursor(ARTIFACT_LINK_PAGE_SIZE, snapshotId),
      undefined
    );
  });

  it("rejects a malformed cursor rather than silently restarting at page one", async () => {
    const response = await GET(
      makeRequest(`artifactId=${ARTIFACT_UUID}&paginated=true&cursor=nonsense`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.findResolvedLinksPage).not.toHaveBeenCalled();
  });

  it("pages direct mode on the same params as tree mode", async () => {
    vi.mocked(artifactLinksService.findResolvedLinksPage).mockResolvedValue({
      items: [LINK],
      nextCursor: "1000",
    });

    const body = await readBody(
      `artifactId=${ARTIFACT_UUID}&paginated=true&cursor=0`
    );

    expect(body.data).toMatchObject({ nextCursor: "1000" });
  });
});
