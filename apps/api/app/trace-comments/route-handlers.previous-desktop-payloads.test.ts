import {
  CommentTargetType,
  type TraceComment,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  create: vi.fn(),
  update: vi.fn(),
  reply: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        { user: mocks.user, clerkUserId: mocks.clerkUserId },
        request,
        context.params
      ),
}));

vi.mock("./service", () => ({
  traceCommentsService: {
    create: mocks.create,
    update: mocks.update,
    reply: mocks.reply,
    delete: mocks.delete,
  },
}));

import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";
import {
  createTraceCommentsDeleteHandler,
  createTraceCommentsPatchHandler,
  createTraceCommentsPostHandler,
  createTraceCommentsReplyPostHandler,
} from "./route-handlers";

/**
 * ISS-9984 (Kerensa Whitlock's 2026-09-17 ruling on PRD-699 Appendix A): backward
 * compatibility is this route's responsibility, not something the retry
 * classifier in older desktop builds' sync lane should absorb. These routes are
 * not URL-versioned, and
 * `check:api-contract-removals` covers field REMOVALS only — nothing stops a
 * newly-REQUIRED request field from answering 400 to every already-shipped
 * desktop build. These cases are that stop: each one replays the exact request a
 * previous build sends and fails the build if the route stops accepting it.
 *
 * The fixtures are transcribed from the desktop sender at commit 567b335797
 * (2026-08-03, `apps/desktop/src/main/dashboard/agent-dashboard-trace-comment-sync.ts`)
 * — read it with `git show`, never rebuild it from the current schema: a fixture
 * derived from the schema it polices cannot fail when that schema tightens. That
 * sender forwards `pendingOperation.comment.anchor` verbatim and spreads BOTH
 * `mentions` and `kind` only when the local row carries them, so the two create
 * bodies below are its two reachable shapes: the unconditional minimum, and the
 * same request with both conditional spreads populated.
 *
 * The anchor's own producer at that commit is `resolveTraceSelection` in
 * `packages/app/agents/components/detail/session-trace.tsx` — ISS-7040 (#5461)
 * split it out into `session-trace-selection.ts` later, so `git show` the
 * former, not the latter. It sets `actor` and `sessionId` unconditionally, so
 * every anchor that build puts on the wire carries all nine keys. `actor` is the
 * payload's only nested object and `sessionId` its only nullable — the shapes
 * likeliest to get tightened — and the two bodies replay both of `sessionId`'s
 * legal values and both of `actor.human`'s.
 *
 * The `toEqual` on each parsed payload is deliberate: it pins that the route
 * passes that build's request through and adds nothing of its own. If a
 * compatible `.default()` ever lands on an optional field, widen the
 * EXPECTATION to name the injected default — do not widen the matcher to
 * `toMatchObject`, and do not rebuild the request body from the schema.
 */
const PINNED_DESKTOP_SENDER_SHA = "567b335797";

const ORIGIN = "https://api.example.test";
const SESSION_ID = "session-1";
const BRANCH_ID = "branch-1";
const COMMENT_ID = "0199d0f8-1d4a-7c3e-9b2a-5f6e7d8c9b0c";
// That build guards the param on `target.type === "session" && computeTargetId`,
// so it appends `computeTargetId` only for a session whose install has one
// saved; a session write from an install with none carries no query string at
// all. It sends no `surface` param in either case — branch surfaces postdate it.
const SESSION_QUERY = "?computeTargetId=ct-1";

