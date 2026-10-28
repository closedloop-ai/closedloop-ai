/**
 * PLN-2187 T-2.3 and T-2.4: comment attachments against a real database, with
 * S3 stubbed. The Attach grant and authorship gate an upload, a confirmed
 * upload shows and bumps the revision, the download route redirects to the
 * file, and deleting a comment removes its rows and our objects.
 */

import {
  type AttachmentDownloadResponse,
  AttachmentUploadError,
} from "@repo/api/src/types/attachment";
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  type CommentThreadDto,
  commentApiPaths,
} from "@repo/api/src/types/comment-thread-dto";
import type { ApiResult } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

const { BUCKET } = vi.hoisted(() => ({
  BUCKET: "comment-attachments-test-bucket",
}));

const auth = vi.hoisted(() => ({
  viewer: { organizationId: "", userId: "" },
}));

const aws = vi.hoisted(() => ({
  getSignedUploadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://upload.test/${key}`)
  ),
  getSignedDownloadUrlWithDisposition: vi.fn((key: string) =>
    Promise.resolve(`https://download.test/${key}`)
  ),
  headAttachmentObject: vi.fn(
    (): Promise<{ byteSize?: number } | null> =>
      Promise.resolve({ byteSize: 12 })
  ),
  deleteObjects: vi.fn(
    (_keys: string[], _bucket?: string): Promise<void> => Promise.resolve()
  ),
}));

vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  ...aws,
}));

vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({ ...actual.keys(), FILE_ATTACHMENTS_BUCKET: BUCKET }),
  };
});

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(
        {
          user: {
            id: auth.viewer.userId,
            organizationId: auth.viewer.organizationId,
          },
          clerkUserId: null,
        },
        request,
        context.params
      ),
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  type CommentTestOrg,
  commentTraceAnchor,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { POST as createUploadRoute } from "@/app/comments/[commentId]/attachments/route";
import { POST as completeUploadRoute } from "@/app/comments/attachments/[attachmentId]/complete/route";
import { GET as downloadRoute } from "@/app/comments/attachments/[attachmentId]/route";
import { commentsService } from "@/app/comments/service";
import {
  ATTACHMENT_UPLOAD_LIMIT_BUCKET,
  ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS,
} from "@/app/documents/attachment-upload-rate-limit";
import {
  type CommentSourcePolicies,
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";
import type { CommentTarget } from "./comment-target";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const BASE = "http://localhost:3002/api";
const REQUEST = {
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
} as const;
const SYNCED_URL = "https://github.com/user-attachments/files/1/notes.txt";
// Below the 5s interactive-transaction timeout of the delete held open.
const LOCK_WAIT_DEADLINE_MS = 4000;
const LOCK_POLL_MS = 25;

/** No shipped Session source grants Attach; this grants it to anyone. */
const SESSION_ATTACH_POLICIES: CommentSourcePolicies = {
  ...COMMENT_SOURCE_POLICIES,
  [CommentPolicyKey.NativeSession]: {
    ...COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession],
    capabilities: {
      ...COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession].capabilities,
      [CommentCapability.Attach]: CapabilityGrant.Any,
    },
  },
};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown }
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

type RouteHandler = (request: never, context: never) => Promise<Response>;

async function callRoute(
  as: CommentViewer,
  handler: RouteHandler,
  input: {
    path: string;
    params: Record<string, string>;
    method: string;
    body?: unknown;
  }
) {
  auth.viewer = as;
  return await handler(
    createMockRequest({
      url: `${BASE}${input.path}`,
      method: input.method,
      body: input.body,
    }) as never,
    createMockRouteContext(input.params) as never
  );
}

