import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  getAgentSessionViewerScope: vi.fn(),
  list: vi.fn(),
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
    list: mocks.list,
  },
}));

import { createTraceCommentsGetHandler } from "./route-handlers";

function request() {
  return new NextRequest(
    "https://api.example.test/agent-sessions/session-1/trace-comments"
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: "target-1" }) };
}

describe("traceCommentAccessError (via trace-comment route handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
  });

  it("Branch access always passes without consulting the viewer scope", async () => {
    const handler = createTraceCommentsGetHandler(
      TraceCommentTargetType.Branch
    );

    const response = await handler(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.getAgentSessionViewerScope).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("Session access passes when viewer monitoring is enabled", async () => {
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: true,
    });
    const handler = createTraceCommentsGetHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.getAgentSessionViewerScope).toHaveBeenCalledWith({
      userId: mocks.user.id,
      clerkUserId: mocks.clerkUserId,
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("Session access is forbidden when viewer monitoring is disabled", async () => {
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: false,
    });
    const handler = createTraceCommentsGetHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(request(), routeContext());

    expect(response.status).toBe(403);
    expect(mocks.getAgentSessionViewerScope).toHaveBeenCalledWith({
      userId: mocks.user.id,
      clerkUserId: mocks.clerkUserId,
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
