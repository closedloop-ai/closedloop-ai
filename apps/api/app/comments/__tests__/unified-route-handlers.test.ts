/**
 * ISS-11212 (PLN-2121 Step 5, production wiring): each unified route file,
 * through its handler and the service's request adapter, resolves its target
 * and calls its command with the parsed input. The commands and the target
 * resolvers are mocked; the routes, handlers and adapter are real.
 */
import {
  CommentSurface,
  ThreadSource,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/comments/service/comment-target", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/comments/service/comment-target")
  >()),
  resolveCommentTarget: vi.fn(),
  resolveThreadCommentTarget: vi.fn(),
  resolveCommentIdTarget: vi.fn(),
}));

vi.mock("@/app/comments/service/comment-commands", () => ({
  createThread: vi.fn(),
  reply: vi.fn(),
}));

vi.mock("@/app/comments/service/comment-edit-commands", () => ({
  editComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock(
  "@/app/comments/service/comment-thread-state-commands",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/comments/service/comment-thread-state-commands")
    >()),
    resolveCommentThread: vi.fn(),
    reopenCommentThread: vi.fn(),
    retrySync: vi.fn(),
  })
);

vi.mock("@/app/comments/service/comment-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/comments/service/comment-read")
  >()),
  listArtifactComments: vi.fn(),
  getThread: vi.fn(),
}));

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { GET as listArtifactCommentsRoute } from "@/app/artifacts/[id]/comments/route";
import { POST as createThreadRoute } from "@/app/artifacts/[id]/comments/threads/route";
import {
  DELETE as deleteCommentRoute,
  PATCH as editCommentRoute,
} from "@/app/comments/[commentId]/route";
import { createThread, reply } from "@/app/comments/service/comment-commands";
import {
  deleteComment,
  editComment,
} from "@/app/comments/service/comment-edit-commands";
import {
  getThread,
  listArtifactComments,
} from "@/app/comments/service/comment-read";
import {
  CommentArtifactType,
  resolveCommentIdTarget,
  resolveCommentTarget,
  resolveThreadCommentTarget,
} from "@/app/comments/service/comment-target";
import {
  reopenCommentThread,
  resolveCommentThread,
  retrySync,
} from "@/app/comments/service/comment-thread-state-commands";
import { POST as reopenThreadRoute } from "@/app/comments/threads/[threadId]/reopen/route";
import { POST as replyRoute } from "@/app/comments/threads/[threadId]/replies/route";
import { POST as resolveThreadRoute } from "@/app/comments/threads/[threadId]/resolve/route";
import { POST as retrySyncThreadRoute } from "@/app/comments/threads/[threadId]/retry-sync/route";
import { GET as getThreadRoute } from "@/app/comments/threads/[threadId]/route";
import { encodeTimeIdCursor } from "@/lib/time-id-cursor";

const ORG_ID = "0199d0f8-0000-7000-8000-000000000001";
const USER_ID = "0199d0f8-0000-7000-8000-000000000002";
const ARTIFACT_ID = "0199d0f8-0000-7000-8000-000000000003";
const THREAD_ID = "0199d0f8-0000-7000-8000-000000000004";
const COMMENT_ID = "0199d0f8-0000-7000-8000-000000000005";
const BASE = "http://localhost:3002/api";

const viewer = { organizationId: ORG_ID, userId: USER_ID };
const target = {
  organizationId: ORG_ID,
  artifactId: ARTIFACT_ID,
  artifactType: CommentArtifactType.Session,
};
const thread = { id: THREAD_ID };
const anchor = {
  kind: CommentAnchorKind.Trace,
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "selected",
  sourceText: "selected text",
  startOffset: 0,
  endOffset: 8,
};

/** What a command receives from the adapter besides the parsed input. */
const actor = {
  viewer,
  target,
  liveState: expect.any(Object),
  present: expect.any(Function),
};

beforeEach(() => {
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: USER_ID,
      organizationId: ORG_ID,
    },
  });
  vi.mocked(resolveCommentTarget).mockResolvedValue(Result.ok(target));
  vi.mocked(resolveThreadCommentTarget).mockResolvedValue(
    Result.ok({ target, source: ThreadSource.Native })
  );
  vi.mocked(resolveCommentIdTarget).mockResolvedValue(
    Result.ok({ target, source: ThreadSource.Native })
  );
});

async function call(
  handler: (request: never, context: never) => Promise<Response>,
  input: {
    path: string;
    params: Record<string, string>;
    method?: string;
    body?: unknown;
  }
) {
  const response = await handler(
    createMockRequest({
      url: `${BASE}${input.path}`,
      method: input.method ?? "GET",
      body: input.body,
    }) as never,
    createMockRouteContext(input.params) as never
  );
  return { status: response.status, body: await response.json() };
}

