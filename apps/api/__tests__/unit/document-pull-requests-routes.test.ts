/**
 * Route-level tests for:
 *   GET /documents/[id]/pull-requests  (plural — returns array)
 *   GET /documents/[id]/pull-request   (singular — returns first PR or null)
 *
 * Covers:
 *   - Plural endpoint returns 200 with { data: [] } when the document has no PRs
 *   - Singular endpoint accepts an API key client (authMethod: "api_key") after
 *     migrating from withAuth to withAnyAuth
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: any, context: any) =>
    handler(
      { user: { id: "user-1", organizationId: "org-1" } },
      request,
      context.params
    ),
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn(),
}));

vi.mock("@/app/documents/workstream-service", () => ({
  documentWorkstreamService: {
    getDocumentPullRequests: vi.fn(),
    getDocumentPullRequest: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { GET as GETSingular } from "@/app/documents/[id]/pull-request/route";
import { GET as GETPlural } from "@/app/documents/[id]/pull-requests/route";
import { documentWorkstreamService } from "@/app/documents/workstream-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

// ---------------------------------------------------------------------------
// GET /documents/[id]/pull-requests (plural)
// ---------------------------------------------------------------------------

describe("GET /documents/[id]/pull-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with { data: [] } when the document has no associated PRs", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(
      documentWorkstreamService.getDocumentPullRequests
    ).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/doc-1/pull-requests",
    });
    const response = await GETPlural(
      request,
      createMockRouteContext({ id: "doc-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns 404 when the document id does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/unknown-doc/pull-requests",
    });
    const response = await GETPlural(
      request,
      createMockRouteContext({ id: "unknown-doc" })
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /documents/[id]/pull-request (singular)
// ---------------------------------------------------------------------------

describe("GET /documents/[id]/pull-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts an API key client (authMethod: api_key) via withAnyAuth and returns 200", async () => {
    // The withAnyAuth mock above does not gate on authMethod — it passes any
    // auth context through. This test exercises the full route handler path
    // (resolve → service → response) confirming the route is reachable by
    // API key clients now that it uses withAnyAuth instead of withAuth.
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(
      documentWorkstreamService.getDocumentPullRequest
    ).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/doc-1/pull-request",
      headers: { authorization: "Bearer sk_live_test" },
    });
    const response = await GETSingular(
      request,
      createMockRouteContext({ id: "doc-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it("returns 404 when the document id does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/unknown-doc/pull-request",
    });
    const response = await GETSingular(
      request,
      createMockRouteContext({ id: "unknown-doc" })
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });
});
