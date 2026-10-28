/**
 * PLN-2187 T-2.3 (production wiring): the upload route validates its body,
 * resolves the comment's artifact and starts the upload, answering a spent
 * upload budget with the document attachment routes' 429. The command and the
 * target resolver are mocked; the route, its handler and the service's request
 * adapter are real.
 */
import {
  AttachmentUploadError,
  AttachmentUploadResponseErrorCode,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import { ThreadSource } from "@repo/api/src/types/comment";
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
  resolveCommentIdTarget: vi.fn(),
}));

vi.mock(
  "@/app/comments/service/comment-attachment-commands",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/comments/service/comment-attachment-commands")
    >()),
    createUpload: vi.fn(),
  })
);

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { POST as createUploadRoute } from "@/app/comments/[commentId]/attachments/route";
import { createUpload } from "@/app/comments/service/comment-attachment-commands";
import {
  CommentArtifactType,
  resolveCommentIdTarget,
} from "@/app/comments/service/comment-target";

const ORG_ID = "0199d0f8-0000-7000-8000-000000000001";
const USER_ID = "0199d0f8-0000-7000-8000-000000000002";
const ARTIFACT_ID = "0199d0f8-0000-7000-8000-000000000003";
const COMMENT_ID = "0199d0f8-0000-7000-8000-000000000005";
const ATTACHMENT_ID = "0199d0f8-0000-7000-8000-000000000006";
const BASE = "http://localhost:3002/api";
const REQUEST = { name: "notes.txt", mimeType: "text/plain", size: 12 };

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
  vi.mocked(createUpload).mockResolvedValue(
    Result.ok({ attachmentId: ATTACHMENT_ID, uploadUrl: "https://upload.test" })
  );
});

async function post(body: unknown, commentId = COMMENT_ID) {
  const response = await createUploadRoute(
    createMockRequest({
      url: `${BASE}/comments/${commentId}/attachments`,
      method: "POST",
      body,
    }) as never,
    createMockRouteContext({ commentId }) as never
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body: await response.json(),
  };
}

describe("POST /comments/:commentId/attachments", () => {
  it("resolves the comment's artifact, then starts the upload with the request", async () => {
    const response = await post(REQUEST);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { attachmentId: ATTACHMENT_ID, uploadUrl: "https://upload.test" },
    });
    expect(resolveCommentIdTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      commentId: COMMENT_ID,
    });
    expect(createUpload).toHaveBeenCalledWith(
      {
        viewer: { organizationId: ORG_ID, userId: USER_ID },
        target,
        liveState: expect.any(Object),
        present: expect.any(Function),
        commentId: COMMENT_ID,
        request: REQUEST,
      },
      undefined
    );
  });

  it.each([
    [
      "a type off the allow-list",
      { ...REQUEST, mimeType: "application/x-msdownload" },
    ],
    [
      "a non-media file past the document ceiling",
      { ...REQUEST, size: MAX_ATTACHMENT_FILE_SIZE_BYTES + 1 },
    ],
    ["an empty name", { ...REQUEST, name: "" }],
  ])("refuses %s with 400 before resolving", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(resolveCommentIdTarget).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
  });

  it("answers a spent upload budget with 429 and its retry delay", async () => {
    vi.mocked(createUpload).mockResolvedValue(
      Result.err({
        type: AttachmentUploadError.RateLimited,
        retryAfterSeconds: 42,
      })
    );

    const response = await post(REQUEST);

    expect(response.status).toBe(429);
    expect(response.retryAfter).toBe("42");
    expect(response.body).toMatchObject({
      success: false,
      code: AttachmentUploadResponseErrorCode.RateLimited,
    });
  });

  it("answers a refused command with its code", async () => {
    vi.mocked(createUpload).mockResolvedValue(
      Result.err(CommentErrorCode.CapabilityDenied)
    );

    const response = await post(REQUEST);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: CommentErrorCode.CapabilityDenied,
      code: CommentErrorCode.CapabilityDenied,
    });
  });
});