describeIfDb("comment service: attachments", () => {
  let org: CommentTestOrg;
  let row = 0;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await clearUploadBudget();
    await tracker.cleanup();
  });

  function uploadBudgetSubject() {
    return `${org.organizationId}:${org.session.artifactId}`;
  }

  /** Resolves once a backend is blocked on the upload's comment lock. */
  async function waitForLockedUpload(): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
    while (Date.now() < deadline) {
      const [waiting] = await withDb(
        (db) => db.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`
      );
      if ((waiting?.count ?? 0n) > 0n) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    throw new Error("no upload waited on the comment lock");
  }

  async function clearUploadBudget(): Promise<void> {
    await withDb((db) =>
      db.oAuthRateLimit.deleteMany({
        where: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject: uploadBudgetSubject(),
        },
      })
    );
  }

  async function uploadBudgetUsed(): Promise<number> {
    const budget = await withDb((db) =>
      db.oAuthRateLimit.findUnique({
        where: {
          bucket_subject: {
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject: uploadBudgetSubject(),
          },
        },
        select: { requestCount: true },
      })
    );
    return budget?.requestCount ?? 0;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function present(viewer: CommentViewer, target: CommentTarget) {
    return presentCommentThreadDto({
      viewer,
      target,
      liveState: createCommentLiveState(viewer),
    });
  }

  async function openThread(
    target: CommentTarget = org.session
  ): Promise<{ thread: CommentThreadDto; commentId: string }> {
    row += 1;
    const thread = unwrap(
      await commentsService.createThread({
        viewer: org.author,
        target,
        anchor: commentTraceAnchor(row),
        body: `root ${row}`,
        clientId: null,
        present: present(org.author, target),
      })
    );
    return { thread, commentId: thread.comments[0]?.id as string };
  }

  function startUpload(viewer: CommentViewer, commentId: string) {
    return commentsService.createUpload({
      viewer,
      target: org.session,
      commentId,
      request: REQUEST,
      policies: SESSION_ATTACH_POLICIES,
    });
  }

  function confirmUpload(attachmentId: string) {
    return commentsService.completeUpload({
      viewer: org.author,
      target: org.session,
      attachmentId,
      policies: SESSION_ATTACH_POLICIES,
      present: present(org.author, org.session),
    });
  }

  function seedAttachment(
    commentId: string,
    stored: { url?: string; key?: string; uploadedAt?: Date }
  ) {
    return withDb((db) =>
      db.commentAttachment.create({
        data: {
          commentId,
          name: REQUEST.name,
          url: stored.url ?? null,
          bucket: stored.key ? BUCKET : null,
          key: stored.key ?? null,
          uploadedAt: stored.uploadedAt ?? null,
        },
        select: { id: true },
      })
    );
  }

  function attachmentRows(commentId: string) {
    return withDb((db) =>
      db.commentAttachment.findMany({
        where: { commentId },
        select: { id: true, bucket: true, key: true, uploadedAt: true },
      })
    );
  }

  async function download(as: CommentViewer, attachmentId: string) {
    const response = await callRoute(as, downloadRoute, {
      path: commentApiPaths.attachment(attachmentId),
      params: { attachmentId },
      method: "GET",
    });
    const body: ApiResult<AttachmentDownloadResponse> = await response.json();
    return {
      status: response.status,
      downloadUrl: body.success ? body.data.downloadUrl : null,
    };
  }

  it.each([
    ["Session", () => org.session],
    ["Branch", () => org.branch],
  ])(
    "answers capability_denied on a %s through both upload routes, writing nothing",
    async (_label, targetOf) => {
      const { commentId } = await openThread(targetOf());
      const pending = await seedAttachment(commentId, {
        key: `pending-${row}`,
      });

      const created = await callRoute(org.author, createUploadRoute, {
        path: commentApiPaths.commentAttachments(commentId),
        params: { commentId },
        method: "POST",
        body: REQUEST,
      });
      const completed = await callRoute(org.author, completeUploadRoute, {
        path: commentApiPaths.attachmentComplete(pending.id),
        params: { attachmentId: pending.id },
        method: "POST",
      });

      expect(created.status).toBe(403);
      await expect(created.json()).resolves.toMatchObject({
        code: CommentErrorCode.CapabilityDenied,
      });
      expect(completed.status).toBe(403);
      await expect(completed.json()).resolves.toMatchObject({
        code: CommentErrorCode.CapabilityDenied,
      });
      expect(aws.getSignedUploadUrl).not.toHaveBeenCalled();
      expect(aws.headAttachmentObject).not.toHaveBeenCalled();
      await expect(attachmentRows(commentId)).resolves.toEqual([
        {
          id: pending.id,
          bucket: BUCKET,
          key: `pending-${row}`,
          uploadedAt: null,
        },
      ]);
    }
  );

  it("starts an upload only for the comment's author, hidden until confirmed", async () => {
    const { thread, commentId } = await openThread();

    const refused = await startUpload(org.other, commentId);
    const upload = unwrap(await startUpload(org.author, commentId));

    expect(refused).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    const key = `comment-attachments/${org.organizationId}/${commentId}/${upload.attachmentId}`;
    expect(upload.uploadUrl).toBe(`https://upload.test/${key}`);
    expect(aws.getSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(aws.getSignedUploadUrl).toHaveBeenCalledWith(
      key,
      REQUEST.mimeType,
      900,
      BUCKET,
      REQUEST.size,
      { bindContentType: true }
    );
    await expect(attachmentRows(commentId)).resolves.toEqual([
      { id: upload.attachmentId, bucket: BUCKET, key, uploadedAt: null },
    ]);
    const read = unwrap(
      await commentsService.getThread({
        viewer: org.author,
        threadId: thread.id,
      })
    );
    expect(read.revision).toBe(thread.revision);
    expect(read.comments[0]?.attachments).toEqual([]);
  });

  it("spends the artifact's upload budget only after authorization, and refuses once it is spent", async () => {
    const { commentId } = await openThread();
    onTestFinished(clearUploadBudget);
    const before = await uploadBudgetUsed();

    const refused = await startUpload(org.other, commentId);
    const usedAfterRefusal = await uploadBudgetUsed();
    unwrap(await startUpload(org.author, commentId));
    const usedAfterUpload = await uploadBudgetUsed();
    await withDb((db) =>
      db.oAuthRateLimit.updateMany({
        where: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject: uploadBudgetSubject(),
        },
        data: { requestCount: ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS },
      })
    );
    const limited = await startUpload(org.author, commentId);

    expect(refused).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    expect(usedAfterRefusal).toBe(before);
    expect(usedAfterUpload).toBe(before + 1);
    expect(limited).toEqual({
      ok: false,
      error: {
        type: AttachmentUploadError.RateLimited,
        retryAfterSeconds: expect.any(Number),
      },
    });
    expect(aws.getSignedUploadUrl).toHaveBeenCalledTimes(1);
    await expect(attachmentRows(commentId)).resolves.toHaveLength(1);
  });

  it("confirms an upload only once its object exists, then shows it once", async () => {
    const { thread, commentId } = await openThread();
    const { attachmentId } = unwrap(await startUpload(org.author, commentId));
    aws.headAttachmentObject.mockResolvedValueOnce(null);

    const missing = await confirmUpload(attachmentId);
    const confirmed = unwrap(await confirmUpload(attachmentId));
    const repeat = unwrap(await confirmUpload(attachmentId));

    expect(missing).toEqual({ ok: false, error: CommentErrorCode.NotFound });
    expect(confirmed.revision).toBe(thread.revision + 1);
    expect(confirmed.comments[0]?.attachments).toEqual([
      {
        id: attachmentId,
        name: REQUEST.name,
        mimeType: REQUEST.mimeType,
        size: REQUEST.size,
        downloadPath: commentApiPaths.attachment(attachmentId),
      },
    ]);
    expect(repeat.revision).toBe(confirmed.revision);
    expect(aws.headAttachmentObject).toHaveBeenCalledTimes(2);
  });

  it("answers a synced url-only row with its stored url", async () => {
    const { commentId } = await openThread();
    const synced = await seedAttachment(commentId, { url: SYNCED_URL });

    await expect(download(org.other, synced.id)).resolves.toEqual({
      status: 200,
      downloadUrl: SYNCED_URL,
    });
    expect(aws.getSignedDownloadUrlWithDisposition).not.toHaveBeenCalled();
  });

  it("answers a confirmed upload with a signed url for its object", async () => {
    const { commentId } = await openThread();
    const key = `confirmed-${row}`;
    const stored = await seedAttachment(commentId, {
      key,
      uploadedAt: new Date(),
    });

    await expect(download(org.other, stored.id)).resolves.toEqual({
      status: 200,
      downloadUrl: `https://download.test/${key}`,
    });
    expect(aws.getSignedDownloadUrlWithDisposition).toHaveBeenCalledWith(
      key,
      REQUEST.name,
      3600,
      BUCKET
    );
  });

  it("answers not_found for a pending upload, a plaintext url and another org", async () => {
    const { commentId } = await openThread();
    const pending = await seedAttachment(commentId, { key: `pending-${row}` });
    const plaintext = await seedAttachment(commentId, {
      url: SYNCED_URL.replace("https:", "http:"),
    });
    const synced = await seedAttachment(commentId, { url: SYNCED_URL });
    const outsider = await seedCommentTestOrg(tracker);

    await expect(download(org.author, pending.id)).resolves.toEqual({
      status: 404,
      downloadUrl: null,
    });
    await expect(download(org.author, plaintext.id)).resolves.toEqual({
      status: 404,
      downloadUrl: null,
    });
    await expect(download(outsider.author, synced.id)).resolves.toEqual({
      status: 404,
      downloadUrl: null,
    });
    expect(aws.getSignedDownloadUrlWithDisposition).not.toHaveBeenCalled();
  });

  it("refuses an upload whose comment is deleted while the upload waits on it", async () => {
    const { commentId } = await openThread();
    onTestFinished(clearUploadBudget);
    let releaseDelete = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteWritten = (): void => undefined;
    const written = new Promise<void>((resolve) => {
      deleteWritten = resolve;
    });
    const deleting = withDb.tx(async (tx) => {
      await tx.comment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
      deleteWritten();
      await held;
    });
    await written;

    const upload = startUpload(org.author, commentId);
    const finishedFirst = await Promise.race([
      upload.then(() => true),
      waitForLockedUpload().then(() => false),
    ]);
    releaseDelete();
    await deleting;

    expect(finishedFirst).toBe(false);
    await expect(upload).resolves.toEqual({
      ok: false,
      error: CommentErrorCode.NotFound,
    });
    await expect(attachmentRows(commentId)).resolves.toEqual([]);
  });

  it("deletes every attachment row of a deleted thread and only our objects", async () => {
    const { thread, commentId } = await openThread();
    const replied = unwrap(
      await commentsService.reply({
        viewer: org.author,
        target: org.session,
        thread: { threadId: thread.id },
        body: "reply",
        clientId: null,
        present: present(org.author, org.session),
      })
    );
    const replyId = replied.comments[1]?.id as string;
    await seedAttachment(commentId, { url: SYNCED_URL });
    await seedAttachment(commentId, {
      key: `root-${row}`,
      uploadedAt: new Date(),
    });
    await seedAttachment(replyId, { key: `reply-${row}` });

    unwrap(
      await commentsService.deleteComment({
        viewer: org.author,
        target: org.session,
        commentId,
      })
    );

    await expect(attachmentRows(commentId)).resolves.toEqual([]);
    await expect(attachmentRows(replyId)).resolves.toEqual([]);
    expect(aws.deleteObjects).toHaveBeenCalledTimes(1);
    const [keysDeleted = [], bucket] = aws.deleteObjects.mock.calls[0] ?? [];
    expect(bucket).toBe(BUCKET);
    expect([...keysDeleted].sort()).toEqual(
      [`reply-${row}`, `root-${row}`].sort()
    );
  });

  it("keeps the delete when S3 refuses the objects", async () => {
    const { commentId } = await openThread();
    await seedAttachment(commentId, {
      key: `kept-${row}`,
      uploadedAt: new Date(),
    });
    aws.deleteObjects.mockRejectedValueOnce(new Error("S3 unavailable"));

    const deleted = await commentsService.deleteComment({
      viewer: org.author,
      target: org.session,
      commentId,
    });

    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    await expect(attachmentRows(commentId)).resolves.toEqual([]);
    expect(aws.deleteObjects).toHaveBeenCalledTimes(1);
  });
});
