/**
 * ISS-11212 review: every unified write on a Branch the product no longer
 * serves answers not_found before its command runs, as the Branch read and the
 * legacy branch routes do. The commands, target resolvers and eligibility check
 * are mocked; the routes, handlers and adapter are real.
 */
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
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

vi.mock("@/app/branches/cloud-branch-eligibility", () => ({
  branchHasCloudEligibility: vi.fn(),
}));

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

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { POST as createThreadRoute } from "@/app/artifacts/[id]/comments/threads/route";
import { branchHasCloudEligibility } from "@/app/branches/cloud-branch-eligibility";
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

const ORG_ID = "0199d0f8-0000-7000-8000-000000000001";
const USER_ID = "0199d0f8-0000-7000-8000-000000000002";
const BRANCH_ID = "0199d0f8-0000-7000-8000-000000000003";
const THREAD_ID = "0199d0f8-0000-7000-8000-000000000004";
const COMMENT_ID = "0199d0f8-0000-7000-8000-000000000005";
const BASE = "http://localhost:3002/api";

const branch = {
  organizationId: ORG_ID,
  artifactId: BRANCH_ID,
  artifactType: CommentArtifactType.Branch,
};
const eligibilityDb = { marker: "eligibility-db" };
const threadParams = { threadId: THREAD_ID };
const commentParams = { commentId: COMMENT_ID };

type RouteHandler = (request: never, context: never) => Promise<Response>;

const WRITES: readonly [
  string,
  RouteHandler,
  {
    path: string;
    params: Record<string, string>;
    method: string;
    body?: unknown;
  },
  (...args: never[]) => unknown,
][] = [
  [
    "create",
    createThreadRoute,
    {
      path: `/artifacts/${BRANCH_ID}/comments/threads`,
      params: { id: BRANCH_ID },
      method: "POST",
      body: {
        anchor: { kind: CommentAnchorKind.Artifact },
        body: "note",
        clientId: "client-1",
      },
    },
    createThread,
  ],
  [
    "reply",
    replyRoute,
    {
      path: `/comments/threads/${THREAD_ID}/replies`,
      params: threadParams,
      method: "POST",
      body: { body: "reply", clientId: "client-2" },
    },
    reply,
  ],
  [
    "resolve",
    resolveThreadRoute,
    {
      path: `/comments/threads/${THREAD_ID}/resolve`,
      params: threadParams,
      method: "POST",
    },
    resolveCommentThread,
  ],
  [
    "reopen",
    reopenThreadRoute,
    {
      path: `/comments/threads/${THREAD_ID}/reopen`,
      params: threadParams,
      method: "POST",
    },
    reopenCommentThread,
  ],
  [
    "retry-sync",
    retrySyncThreadRoute,
    {
      path: `/comments/threads/${THREAD_ID}/retry-sync`,
      params: threadParams,
      method: "POST",
    },
    retrySync,
  ],
  [
    "edit",
    editCommentRoute,
    {
      path: `/comments/${COMMENT_ID}`,
      params: commentParams,
      method: "PATCH",
      body: { body: "edited", expectedRevision: 0 },
    },
    editComment,
  ],
  [
    "delete",
    deleteCommentRoute,
    {
      path: `/comments/${COMMENT_ID}`,
      params: commentParams,
      method: "DELETE",
    },
    deleteComment,
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: USER_ID,
      organizationId: ORG_ID,
    },
  });
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(callback(eligibilityDb as never))
  );
  vi.mocked(resolveCommentTarget).mockResolvedValue(Result.ok(branch));
  vi.mocked(resolveThreadCommentTarget).mockResolvedValue(
    Result.ok({ target: branch, source: ThreadSource.Native })
  );
  vi.mocked(resolveCommentIdTarget).mockResolvedValue(
    Result.ok({ target: branch, source: ThreadSource.Native })
  );
});

async function call(
  handler: RouteHandler,
  input: {
    path: string;
    params: Record<string, string>;
    method: string;
    body?: unknown;
  }
) {
  const response = await handler(
    createMockRequest({
      url: `${BASE}${input.path}`,
      method: input.method,
      body: input.body,
    }) as never,
    createMockRouteContext(input.params) as never
  );
  return { status: response.status, body: await response.json() };
}

describe("unified comment writes on a Branch the product no longer serves", () => {
  it.each(WRITES)(
    "%s answers not_found without running its command",
    async (_name, route, request, command) => {
      vi.mocked(branchHasCloudEligibility).mockResolvedValue(false);

      const response = await call(route, request);

      expect(response).toEqual({
        status: 404,
        body: {
          success: false,
          error: CommentErrorCode.NotFound,
          code: CommentErrorCode.NotFound,
        },
      });
      expect(branchHasCloudEligibility).toHaveBeenCalledWith(
        eligibilityDb,
        ORG_ID,
        BRANCH_ID
      );
      expect(command).not.toHaveBeenCalled();
    }
  );

  it.each(WRITES)(
    "%s runs its command on a Branch the product serves",
    async (_name, route, request, command) => {
      vi.mocked(branchHasCloudEligibility).mockResolvedValue(true);
      vi.mocked(command).mockResolvedValue(
        Result.err(CommentErrorCode.CapabilityDenied) as never
      );

      const response = await call(route, request);

      expect(response.status).toBe(403);
      expect(command).toHaveBeenCalledTimes(1);
    }
  );
});