describe("GET /artifacts/:id/comments", () => {
  it("reads the artifact's comments with the parsed query and decoded cursor", async () => {
    const page = { capabilities: {}, threads: [], nextCursor: null };
    vi.mocked(listArtifactComments).mockResolvedValue(Result.ok(page as never));
    const cursor = encodeTimeIdCursor(1_790_000_000_000, THREAD_ID);
    const computeTargetId = "0199d0f8-0000-7000-8000-000000000006";

    const response = await call(listArtifactCommentsRoute, {
      path: `/artifacts/ext-session/comments?status=OPEN&limit=1000&cursor=${cursor}&surface=${CommentSurface.SessionDetail}&computeTargetId=${computeTargetId}`,
      params: { id: "ext-session" },
    });

    expect(response).toEqual({
      status: 200,
      body: { success: true, data: page },
    });
    expect(listArtifactComments).toHaveBeenCalledWith({
      viewer,
      artifactId: "ext-session",
      clerkUserId: mockAuthContext.clerkUserId,
      computeTargetId,
      surface: CommentSurface.SessionDetail,
      status: ThreadStatus.Open,
      after: { ms: 1_790_000_000_000, id: THREAD_ID },
      limit: 1000,
    });
  });

  it.each([
    ["a cursor it did not mint", "cursor=not-a-cursor"],
    ["a filter it cannot honor", "sort=desc"],
  ])("refuses %s with 400 before reading", async (_label, query) => {
    const response = await call(listArtifactCommentsRoute, {
      path: `/artifacts/${ARTIFACT_ID}/comments?${query}`,
      params: { id: ARTIFACT_ID },
    });

    expect(response.status).toBe(400);
    expect(listArtifactComments).not.toHaveBeenCalled();
  });
});

