/**
 * ISS-10382: the HTTP layer of the trace-comment dead-letter lifecycle.
 *
 * Its own file because it is the only place the four new routes' URL→VERB and
 * URL→TARGET bindings exist — driven through their own `POST` exports, so
 * wiring one route to the wrong factory or the wrong target type is a RED here. `service.sync-abandoned.test.ts` calls the service methods directly and
 * the e2e spec intercepts the URL before Next routes it, so without these cases
 * inverting the ternary in `createTraceCommentSyncStateHandler` — making the
 * author's recovery door DEAD-LETTER their own comment — leaves the whole suite
 * green.
 */
import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  retrySync: vi.fn(),
  markSyncAbandoned: vi.fn(),
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

// DISTINCT spies, which is the whole point: a shared spy could not tell which
// verb the route reached.
vi.mock("./service", () => ({
  traceCommentsService: {
    retrySync: mocks.retrySync,
    markSyncAbandoned: mocks.markSyncAbandoned,
  },
}));

import { POST as sessionRetryPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/retry-sync/route";
import { POST as sessionAbandonPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { POST as branchRetryPost } from "@/app/branches/[id]/trace-comments/[commentId]/retry-sync/route";
import { POST as branchAbandonPost } from "@/app/branches/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { createTraceCommentsRetrySyncPostHandler } from "./route-handlers";

const BASE_URL =
  "https://api.example.test/agent-sessions/session-1/trace-comments";
const COMMENT_ID = "0199d0f8-1d4a-7c3e-9b2a-5f6e7d8c9b0c";

function retryRequest() {
  return new NextRequest(`${BASE_URL}/${COMMENT_ID}/retry-sync`, {
    method: "POST",
  });
}

function abandonRequest() {
  return new NextRequest(`${BASE_URL}/${COMMENT_ID}/sync-abandoned`, {
    method: "POST",
  });
}

function sessionContext() {
  return {
    params: Promise.resolve({ id: "session-1", commentId: COMMENT_ID }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retrySync.mockResolvedValue({ ok: true, value: [] });
  mocks.markSyncAbandoned.mockResolvedValue({ ok: true, value: [] });
});

/**
 * Driven through the FOUR route modules' own `POST` exports rather than through
 * the factories they call, because the binding is the thing under test: the
 * factories are correct either way, and wiring `retry-sync/route.ts` to the
 * abandon factory (or a Session route to `CommentTargetType.Branch`) is
 * invisible to a case that calls the factory itself.
 */
describe("the four routes reach the verb and target their URL names (ISS-10382)", () => {
  it("POST .../agent-sessions/.../retry-sync clears the marker and never dead-letters", async () => {
    const response = await sessionRetryPost(retryRequest(), sessionContext());

    expect(response.status).toBe(200);
    expect(mocks.retrySync).toHaveBeenCalledTimes(1);
    // The assertion that survives an inverted ternary. Without it, the recovery
    // door abandons the very comment the author is trying to rescue.
    expect(mocks.markSyncAbandoned).not.toHaveBeenCalled();
    expect(mocks.retrySync).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          type: CommentTargetType.Session,
        }),
      }),
      undefined
    );
  });

  it("POST .../agent-sessions/.../sync-abandoned records the dead letter and never retries", async () => {
    const response = await sessionAbandonPost(
      abandonRequest(),
      sessionContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.markSyncAbandoned).toHaveBeenCalledTimes(1);
    expect(mocks.retrySync).not.toHaveBeenCalled();
    expect(mocks.markSyncAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          type: CommentTargetType.Session,
        }),
      }),
      undefined
    );
  });

  it("POST .../branches/.../retry-sync carries the Branch target, not a copy-pasted Session one", async () => {
    // The four route.ts files differ only by this identifier, so a copy-paste
    // between them is otherwise invisible to the whole suite.
    const response = await branchRetryPost(retryRequest(), sessionContext());

    expect(response.status).toBe(200);
    expect(mocks.markSyncAbandoned).not.toHaveBeenCalled();
    expect(mocks.retrySync).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          type: CommentTargetType.Branch,
        }),
      }),
      undefined
    );
  });

  it("POST .../branches/.../sync-abandoned carries the Branch target and the abandon verb", async () => {
    const response = await branchAbandonPost(
      abandonRequest(),
      sessionContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.retrySync).not.toHaveBeenCalled();
    expect(mocks.markSyncAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          type: CommentTargetType.Branch,
        }),
      }),
      undefined
    );
  });
});

// ISS-11449 removed the describe that stood here. It pinned which of these two
// routes the org session-sync policy gated — the recovery door outranked it, the
// dead-letter producer did not — and the policy is gone, so neither is gated any
// more. The Session happy paths those cases were the foils for are already
// covered by the four-routes describe above.
describe("service refusals become the right status", () => {
  it("maps forbidden to 403, so a non-author cannot clear somebody else's state", async () => {
    mocks.retrySync.mockResolvedValue({ ok: false, reason: "forbidden" });
    const handler = createTraceCommentsRetrySyncPostHandler(
      CommentTargetType.Session
    );

    expect((await handler(retryRequest(), sessionContext())).status).toBe(403);
  });

  it("maps not_found to 404, which is also the reply-id and wrong-surface answer", async () => {
    mocks.retrySync.mockResolvedValue({ ok: false, reason: "not_found" });
    const handler = createTraceCommentsRetrySyncPostHandler(
      CommentTargetType.Session
    );

    expect((await handler(retryRequest(), sessionContext())).status).toBe(404);
  });

  it("does not leak a thrown error as a success", async () => {
    mocks.retrySync.mockRejectedValue(new Error("db exploded"));
    const handler = createTraceCommentsRetrySyncPostHandler(
      CommentTargetType.Session
    );

    const response = await handler(retryRequest(), sessionContext());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("db exploded");
  });
});

// ISS-11190: `comment.id` is `@db.Uuid`, and Postgres raises on a non-UUID
// there, so a malformed path segment reached the service and answered 500. It
// now answers the route's existing not-found response before the service runs.
describe("a non-UUID commentId is not found, not a server error", () => {
  const malformedContext = () => ({
    params: Promise.resolve({ id: "session-1", commentId: "x" }),
  });

  it.each([
    ["session retry-sync", sessionRetryPost, retryRequest],
    ["branch retry-sync", branchRetryPost, retryRequest],
    ["session sync-abandoned", sessionAbandonPost, abandonRequest],
    ["branch sync-abandoned", branchAbandonPost, abandonRequest],
  ])(
    "%s answers 404 without reaching the service",
    async (_label, post, request) => {
      const response = await post(request(), malformedContext());

      expect(response.status).toBe(404);
      expect(mocks.retrySync).not.toHaveBeenCalled();
      expect(mocks.markSyncAbandoned).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["branch retry-sync", branchRetryPost, "retry-sync"],
    ["branch sync-abandoned", branchAbandonPost, "sync-abandoned"],
  ])("%s still answers the surface 400 first", async (_label, post, verb) => {
    const request = new NextRequest(
      `https://api.example.test/branches/branch-1/trace-comments/x/${verb}?surface=${CommentSurface.SessionDetail}`,
      { method: "POST" }
    );

    const response = await post(request, malformedContext());

    expect(response.status).toBe(400);
    expect(mocks.retrySync).not.toHaveBeenCalled();
    expect(mocks.markSyncAbandoned).not.toHaveBeenCalled();
  });
});
