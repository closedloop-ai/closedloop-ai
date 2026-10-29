import {
  CommentSurface,
  CommentTargetType,
  type TraceComment,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
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
  createTraceCommentsGetHandler,
  createTraceCommentsPatchHandler,
  createTraceCommentsPostHandler,
  createTraceCommentsReplyPostHandler,
  getComputeTargetId,
} from "./route-handlers";
import { traceCommentsService } from "./service";

const BRANCH_ID = "branch-1";
const COMMENT_ID = "0199d0f8-1d4a-7c3e-9b2a-5f6e7d8c9b0c";

const sampleComment = { id: COMMENT_ID } as TraceComment;
const traceAnchor = {
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "selected",
  sourceText: "selected text",
  startOffset: 0,
  endOffset: 8,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

describe("Branch collection surface", () => {
  const getHandler = createTraceCommentsGetHandler(CommentTargetType.Branch);
  const postHandler = createTraceCommentsPostHandler(CommentTargetType.Branch);

  it("defaults an omitted Branch surface to Branch detail", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);
    const response = await getHandler(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments",
      }),
      createMockRouteContext({ id: BRANCH_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({ surface: undefined })
    );
  });

  it("passes Branch timeline to exact reads and creates", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);
    vi.mocked(traceCommentsService.create).mockResolvedValue(sampleComment);
    const query = `surface=${CommentSurface.BranchTimeline}`;
    const getResponse = await getHandler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments?${query}`,
      }),
      createMockRouteContext({ id: BRANCH_ID })
    );
    const postResponse = await postHandler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments?${query}`,
        method: "POST",
        body: { anchor: traceAnchor, body: "Timeline note" },
      }),
      createMockRouteContext({ id: BRANCH_ID })
    );

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({ surface: CommentSurface.BranchTimeline })
    );
    expect(traceCommentsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ surface: CommentSurface.BranchTimeline }),
      undefined
    );
  });

  it("rejects a Session surface on the Branch collection", async () => {
    const response = await getHandler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments?surface=${CommentSurface.SessionDetail}`,
      }),
      createMockRouteContext({ id: BRANCH_ID })
    );

    expect(response.status).toBe(400);
    expect(traceCommentsService.list).not.toHaveBeenCalled();
  });
});

describe("Branch mutation surface", () => {
  const patchHandler = createTraceCommentsPatchHandler(
    CommentTargetType.Branch
  );
  const replyHandler = createTraceCommentsReplyPostHandler(
    CommentTargetType.Branch
  );
  const deleteHandler = createTraceCommentsDeleteHandler(
    CommentTargetType.Branch
  );

  it("passes Branch timeline to update, reply, and delete", async () => {
    vi.mocked(traceCommentsService.update).mockResolvedValue({
      ok: true,
      value: sampleComment,
    });
    vi.mocked(traceCommentsService.reply).mockResolvedValue({
      ok: true,
      value: sampleComment,
    });
    vi.mocked(traceCommentsService.delete).mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    const query = `surface=${CommentSurface.BranchTimeline}`;
    const context = createMockRouteContext({
      id: BRANCH_ID,
      commentId: COMMENT_ID,
    });

    await patchHandler(
      createMockRequest({
        url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}?${query}`,
        method: "PATCH",
        body: { body: "edited" },
      }),
      context
    );
    await replyHandler(
      createMockRequest({
        url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}/replies?${query}`,
        method: "POST",
        body: { body: "reply" },
      }),
      context
    );
    await deleteHandler(
      createMockRequest({
        url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}?${query}`,
        method: "DELETE",
      }),
      context
    );

    const expected = expect.objectContaining({
      surface: CommentSurface.BranchTimeline,
    });
    expect(traceCommentsService.update).toHaveBeenCalledWith(
      expected,
      undefined
    );
    expect(traceCommentsService.reply).toHaveBeenCalledWith(
      expected,
      undefined
    );
    expect(traceCommentsService.delete).toHaveBeenCalledWith(
      expected,
      undefined
    );
  });

  it("rejects invalid Branch mutation surfaces before service calls", async () => {
    const query = `surface=${CommentSurface.SessionDetail}`;
    const context = createMockRouteContext({
      id: BRANCH_ID,
      commentId: COMMENT_ID,
    });
    const responses = await Promise.all([
      patchHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}?${query}`,
          method: "PATCH",
          body: { body: "edited" },
        }),
        context
      ),
      replyHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}/replies?${query}`,
          method: "POST",
          body: { body: "reply" },
        }),
        context
      ),
      deleteHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}?${query}`,
          method: "DELETE",
        }),
        context
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
    expect(traceCommentsService.update).not.toHaveBeenCalled();
    expect(traceCommentsService.reply).not.toHaveBeenCalled();
    expect(traceCommentsService.delete).not.toHaveBeenCalled();
  });

  // ISS-11190: the non-UUID commentId 404 must not outrank the surface 400.
  it("rejects an invalid surface before a malformed commentId", async () => {
    const query = `surface=${CommentSurface.SessionDetail}`;
    const context = createMockRouteContext({ id: BRANCH_ID, commentId: "x" });
    const responses = await Promise.all([
      patchHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/x?${query}`,
          method: "PATCH",
          body: { body: "edited" },
        }),
        context
      ),
      replyHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/x/replies?${query}`,
          method: "POST",
          body: { body: "reply" },
        }),
        context
      ),
      deleteHandler(
        createMockRequest({
          url: `http://localhost/branches/${BRANCH_ID}/trace-comments/x?${query}`,
          method: "DELETE",
        }),
        context
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
    expect(traceCommentsService.update).not.toHaveBeenCalled();
    expect(traceCommentsService.reply).not.toHaveBeenCalled();
    expect(traceCommentsService.delete).not.toHaveBeenCalled();
  });
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
  const handler = createTraceCommentsPatchHandler(CommentTargetType.Branch);

  function invokePatch() {
    return handler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments/${COMMENT_ID}`,
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
  const handler = createTraceCommentsReplyPostHandler(CommentTargetType.Branch);

  function invokeReply() {
    return handler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments/${COMMENT_ID}/replies`,
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
  const handler = createTraceCommentsDeleteHandler(CommentTargetType.Branch);

  function invokeDelete() {
    return handler(
      createMockRequest({
        url: `http://localhost:3002/api/branches/branch-1/trace-comments/${COMMENT_ID}`,
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

// ISS-11190: `comment.id` is `@db.Uuid`, and Postgres raises on a non-UUID
// there, so a malformed path segment reached the service and answered 500.
describe("a non-UUID commentId answers 404 before the service runs", () => {
  const malformedContext = () =>
    createMockRouteContext({ id: BRANCH_ID, commentId: "x" });

  it("PATCH", async () => {
    const response = await createTraceCommentsPatchHandler(
      CommentTargetType.Branch
    )(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/x",
        method: "PATCH",
        body: { body: "edited" },
      }),
      malformedContext()
    );

    expect(response.status).toBe(404);
    expect(traceCommentsService.update).not.toHaveBeenCalled();
  });

  it("reply POST", async () => {
    const response = await createTraceCommentsReplyPostHandler(
      CommentTargetType.Branch
    )(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/x/replies",
        method: "POST",
        body: { body: "a reply" },
      }),
      malformedContext()
    );

    expect(response.status).toBe(404);
    expect(traceCommentsService.reply).not.toHaveBeenCalled();
  });

  it("DELETE", async () => {
    const response = await createTraceCommentsDeleteHandler(
      CommentTargetType.Branch
    )(
      createMockRequest({
        url: "http://localhost:3002/api/branches/branch-1/trace-comments/x",
        method: "DELETE",
      }),
      malformedContext()
    );

    expect(response.status).toBe(404);
    expect(traceCommentsService.delete).not.toHaveBeenCalled();
  });
});

// ISS-11449 retired the org session-sync policy, which used to gate every
// Session-targeted mutation on this route (create / update / reply) ahead of
// everything else. These two cases are what survived
// `route-handlers.sync-policy.test.ts`: a Session mutation now reaches the
// service with nothing in front of it, and the ISS-11190 malformed-commentId 404
// that the gate used to outrank is now the first answer a Session PATCH gives.
describe("a Session-targeted mutation has no gate in front of it", () => {
  const SESSION_ID = "session-1";

  it("POST reaches the service and answers 200", async () => {
    vi.mocked(traceCommentsService.create).mockResolvedValue(sampleComment);

    const response = await createTraceCommentsPostHandler(
      CommentTargetType.Session
    )(
      createMockRequest({
        url: "http://localhost:3002/api/agent-sessions/session-1/trace-comments",
        method: "POST",
        body: { anchor: traceAnchor, body: "hello" },
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.create).toHaveBeenCalledTimes(1);
  });

  it("PATCH answers 404 for a malformed commentId, never a 403", async () => {
    const response = await createTraceCommentsPatchHandler(
      CommentTargetType.Session
    )(
      createMockRequest({
        url: "http://localhost:3002/api/agent-sessions/session-1/trace-comments/x",
        method: "PATCH",
        body: { body: "edited" },
      }),
      createMockRouteContext({ id: SESSION_ID, commentId: "x" })
    );

    expect(response.status).toBe(404);
    expect(traceCommentsService.update).not.toHaveBeenCalled();
  });
});
