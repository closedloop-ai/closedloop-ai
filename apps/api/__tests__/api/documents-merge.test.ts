import { DocumentType } from "@repo/api/src/types/document";
import { Result, Status } from "@repo/api/src/types/result";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDocument } from "@/__tests__/support/documents/document.test-fixtures";
import { toWireJson } from "@/__tests__/support/wire-json.test-helpers";
import { POST } from "@/app/documents/merge/route";
import { documentMergeService } from "@/app/documents/merge-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const SAME_PROJECT_REGEX = /same project/i;
const TEMPLATE_REGEX = /TEMPLATE/i;

let mockAuthContext: AuthContext = {
  user: {
    ...createTestAuthContext().user,
    id: "test-user",
    organizationId: "test-org",
  },
  clerkUserId: "clerk_test",
  clerkOrgId: "org_test",
  authMethod: "session",
  apiKeyScopes: undefined,
};

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/documents/merge-service");
vi.mock("@repo/ai/server", () => ({
  generateText: vi.fn(),
  models: { sonnet: "mock-model" },
}));

describe("POST /api/artifacts/merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-123",
        organizationId: "org-123",
      },
    });
  });

  it("returns 200 with merged artifact on same-type merge success", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = makeDocument({
      id: primaryId,
      title: "Merged PRD",
      type: DocumentType.Prd,
    });

    vi.mocked(documentMergeService.merge).mockResolvedValue(
      Result.ok(mockArtifact)
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(toWireJson(mockArtifact));
  });

  it("calls merge with correct args for cross-type merge", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = makeDocument({
      id: primaryId,
      title: "Merged Artifact",
      type: DocumentType.Prd,
    });

    vi.mocked(documentMergeService.merge).mockResolvedValue(
      Result.ok(mockArtifact)
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(documentMergeService.merge).toHaveBeenCalledWith(
      primaryId,
      secondaryId,
      "org-123",
      "user-123"
    );
  });

  it("returns 404 when artifact is not found", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(documentMergeService.merge).mockResolvedValue(
      Result.err(Status.NotFound)
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when artifacts are from different projects", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(documentMergeService.merge).mockRejectedValue(
      new Error("Artifacts must be in the same project")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(SAME_PROJECT_REGEX);
  });

  it("returns 400 when primaryDocumentId and secondaryDocumentId are the same", async () => {
    const sameId = uuidv7();

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: sameId,
        secondaryDocumentId: sameId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    // merge should not have been called — validation rejected it
    expect(documentMergeService.merge).not.toHaveBeenCalled();
  });

  it("returns 400 when a TEMPLATE artifact is involved in the merge", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(documentMergeService.merge).mockRejectedValue(
      new Error("Cannot merge TEMPLATE artifacts")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(TEMPLATE_REGEX);
  });

  it("returns 500 when LLM returns empty content", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();

    vi.mocked(documentMergeService.merge).mockRejectedValue(
      new Error("LLM returned empty merged content")
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    const response = await POST(request, routeContext);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("passes user organizationId to service for org-scoping", async () => {
    const primaryId = uuidv7();
    const secondaryId = uuidv7();
    const mockArtifact = makeDocument({
      id: primaryId,
      title: "Merged",
      type: DocumentType.Prd,
    });

    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-abc",
        organizationId: "specific-org-id",
      },
    });

    vi.mocked(documentMergeService.merge).mockResolvedValue(
      Result.ok(mockArtifact)
    );

    const request = createMockRequest({
      method: "POST",
      body: {
        primaryDocumentId: primaryId,
        secondaryDocumentId: secondaryId,
      },
    });
    const routeContext = createMockRouteContext({});
    await POST(request, routeContext);

    expect(documentMergeService.merge).toHaveBeenCalledWith(
      primaryId,
      secondaryId,
      "specific-org-id",
      "user-abc"
    );
  });
});