const previousBuildCreateBody = {
  anchor: {
    traceId: "trace-1",
    turnId: "turn-1",
    row: 0,
    selectedText: "selected",
    sourceText: "selected text",
    startOffset: 0,
    endOffset: 8,
    // `startSource.dataset.traceSessionId || null` and an `actor` object literal
    // in that producer — neither is a conditional spread, so both keys are on
    // the wire for every create that build sends. `name` falls back to "Agent"
    // there, `human` to null, which is what an agent turn with no human yields.
    sessionId: "external-session-1",
    actor: { name: "Agent", human: null },
  },
  body: "a comment from an older desktop build",
  clientId: "local-comment-row-1",
};
// The same build's create once the local row carries @-mentions and a parsing-bug
// classification, i.e. both conditional spreads taken. Also the other legal value
// of each anchor field the minimum above pins one side of: a null `sessionId`
// (that producer's `|| null` fallback) and a populated `actor.human`. `mentions`
// holds a cloud user id, which is what the mention picker puts there, and
// `kind`'s value is written as a literal rather than read from
// `TraceCommentKind`: a shipped build's bytes are frozen in a binary we no longer
// control, so a fixture built from our own constant would follow our own rename
// instead of catching it (ISS-10117).
const previousBuildCreateBodyWithConditionalSpreads = {
  anchor: {
    traceId: "trace-2",
    turnId: "turn-2",
    row: 3,
    selectedText: "flagged",
    sourceText: "flagged text",
    startOffset: 0,
    endOffset: 7,
    sessionId: null,
    actor: { name: "Kerensa Whitlock", human: "Kerensa Whitlock" },
  },
  body: "a parsing-bug report from an older desktop build",
  clientId: "local-comment-row-2",
  mentions: ["6f1c2f4e-6a3d-4c2b-9a77-0f5c1d2e3b48"],
  kind: "parsing_bug",
};
const previousBuildUpdateBody = { body: "an edit from an older desktop build" };
const previousBuildReplyBody = {
  body: "a reply from an older desktop build",
  clientId: "local-reply-row-1",
};

const sampleComment = { id: COMMENT_ID } as TraceComment;

