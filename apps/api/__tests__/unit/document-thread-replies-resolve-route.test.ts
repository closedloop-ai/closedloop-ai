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
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    replyToDocumentThread: vi.fn(),
    resolveDocumentThread: vi.fn(),
    reopenDocumentThreadAsAuthor: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { ThreadStatus } from "@repo/api/src/types/comment";
import { Status } from "@repo/api/src/types/result";
import { commentsService } from "@/app/comments/service";
import { POST as REPLY_POST } from "@/app/documents/[id]/threads/[threadId]/replies/route";
import { POST as RESOLVE_POST } from "@/app/documents/[id]/threads/[threadId]/resolve/route";
import { POST as UNRESOLVE_POST } from "@/app/documents/[id]/threads/[threadId]/unresolve/route";
import { documentService } from "@/app/documents/document-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

function replyRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/documents/PRD-7/threads/th_1/replies",
    method: "POST",
    body,
  });
}

function emptyRequest() {
  return createMockRequest({
    url: "http://localhost:3002/documents/PRD-7/threads/th_1/resolve",
    method: "POST",
  });
}

function makeParams(id = "PRD-7", threadId = "th_1") {
  return createMockRouteContext({ id, threadId });
}

function stubResolvableArtifact() {
  vi.mocked(resolveDocumentId).mockResolvedValue("artifact-uuid");
  vi.mocked(documentService.findByIdSimple).mockResolvedValue({
    slug: "PRD-7",
  } as never);
}

describe("POST /documents/:id/threads/:threadId/replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a reply for anyone with view access and returns threadId/commentId", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.replyToDocumentThread).mockResolvedValue({
      ok: true,
      value: { threadId: "th_1", commentId: "cm_reply" },
    });

    const response = await REPLY_POST(
      replyRequest({ body: "A reply" }),
      makeParams()
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { threadId: "th_1", commentId: "cm_reply" },
    });
    expect(commentsService.replyToDocumentThread).toHaveBeenCalledWith(
      "org-1",
      "artifact-uuid",
      "th_1",
      "user-1",
      "A reply"
    );
  });

  it("returns 404 when the document does not resolve in the caller's org", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await REPLY_POST(
      replyRequest({ body: "A reply" }),
      makeParams()
    );

    expect(response.status).toBe(404);
    expect(commentsService.replyToDocumentThread).not.toHaveBeenCalled();
  });

  it("returns 404 when the thread is not on this document (cross-doc/cross-org)", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.replyToDocumentThread).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await REPLY_POST(
      replyRequest({ body: "A reply" }),
      makeParams()
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 on an empty body without calling the service", async () => {
    stubResolvableArtifact();

    const response = await REPLY_POST(replyRequest({ body: "" }), makeParams());

    expect(response.status).toBe(400);
    expect(commentsService.replyToDocumentThread).not.toHaveBeenCalled();
  });
});

describe("POST /documents/:id/threads/:threadId/resolve (participant-resolve)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves when the service permits the caller (author or participant)", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.resolveDocumentThread).mockResolvedValue({
      ok: true,
      value: { status: ThreadStatus.Resolved },
    });

    const response = await RESOLVE_POST(emptyRequest(), makeParams());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { status: ThreadStatus.Resolved },
    });
    expect(commentsService.resolveDocumentThread).toHaveBeenCalledWith(
      "org-1",
      "artifact-uuid",
      "th_1",
      "user-1",
      expect.any(Date)
    );
  });

  it("returns 403 when the service forbids the caller (non-participant)", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.resolveDocumentThread).mockResolvedValue({
      ok: false,
      error: Status.Forbidden,
    });

    const response = await RESOLVE_POST(emptyRequest(), makeParams());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.success).toBe(false);
  });

  it("returns 404 when the thread is not on this document", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.resolveDocumentThread).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await RESOLVE_POST(emptyRequest(), makeParams());

    expect(response.status).toBe(404);
  });
});

describe("POST /documents/:id/threads/:threadId/unresolve (author-only reopen)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reopens when the caller is the thread author", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.reopenDocumentThreadAsAuthor).mockResolvedValue({
      ok: true,
      value: { status: ThreadStatus.Open },
    });

    const response = await UNRESOLVE_POST(emptyRequest(), makeParams());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { status: ThreadStatus.Open },
    });
    expect(commentsService.reopenDocumentThreadAsAuthor).toHaveBeenCalledWith(
      "org-1",
      "artifact-uuid",
      "th_1",
      "user-1"
    );
  });

  it("returns 403 when a non-author tries to reopen", async () => {
    stubResolvableArtifact();
    vi.mocked(commentsService.reopenDocumentThreadAsAuthor).mockResolvedValue({
      ok: false,
      error: Status.Forbidden,
    });

    const response = await UNRESOLVE_POST(emptyRequest(), makeParams());

    expect(response.status).toBe(403);
  });
});
