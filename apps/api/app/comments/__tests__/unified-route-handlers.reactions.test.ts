/**
 * PLN-2187 T-2.2 (production wiring): the reaction route resolves the
 * comment's artifact and calls its command with the decoded, validated emoji.
 * The commands and the target resolver are mocked; the route, its handlers
 * and the service's request adapter are real.
 */
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { CommentReactionEmoji } from "@repo/api/src/types/comment-thread-dto";
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
  resolveCommentIdTarget: vi.fn(),
}));

vi.mock("@/app/comments/service/comment-reaction-commands", () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import {
  PUT as addReactionRoute,
  DELETE as removeReactionRoute,
} from "@/app/comments/[commentId]/reactions/[emoji]/route";
import {
  addReaction,
  removeReaction,
} from "@/app/comments/service/comment-reaction-commands";
import {
  CommentArtifactType,
  resolveCommentIdTarget,
} from "@/app/comments/service/comment-target";

const ORG_ID = "0199d0f8-0000-7000-8000-000000000001";
const USER_ID = "0199d0f8-0000-7000-8000-000000000002";
const ARTIFACT_ID = "0199d0f8-0000-7000-8000-000000000003";
const COMMENT_ID = "0199d0f8-0000-7000-8000-000000000005";
const BASE = "http://localhost:3002/api";
const EMOJI = CommentReactionEmoji.ThumbsUp;

const viewer = { organizationId: ORG_ID, userId: USER_ID };
const target = {
  organizationId: ORG_ID,
  artifactId: ARTIFACT_ID,
  artifactType: CommentArtifactType.Session,
};

beforeEach(() => {
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: USER_ID,
      organizationId: ORG_ID,
    },
  });
  vi.mocked(resolveCommentIdTarget).mockResolvedValue(
    Result.ok({ target, source: ThreadSource.Native })
  );
  vi.mocked(addReaction).mockResolvedValue(Result.ok({ id: "thread-1" }));
  vi.mocked(removeReaction).mockResolvedValue(Result.ok({ id: "thread-1" }));
});

async function call(
  handler: (request: never, context: never) => Promise<Response>,
  method: string,
  params: { commentId: string; emoji: string }
) {
  const response = await handler(
    createMockRequest({
      url: `${BASE}/comments/${params.commentId}/reactions/${encodeURIComponent(params.emoji)}`,
      method,
    }) as never,
    createMockRouteContext(params) as never
  );
  return { status: response.status, body: await response.json() };
}

describe.each([
  ["PUT", addReactionRoute, addReaction],
  ["DELETE", removeReactionRoute, removeReaction],
] as const)(
  "%s /comments/:commentId/reactions/:emoji",
  (method, route, command) => {
    it("resolves the comment's artifact, then runs the command with the emoji", async () => {
      const response = await call(route, method, {
        commentId: COMMENT_ID,
        emoji: EMOJI,
      });

      expect(response).toEqual({
        status: 200,
        body: { success: true, data: { id: "thread-1" } },
      });
      expect(resolveCommentIdTarget).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        commentId: COMMENT_ID,
      });
      expect(command).toHaveBeenCalledWith(
        {
          viewer,
          target,
          liveState: expect.any(Object),
          present: expect.any(Function),
          commentId: COMMENT_ID,
          emoji: EMOJI,
        },
        undefined
      );
    });

    it("refuses an emoji outside the reaction set with 400 before resolving", async () => {
      const response = await call(route, method, {
        commentId: COMMENT_ID,
        emoji: "🦄",
      });

      expect(response.status).toBe(400);
      expect(resolveCommentIdTarget).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
    });

    it("answers not_found for a non-UUID comment id without resolving it", async () => {
      const response = await call(route, method, {
        commentId: "not-a-uuid",
        emoji: EMOJI,
      });

      expect(response).toEqual({
        status: 404,
        body: {
          success: false,
          error: CommentErrorCode.NotFound,
          code: CommentErrorCode.NotFound,
        },
      });
      expect(resolveCommentIdTarget).not.toHaveBeenCalled();
    });
  }
);
