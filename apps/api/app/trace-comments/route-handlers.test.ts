import {
  type TraceComment,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("./service", () => ({
  traceCommentsService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    reply: vi.fn(),
    delete: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";
import {
  createTraceCommentsDeleteHandler,
  createTraceCommentsPatchHandler,
  createTraceCommentsReplyPostHandler,
  getComputeTargetId,
} from "./route-handlers";
import { traceCommentsService } from "./service";

const BRANCH_ID = "branch-1";
const COMMENT_ID = "comment-1";

const sampleComment = { id: COMMENT_ID } as TraceComment;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

// Access gating (traceCommentAccessError) is covered in route-handlers.access.test.ts.

describe("getComputeTargetId", () => {
  const requestFor = (query: string): Request =>
    new Request(`https://example.com/branches/branch-1/trace-comments${query}`);

  it("returns null when the param is absent", () => {
    expect(getComputeTargetId(requestFor(""))).toBeNull();
  });

  it("returns null when the param is an empty string", () => {
    expect(getComputeTargetId(requestFor("?computeTargetId="))).toBeNull();
  });

  it("returns null when the param is only whitespace (min(1) after trim)", () => {
    expect(
      getComputeTargetId(requestFor("?computeTargetId=%20%20"))
    ).toBeNull();
  });

  it("returns the trimmed value for a valid non-empty string", () => {
    expect(getComputeTargetId(requestFor("?computeTargetId=ct-123"))).toBe(
      "ct-123"
    );
    expect(
      getComputeTargetId(requestFor("?computeTargetId=%20ct-123%20"))
    ).toBe("ct-123");
  });
});

describe("PATCH handler error-status mapping", () => {
  // Branch target keeps access open so the test isolates result-status mapping.
  const handler = createTraceCommentsPatchHandler(
    TraceCommentTargetType.Branch
  );

  function invokePatch() {
    return handler(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/comment-1",
        method: "PATCH",
        body: { body: "edited" },
      }),
      createMockRouteContext({ id: BRANCH_ID, commentId: COMMENT_ID })
    );
  }

  it("maps a forbidden result to 403", async () => {
    vi.mocked(traceCommentsService.update).mockResolvedValue({
      ok: false,
      reason: "forbidden",
    });
    expect((await invokePatch()).status).toBe(403);
  });

  it("maps a not_found result to 404", async () => {
    vi.mocked(traceCommentsService.update).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    expect((await invokePatch()).status).toBe(404);
  });

  it("returns 200 with the updated comment on success", async () => {
    vi.mocked(traceCommentsService.update).mockResolvedValue({
      ok: true,
      value: sampleComment,
    });
    expect((await invokePatch()).status).toBe(200);
  });
});

describe("reply POST handler error-status mapping", () => {
  const handler = createTraceCommentsReplyPostHandler(
    TraceCommentTargetType.Branch
  );

  function invokeReply() {
    return handler(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/comment-1/replies",
        method: "POST",
        body: { body: "a reply" },
      }),
      createMockRouteContext({ id: BRANCH_ID, commentId: COMMENT_ID })
    );
  }

  it("maps a forbidden result to 403", async () => {
    vi.mocked(traceCommentsService.reply).mockResolvedValue({
      ok: false,
      reason: "forbidden",
    });
    expect((await invokeReply()).status).toBe(403);
  });

  it("maps a not_found result to 404", async () => {
    vi.mocked(traceCommentsService.reply).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    expect((await invokeReply()).status).toBe(404);
  });

  it("returns 200 with the created reply on success", async () => {
    vi.mocked(traceCommentsService.reply).mockResolvedValue({
      ok: true,
      value: sampleComment,
    });
    expect((await invokeReply()).status).toBe(200);
  });
});

describe("DELETE handler error-status mapping", () => {
  const handler = createTraceCommentsDeleteHandler(
    TraceCommentTargetType.Branch
  );

  function invokeDelete() {
    return handler(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/comment-1",
        method: "DELETE",
      }),
      createMockRouteContext({ id: BRANCH_ID, commentId: COMMENT_ID })
    );
  }

  it("maps a forbidden result to 403", async () => {
    vi.mocked(traceCommentsService.delete).mockResolvedValue({
      ok: false,
      reason: "forbidden",
    });
    expect((await invokeDelete()).status).toBe(403);
  });

  it("maps a not_found result to 404", async () => {
    vi.mocked(traceCommentsService.delete).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    expect((await invokeDelete()).status).toBe(404);
  });

  it("returns 200 with the delete result on success", async () => {
    vi.mocked(traceCommentsService.delete).mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    expect((await invokeDelete()).status).toBe(200);
  });
});
