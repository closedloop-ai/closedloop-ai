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
  resolveArtifactId: vi.fn(),
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    createAndPersistArtifactThread: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { POST } from "@/app/artifacts/[id]/threads/route";
import { artifactsService } from "@/app/artifacts/service";
import { commentsService } from "@/app/comments/service";
import { resolveArtifactId } from "@/lib/identifier-utils";
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
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createAndPersistArtifactThread).mockResolvedValue(
      { threadId: "th_123", commentId: "cm_456" }
    );

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { threadId: "th_123", commentId: "cm_456" },
    });

    expect(commentsService.createAndPersistArtifactThread).toHaveBeenCalledWith(
      "org-1",
      "PRD-7",
      "user-1",
      "Hello"
    );
  });

  it("returns 404 when resolveArtifactId returns null", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue(null);

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("forwards error status code from service", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    const lbError = Object.assign(new Error("Room not found"), { status: 404 });
    vi.mocked(commentsService.createAndPersistArtifactThread).mockRejectedValue(
      lbError
    );

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("defaults to 500 when error has no status code", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createAndPersistArtifactThread).mockRejectedValue(
      new Error("Unknown error")
    );

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());

    expect(response.status).toBe(500);
  });

  it("ignores userId in request body and always uses authenticated user.id", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(commentsService.createAndPersistArtifactThread).mockResolvedValue(
      { threadId: "th_123", commentId: "cm_456" }
    );

    await POST(
      makeRequest({ body: "Hello", userId: "attacker-id" }),
      makeParams()
    );

    expect(commentsService.createAndPersistArtifactThread).toHaveBeenCalledWith(
      "org-1",
      "PRD-7",
      "user-1",
      "Hello"
    );
  });
});
