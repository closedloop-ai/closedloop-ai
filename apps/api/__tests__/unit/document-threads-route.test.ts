import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

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

vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    createDocumentThread: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { commentsService } from "@/app/comments/service";
import { POST } from "@/app/documents/[id]/threads/route";
import { documentService } from "@/app/documents/document-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/artifacts/PRD-7/threads",
    method: "POST",
    body,
  });
}

function makeParams(id = "PRD-7") {
  return createMockRouteContext({ id });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /artifacts/:id/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates thread and returns threadId/commentId on valid request", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createDocumentThread).mockResolvedValue({
      threadId: "th_123",
      commentId: "cm_456",
    });

    const response = await POST(
      makeRequest({ body: "Hello", anchorText: "Summary" }),
      makeParams()
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { threadId: "th_123", commentId: "cm_456" },
    });

    expect(commentsService.createDocumentThread).toHaveBeenCalledWith(
      "org-1",
      "PRD-7",
      "user-1",
      "Hello",
      "Summary"
    );
  });

  it("returns 404 when resolveDocumentId returns null", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await POST(
      makeRequest({ body: "Hello", anchorText: "Summary" }),
      makeParams()
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("forwards error status code from service", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    const lbError = Object.assign(new Error("Room not found"), { status: 404 });
    vi.mocked(commentsService.createDocumentThread).mockRejectedValue(lbError);

    const response = await POST(
      makeRequest({ body: "Hello", anchorText: "Summary" }),
      makeParams()
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("defaults to 500 when error has no status code", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createDocumentThread).mockRejectedValue(
      new Error("Unknown error")
    );

    const response = await POST(
      makeRequest({ body: "Hello", anchorText: "Summary" }),
      makeParams()
    );

    expect(response.status).toBe(500);
  });

  it("ignores userId in request body and always uses authenticated user.id", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createDocumentThread).mockResolvedValue({
      threadId: "th_123",
      commentId: "cm_456",
    });

    await POST(
      makeRequest({
        body: "Hello",
        anchorText: "Summary",
        userId: "attacker-id",
      }),
      makeParams()
    );

    expect(commentsService.createDocumentThread).toHaveBeenCalledWith(
      "org-1",
      "PRD-7",
      "user-1",
      "Hello",
      "Summary"
    );
  });

  it("returns 400 when anchorText is missing from request body", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it("returns 400 when service throws anchor-not-found error", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
    vi.mocked(documentService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createDocumentThread).mockRejectedValue({
      message: "Anchor text not found in document",
      status: 400,
    });

    const response = await POST(
      makeRequest({ body: "Hello", anchorText: "nonexistent" }),
      makeParams()
    );

    expect(response.status).toBe(400);
  });
});
