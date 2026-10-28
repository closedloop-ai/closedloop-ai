import {
  CommentSurface,
  CommentTargetType,
  TRACE_COMMENT_INCLUDE_THREAD_PARAM,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("./service", () => ({
  traceCommentsService: { list: vi.fn() },
}));

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";
import { GET as sessionCollectionGet } from "../agent-sessions/[id]/trace-comments/route";
import { GET as branchCollectionGet } from "../branches/[id]/trace-comments/route";
import { traceCommentsService } from "./service";

/**
 * ISS-11004: an Activity link names one thread, and the collection GET returns
 * it even past the thread cap. Route-level only — the read itself is proven
 * against the service in `service.by-client-id.test.ts`.
 */

const SESSION_ID = "session-1";
const BRANCH_ID = "branch-1";
const THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

beforeEach(() => {
  mockAuthContext = createTestAuthContext();
});

describe("GET trace comments with an addressed thread (ISS-11004)", () => {
  it("hands the Session route's addressed thread to the list", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);

    const response = await sessionCollectionGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments?${TRACE_COMMENT_INCLUDE_THREAD_PARAM}=${THREAD_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: CommentTargetType.Session, id: SESSION_ID },
        includeThreadId: THREAD_ID,
      })
    );
  });

  it("accepts the addressed thread beside the Branch route's surface", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);

    const response = await branchCollectionGet(
      createMockRequest({
        url: `http://localhost:3002/api/branches/${BRANCH_ID}/trace-comments?surface=${CommentSurface.BranchTimeline}&${TRACE_COMMENT_INCLUDE_THREAD_PARAM}=${THREAD_ID}`,
      }),
      createMockRouteContext({ id: BRANCH_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: CommentTargetType.Branch, id: BRANCH_ID },
        surface: CommentSurface.BranchTimeline,
        includeThreadId: THREAD_ID,
      })
    );
  });

  it("answers 400 for an addressed thread that is not a thread id, before the list runs", async () => {
    const response = await sessionCollectionGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments?${TRACE_COMMENT_INCLUDE_THREAD_PARAM}=not-a-thread`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(400);
    expect(traceCommentsService.list).not.toHaveBeenCalled();
  });
});