// Each row states the `computeTargetId` the route must hand the service for that
// URL, because a handler that
// dropped or defaulted it would still answer 200 on all of them. `getComputeTargetId`
// resolves the absent param to `null`, so that is the in-process call shape the
// no-target rows pin — the WIRE shape for those rows is the param omitted
// entirely, which is what their URLs above already pin.
const pinnedRoutes = [
  {
    label: "session, compute target saved",
    targetType: CommentTargetType.Session,
    targetId: SESSION_ID,
    expectedComputeTargetId: "ct-1",
    collectionUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments${SESSION_QUERY}`,
    memberUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments/${COMMENT_ID}${SESSION_QUERY}`,
    repliesUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments/${COMMENT_ID}/replies${SESSION_QUERY}`,
  },
  {
    // The shape every already-shipped install sends before its first compute
    // target is saved. It is the only pinned row where a session write reaches
    // the route with no target context, so it is the only one a newly-required
    // `computeTargetId` would answer 400 — the rows that carry the param, and
    // the branch rows the param never applies to, stay green through that
    // change. `apps/api/AGENTS.md` requires absent/partial/complete boundary
    // coverage for exactly this field.
    label: "session, no compute target saved",
    targetType: CommentTargetType.Session,
    targetId: SESSION_ID,
    expectedComputeTargetId: null,
    collectionUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments`,
    memberUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments/${COMMENT_ID}`,
    repliesUrl: `${ORIGIN}/agent-sessions/${SESSION_ID}/trace-comments/${COMMENT_ID}/replies`,
  },
  {
    label: "branch",
    targetType: CommentTargetType.Branch,
    targetId: BRANCH_ID,
    expectedComputeTargetId: null,
    collectionUrl: `${ORIGIN}/branches/${BRANCH_ID}/trace-comments`,
    memberUrl: `${ORIGIN}/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}`,
    repliesUrl: `${ORIGIN}/branches/${BRANCH_ID}/trace-comments/${COMMENT_ID}/replies`,
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(pinnedRoutes)(
  `trace-comment writes accept the desktop sender at ${PINNED_DESKTOP_SENDER_SHA} ($label)`,
  (route) => {
    const context = createMockRouteContext({
      id: route.targetId,
      commentId: COMMENT_ID,
    });

    it("accepts that build's create payload", async () => {
      mocks.create.mockResolvedValue(sampleComment);

      const response = await createTraceCommentsPostHandler(route.targetType)(
        createMockRequest({
          url: route.collectionUrl,
          method: "POST",
          body: previousBuildCreateBody,
        }),
        context
      );

      expect(response.status).toBe(200);
      expect(mocks.create.mock.calls[0][0].draft).toEqual(
        previousBuildCreateBody
      );
      expect(mocks.create.mock.calls[0][0].computeTargetId).toBe(
        route.expectedComputeTargetId
      );
      expect(mocks.create.mock.calls[0][0].surface).toBeUndefined();
    });

    it("accepts that build's create payload with mentions and kind", async () => {
      mocks.create.mockResolvedValue(sampleComment);

      const response = await createTraceCommentsPostHandler(route.targetType)(
        createMockRequest({
          url: route.collectionUrl,
          method: "POST",
          body: previousBuildCreateBodyWithConditionalSpreads,
        }),
        context
      );

      expect(response.status).toBe(200);
      expect(mocks.create.mock.calls[0][0].draft).toEqual(
        previousBuildCreateBodyWithConditionalSpreads
      );
      expect(mocks.create.mock.calls[0][0].computeTargetId).toBe(
        route.expectedComputeTargetId
      );
      expect(mocks.create.mock.calls[0][0].surface).toBeUndefined();
    });

    it.each([
      previousBuildUpdateBody,
      {
        ...previousBuildUpdateBody,
        mentions: ["6f1c2f4e-6a3d-4c2b-9a77-0f5c1d2e3b48"],
      },
    ])("accepts that build's update payload %#", async (body) => {
      mocks.update.mockResolvedValue({ ok: true, value: sampleComment });

      const response = await createTraceCommentsPatchHandler(route.targetType)(
        createMockRequest({
          url: route.memberUrl,
          method: "PATCH",
          body,
        }),
        context
      );

      expect(response.status).toBe(200);
      expect(mocks.update.mock.calls[0][0].update).toEqual(body);
      expect(mocks.update.mock.calls[0][0].computeTargetId).toBe(
        route.expectedComputeTargetId
      );
      expect(mocks.update.mock.calls[0][0].surface).toBeUndefined();
    });

    it.each([
      previousBuildReplyBody,
      {
        ...previousBuildReplyBody,
        mentions: ["6f1c2f4e-6a3d-4c2b-9a77-0f5c1d2e3b48"],
      },
    ])("accepts that build's reply payload %#", async (body) => {
      mocks.reply.mockResolvedValue({ ok: true, value: sampleComment });

      const response = await createTraceCommentsReplyPostHandler(
        route.targetType
      )(
        createMockRequest({
          url: route.repliesUrl,
          method: "POST",
          body,
        }),
        context
      );

      expect(response.status).toBe(200);
      expect(mocks.reply.mock.calls[0][0].draft).toEqual(body);
      expect(mocks.reply.mock.calls[0][0].computeTargetId).toBe(
        route.expectedComputeTargetId
      );
      expect(mocks.reply.mock.calls[0][0].surface).toBeUndefined();
    });

    it("accepts that build's delete request", async () => {
      mocks.delete.mockResolvedValue({ ok: true, value: { deleted: true } });

      const response = await createTraceCommentsDeleteHandler(route.targetType)(
        createMockRequest({ url: route.memberUrl, method: "DELETE" }),
        context
      );

      expect(response.status).toBe(200);
      expect(mocks.delete.mock.calls[0][0].commentId).toBe(COMMENT_ID);
      expect(mocks.delete.mock.calls[0][0].computeTargetId).toBe(
        route.expectedComputeTargetId
      );
      expect(mocks.delete.mock.calls[0][0].surface).toBeUndefined();
    });
  }
);
