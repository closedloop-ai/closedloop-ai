import {
  CommentTargetType,
  TRACE_COMMENT_CREATE_MAX_DURATION_SECONDS,
  TRACE_COMMENT_ID_MAX_LENGTH,
  type TraceComment,
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
import { GET as sessionByClientIdGet } from "../agent-sessions/[id]/trace-comments/by-client-id/[clientId]/route";
import {
  GET as sessionCollectionGet,
  maxDuration as sessionCollectionMaxDuration,
} from "../agent-sessions/[id]/trace-comments/route";
import { GET as branchByClientIdGet } from "../branches/[id]/trace-comments/by-client-id/[clientId]/route";
import { maxDuration as branchCollectionMaxDuration } from "../branches/[id]/trace-comments/route";
import { traceCommentsService } from "./service";

/**
 * ISS-11113: `GET .../trace-comments/by-client-id/{clientId}` is the collection
 * read narrowed to one create's `clientId`, on both target routes. Route-level
 * only — the narrowing itself is proven against the service in
 * `service.by-client-id.test.ts`.
 */

const SESSION_ID = "session-1";
const BRANCH_ID = "branch-1";
const CLIENT_ID = "local-4f1c";
const found = [{ id: "comment-1" } as TraceComment];

beforeEach(() => {
  mockAuthContext = createTestAuthContext();
});

describe("GET by-client-id (ISS-11113)", () => {
  it("hands the Session route's clientId to the list and answers what it found", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue(found);

    const response = await sessionByClientIdGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments/by-client-id/${CLIENT_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID, clientId: CLIENT_ID })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: [{ id: "comment-1" }],
    });
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: CommentTargetType.Session, id: SESSION_ID },
        clientId: CLIENT_ID,
      })
    );
  });

  it("hands the Branch route's clientId to the list", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);

    const response = await branchByClientIdGet(
      createMockRequest({
        url: `http://localhost:3002/api/branches/${BRANCH_ID}/trace-comments/by-client-id/${CLIENT_ID}`,
      }),
      createMockRouteContext({ id: BRANCH_ID, clientId: CLIENT_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: CommentTargetType.Branch, id: BRANCH_ID },
        clientId: CLIENT_ID,
      })
    );
  });

  it("maps a missing target to 404 with the route's envelope", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue(null);

    const response = await sessionByClientIdGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments/by-client-id/${CLIENT_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID, clientId: CLIENT_ID })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it("leaves the collection route's list un-narrowed", async () => {
    vi.mocked(traceCommentsService.list).mockResolvedValue([]);

    const response = await sessionCollectionGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(traceCommentsService.list).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(traceCommentsService.list).mock.calls[0]?.[0]
    ).not.toHaveProperty("clientId");
  });

  it("answers 400 for a clientId no create could have carried, before the list runs", async () => {
    const tooLong = "x".repeat(TRACE_COMMENT_ID_MAX_LENGTH + 1);

    const response = await sessionByClientIdGet(
      createMockRequest({
        url: `http://localhost:3002/api/agent-sessions/${SESSION_ID}/trace-comments/by-client-id/${tooLong}`,
      }),
      createMockRouteContext({ id: SESSION_ID, clientId: tooLong })
    );

    expect(response.status).toBe(400);
    expect(traceCommentsService.list).not.toHaveBeenCalled();
  });
});

describe("the create route's ceiling (ISS-11113)", () => {
  // The desktop waits this long before it believes a create never landed, so
  // the routes that run creates must declare exactly it.
  it("both collection routes declare the shared create ceiling", () => {
    expect(sessionCollectionMaxDuration).toBe(
      TRACE_COMMENT_CREATE_MAX_DURATION_SECONDS
    );
    expect(branchCollectionMaxDuration).toBe(
      TRACE_COMMENT_CREATE_MAX_DURATION_SECONDS
    );
  });
});