describe("POST /artifacts/:id/comments/threads", () => {
  it("resolves the artifact, then creates the thread from the parsed body", async () => {
    vi.mocked(createThread).mockResolvedValue(Result.ok(thread));
    const body = {
      anchor,
      body: "note",
      mentions: [USER_ID],
      surface: CommentSurface.SessionDetail,
      kind: TraceCommentKind.ParsingBug,
      clientId: "client-1",
    };

    const response = await call(createThreadRoute, {
      path: `/artifacts/${ARTIFACT_ID}/comments/threads`,
      params: { id: ARTIFACT_ID },
      method: "POST",
      body,
    });

    expect(response).toEqual({
      status: 200,
      body: { success: true, data: thread },
    });
    expect(resolveCommentTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(createThread).toHaveBeenCalledWith({ ...actor, ...body }, undefined);
  });

  it("answers not_found for a non-UUID artifact id without resolving it", async () => {
    const response = await call(createThreadRoute, {
      path: "/artifacts/SES-1/comments/threads",
      params: { id: "SES-1" },
      method: "POST",
      body: { anchor, body: "note", clientId: "client-1" },
    });

    expect(response).toEqual({
      status: 404,
      body: {
        success: false,
        error: CommentErrorCode.NotFound,
        code: CommentErrorCode.NotFound,
      },
    });
    expect(resolveCommentTarget).not.toHaveBeenCalled();
  });

  it("does not call the command when the target does not resolve", async () => {
    vi.mocked(resolveCommentTarget).mockResolvedValue(
      Result.err(CommentErrorCode.ArtifactTypeNotSupported)
    );

    const response = await call(createThreadRoute, {
      path: `/artifacts/${ARTIFACT_ID}/comments/threads`,
      params: { id: ARTIFACT_ID },
      method: "POST",
      body: { anchor, body: "note", clientId: "client-1" },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(CommentErrorCode.ArtifactTypeNotSupported);
    expect(createThread).not.toHaveBeenCalled();
  });
});

describe("thread routes", () => {
  const params = { threadId: THREAD_ID };

  it("GET /comments/threads/:threadId reads the thread", async () => {
    vi.mocked(getThread).mockResolvedValue(Result.ok(thread as never));

    const response = await call(getThreadRoute, {
      path: `/comments/threads/${THREAD_ID}`,
      params,
    });

    expect(response.status).toBe(200);
    expect(getThread).toHaveBeenCalledWith({ viewer, threadId: THREAD_ID });
  });

  it("POST .../replies resolves the thread, then replies with the parsed body", async () => {
    vi.mocked(reply).mockResolvedValue(Result.ok(thread));
    const body = { body: "reply", mentions: [USER_ID], clientId: "client-2" };

    const response = await call(replyRoute, {
      path: `/comments/threads/${THREAD_ID}/replies`,
      params,
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(resolveThreadCommentTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      threadId: THREAD_ID,
    });
    expect(reply).toHaveBeenCalledWith(
      {
        ...actor,
        thread: { threadId: THREAD_ID },
        ...body,
      },
      undefined
    );
  });

  it.each([
    ["resolve", resolveThreadRoute, resolveCommentThread],
    ["reopen", reopenThreadRoute, reopenCommentThread],
  ] as const)(
    "POST .../%s calls its command and answers capability_denied with 403",
    async (name, route, command) => {
      vi.mocked(command).mockResolvedValue(
        Result.err(CommentErrorCode.CapabilityDenied)
      );

      const response = await call(route, {
        path: `/comments/threads/${THREAD_ID}/${name}`,
        params,
        method: "POST",
      });

      expect(response).toEqual({
        status: 403,
        body: {
          success: false,
          error: CommentErrorCode.CapabilityDenied,
          code: CommentErrorCode.CapabilityDenied,
        },
      });
      expect(resolveThreadCommentTarget).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith(
        {
          viewer,
          threadId: THREAD_ID,
          located: { target, source: ThreadSource.Native },
          liveState: expect.any(Object),
          present: expect.any(Function),
        },
        undefined
      );
    }
  );

  it("POST .../retry-sync retries the thread's root", async () => {
    vi.mocked(retrySync).mockResolvedValue(Result.ok(thread));

    const response = await call(retrySyncThreadRoute, {
      path: `/comments/threads/${THREAD_ID}/retry-sync`,
      params,
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(retrySync).toHaveBeenCalledWith(
      {
        ...actor,
        comment: { threadId: THREAD_ID },
      },
      undefined
    );
  });

  it("answers not_found for a non-UUID thread id without resolving it", async () => {
    const response = await call(replyRoute, {
      path: "/comments/threads/thread-1/replies",
      params: { threadId: "thread-1" },
      method: "POST",
      body: { body: "reply", clientId: "client-2" },
    });

    expect(response.status).toBe(404);
    expect(resolveThreadCommentTarget).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("comment routes", () => {
  const params = { commentId: COMMENT_ID };
  const path = `/comments/${COMMENT_ID}`;

  it("PATCH resolves the comment's artifact, then edits against the expected revision", async () => {
    vi.mocked(editComment).mockResolvedValue(Result.ok(thread));
    const body = { body: "edited", mentions: [], expectedRevision: 2 };

    const response = await call(editCommentRoute, {
      path,
      params,
      method: "PATCH",
      body,
    });

    expect(response.status).toBe(200);
    expect(resolveCommentIdTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      commentId: COMMENT_ID,
    });
    expect(editComment).toHaveBeenCalledWith(
      {
        ...actor,
        commentId: COMMENT_ID,
        ...body,
      },
      undefined
    );
  });

  it("PATCH refuses an edit without expectedRevision before writing", async () => {
    const response = await call(editCommentRoute, {
      path,
      params,
      method: "PATCH",
      body: { body: "edited" },
    });

    expect(response.status).toBe(400);
    expect(editComment).not.toHaveBeenCalled();
  });

  it("DELETE resolves the comment's artifact, then deletes it", async () => {
    vi.mocked(deleteComment).mockResolvedValue(Result.ok({ deleted: true }));

    const response = await call(deleteCommentRoute, {
      path,
      params,
      method: "DELETE",
    });

    expect(response).toEqual({
      status: 200,
      body: { success: true, data: { deleted: true } },
    });
    expect(deleteComment).toHaveBeenCalledWith(
      {
        viewer,
        target,
        commentId: COMMENT_ID,
      },
      undefined
    );
  });

  it.each([
    [CommentErrorCode.CapabilityDenied, 403],
    [CommentErrorCode.StaleRevision, 409],
    [CommentErrorCode.ClientIdConflict, 409],
    [CommentErrorCode.AnchorInvalid, 400],
    [CommentErrorCode.AnchorKindNotAllowed, 400],
    [CommentErrorCode.ArtifactTypeNotSupported, 400],
    [CommentErrorCode.NotFound, 404],
  ])("answers %s with %i and the code as the error", async (code, status) => {
    vi.mocked(editComment).mockResolvedValue(Result.err(code));

    const response = await call(editCommentRoute, {
      path,
      params,
      method: "PATCH",
      body: { body: "edited", expectedRevision: 0 },
    });

    expect(response).toEqual({
      status,
      body: { success: false, error: code, code },
    });
  });
});
