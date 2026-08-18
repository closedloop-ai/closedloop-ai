import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  getAgentSessionViewerScope: vi.fn(),
  isOrgSessionSyncPolicyEnabled: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reply: vi.fn(),
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

vi.mock("@/lib/org-session-sync-policy", () => ({
  isOrgSessionSyncPolicyEnabled: mocks.isOrgSessionSyncPolicyEnabled,
}));

vi.mock("./service", () => ({
  traceCommentsService: {
    create: mocks.create,
    update: mocks.update,
    reply: mocks.reply,
  },
}));

import {
  createTraceCommentsPatchHandler,
  createTraceCommentsPostHandler,
  createTraceCommentsReplyPostHandler,
} from "./route-handlers";

const BASE_URL =
  "https://api.example.test/agent-sessions/session-1/trace-comments";

const VALID_ANCHOR = {
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "hello",
  sourceText: "hello world",
  startOffset: 0,
  endOffset: 5,
};

function postRequest() {
  return new NextRequest(BASE_URL, {
    method: "POST",
    body: JSON.stringify({ anchor: VALID_ANCHOR, body: "hello" }),
    headers: { "content-type": "application/json" },
  });
}

function patchRequest() {
  return new NextRequest(`${BASE_URL}/comment-1`, {
    method: "PATCH",
    body: JSON.stringify({ body: "edited" }),
    headers: { "content-type": "application/json" },
  });
}

function replyRequest() {
  return new NextRequest(`${BASE_URL}/comment-1/replies`, {
    method: "POST",
    body: JSON.stringify({ body: "reply" }),
    headers: { "content-type": "application/json" },
  });
}

function sessionContext() {
  return {
    params: Promise.resolve({ id: "session-1", commentId: "comment-1" }),
  };
}

describe("trace-comment mutations gated by the org session-sync policy (ISS-4563)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Viewer monitoring is on by default so the sync-policy gate is the branch
    // under test, not the pre-existing access gate.
    mocks.getAgentSessionViewerScope.mockResolvedValue({
      monitoringEnabled: true,
    });
    mocks.create.mockResolvedValue({ id: "comment-1", body: "hello" });
    mocks.update.mockResolvedValue({ ok: true, value: { id: "comment-1" } });
    mocks.reply.mockResolvedValue({ ok: true, value: { id: "reply-1" } });
  });

  it("blocks a Session-targeted create when the org policy is OFF and never persists", async () => {
    mocks.isOrgSessionSyncPolicyEnabled.mockResolvedValue(false);
    const handler = createTraceCommentsPostHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(postRequest(), sessionContext());

    expect(response.status).toBe(403);
    expect(mocks.isOrgSessionSyncPolicyEnabled).toHaveBeenCalledWith(
      mocks.user.organizationId
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("allows a Session-targeted create when the org policy is ON", async () => {
    mocks.isOrgSessionSyncPolicyEnabled.mockResolvedValue(true);
    const handler = createTraceCommentsPostHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(postRequest(), sessionContext());

    expect(response.status).toBe(200);
    expect(mocks.isOrgSessionSyncPolicyEnabled).toHaveBeenCalledWith(
      mocks.user.organizationId
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("bypasses the sync policy for Branch-targeted creates (branch data is not session-sync)", async () => {
    // Would fail if consulted; the Branch bypass must short-circuit first.
    mocks.isOrgSessionSyncPolicyEnabled.mockResolvedValue(false);
    const handler = createTraceCommentsPostHandler(
      TraceCommentTargetType.Branch
    );

    const response = await handler(postRequest(), sessionContext());

    expect(response.status).toBe(200);
    expect(mocks.isOrgSessionSyncPolicyEnabled).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("blocks a Session-targeted update when the org policy is OFF", async () => {
    mocks.isOrgSessionSyncPolicyEnabled.mockResolvedValue(false);
    const handler = createTraceCommentsPatchHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(patchRequest(), sessionContext());

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("blocks a Session-targeted reply when the org policy is OFF", async () => {
    mocks.isOrgSessionSyncPolicyEnabled.mockResolvedValue(false);
    const handler = createTraceCommentsReplyPostHandler(
      TraceCommentTargetType.Session
    );

    const response = await handler(replyRequest(), sessionContext());

    expect(response.status).toBe(403);
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});
