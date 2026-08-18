import type { TraceCommentListResponse } from "@repo/api/src/types/comment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  getAgentSessionViewerScope: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        { user: mocks.user, clerkUserId: mocks.clerkUserId },
        request,
        context.params
      ),
}));

vi.mock("@/app/agent-sessions/route-helpers", () => ({
  getAgentSessionViewerScope: mocks.getAgentSessionViewerScope,
}));

vi.mock("./service", () => ({
  traceCommentsService: {
    listAll: mocks.listAll,
  },
}));

import { createTraceCommentsAggregateGetHandler } from "./route-handlers";

const emptyResponse: TraceCommentListResponse = {
  items: [],
  total: 0,
  nextCursor: null,
};

function request(query = "") {
  return new NextRequest(`https://api.example.test/trace-comments${query}`);
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("createTraceCommentsAggregateGetHandler (GET /trace-comments)", () => {
  const handler = createTraceCommentsAggregateGetHandler();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: true,
    });
    mocks.listAll.mockResolvedValue(emptyResponse);
  });

  it("is forbidden when viewer monitoring is disabled", async () => {
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: false,
    });

    const response = await handler(request(), routeContext());

    expect(response.status).toBe(403);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });

  it("is still forbidden for a session-only query when monitoring is disabled", async () => {
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: false,
    });

    const response = await handler(
      request("?targetType=session"),
      routeContext()
    );

    expect(response.status).toBe(403);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });

  it("bypasses the monitoring gate for a branch-only query", async () => {
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: false,
    });

    const response = await handler(
      request("?targetType=branch"),
      routeContext()
    );

    expect(response.status).toBe(200);
    // Branch-only never consults session-monitoring, matching the per-branch read.
    expect(mocks.getAgentSessionViewerScope).not.toHaveBeenCalled();
    expect(mocks.listAll).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      filters: { targetType: "branch" },
    });
  });

  it("org-scopes the aggregate query to the caller's organization", async () => {
    const response = await handler(request("?resolved=false"), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.listAll).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      filters: { resolved: false },
    });
  });

  it("passes through targetType, author, session, and pagination filters", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const authorId = "22222222-2222-4222-8222-222222222222";
    await handler(
      request(
        `?targetType=session&authorId=${authorId}&sessionId=${sessionId}&limit=10&cursor=20`
      ),
      routeContext()
    );

    expect(mocks.listAll).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      filters: {
        targetType: "session",
        authorId,
        sessionId,
        limit: 10,
        cursor: 20,
      },
    });
  });

  it("returns the paginated payload from the service", async () => {
    const payload: TraceCommentListResponse = {
      items: [{ id: "comment-1" } as TraceCommentListResponse["items"][number]],
      total: 4,
      nextCursor: "1",
    };
    mocks.listAll.mockResolvedValue(payload);

    const response = await handler(request("?resolved=false"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: payload,
    });
  });

  it("rejects an invalid filter value with 400 before hitting the service", async () => {
    const response = await handler(request("?resolved=maybe"), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });
});
