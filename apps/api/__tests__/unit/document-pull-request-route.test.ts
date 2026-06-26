/**
 * Route-level tests for GET /documents/[id]/pull-request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentPullRequests: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { GET as GETSingular } from "@/app/documents/[id]/pull-request/route";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { buildPullRequestInfo } from "../fixtures/pull-request-info";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

describe("GET /documents/[id]/pull-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with { data: [] } when the document has no associated PRs", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(
      documentPullRequestService.getDocumentPullRequests
    ).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/doc-1/pull-request",
    });
    const response = await GETSingular(
      request,
      createMockRouteContext({ id: "doc-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
    expect(resolveDocumentId).toHaveBeenCalledWith("doc-1", "org-1");
    expect(
      documentPullRequestService.getDocumentPullRequests
    ).toHaveBeenCalledWith("artifact-uuid", "org-1");
  });

  it("returns linked PRs as an array", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(
      documentPullRequestService.getDocumentPullRequests
    ).mockResolvedValue([
      buildPullRequestInfo({
        id: "pr-art-1",
        number: 42,
        title: "Implement multi-repo plan",
        htmlUrl: "https://github.com/acme/app/pull/42",
        headBranch: "feature/multi-repo-plan",
        baseBranch: "main",
        createdAt: new Date("2026-04-30T12:00:00.000Z"),
        externalLinkId: "pr-art-1",
        repoFullName: "acme/app",
      }),
    ]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/doc-1/pull-request",
    });
    const response = await GETSingular(
      request,
      createMockRouteContext({ id: "doc-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "pr-art-1",
        number: 42,
        repoFullName: "acme/app",
      }),
    ]);
    expect(resolveDocumentId).toHaveBeenCalledWith("doc-1", "org-1");
    expect(
      documentPullRequestService.getDocumentPullRequests
    ).toHaveBeenCalledWith("artifact-uuid", "org-1");
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
    expect(resolveDocumentId).toHaveBeenCalledWith("unknown-doc", "org-1");
    expect(
      documentPullRequestService.getDocumentPullRequests
    ).not.toHaveBeenCalled();
  });
});
