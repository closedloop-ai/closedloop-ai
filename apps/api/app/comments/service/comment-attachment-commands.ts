import type { AttachmentUploadError } from "@repo/api/src/types/attachment";
import { CommentCapability } from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import {
  deleteObjects,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
  headAttachmentObject,
} from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { S3_BATCH_DELETE_MAX_KEYS } from "@repo/aws/s3-client";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { consumeAttachmentUploadLimit } from "@/app/documents/attachment-upload-rate-limit";
import { ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS } from "@/app/documents/attachments-service";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { CreateCommentAttachmentRequest } from "../comment-attachment-request";
import {
  type CommentLiveState,
  type CommentSourcePolicies,
  type CommentViewer,
  createCommentLiveState,
  isCapabilityAvailable,
} from "./comment-capabilities";
import {
  type CommentPresenter,
  findCommentOnTarget,
} from "./comment-command-lookup";
import {
  type CommentWrite,
  type CommentWritten,
  runCommentCommand,
} from "./comment-command-pipeline";
import { readServedTarget } from "./comment-read";
import {
  type CommentTarget,
  nativeCommentPolicyKey,
  resolveThreadCommentTarget,
} from "./comment-target";
import { ThreadChangeKind } from "./comment-thread-signal";

/** PLN-2187 DD-7: every comment file lives under this key prefix. */
export const COMMENT_ATTACHMENT_KEY_PREFIX = "comment-attachments";

const COMMENT_ATTACHMENT_DOWNLOAD_EXPIRY_SECONDS = 3600;

/** Where a client PUTs the file before confirming it. */
export type CommentAttachmentUpload = {
  attachmentId: string;
  uploadUrl: string;
};

export type CommentAttachmentUploadError =
  | CommentErrorCode
  | AttachmentUploadError;

type AttachActor = {
  viewer: CommentViewer;
  target: CommentTarget;
  liveState?: CommentLiveState;
  policies?: CommentSourcePolicies;
};

/**
 * PLN-2187 T-2.3: the author of a live comment starts an upload to it. The
 * row is written with `uploadedAt` null, so no read shows it until
 * {@link completeUpload}; nothing a reader sees changes, so no revision moves.
 * The grant and authorship are checked before the artifact's upload budget is
 * spent, and again inside the write.
 */
export async function createUpload(
  input: AttachActor & {
    commentId: string;
    request: CreateCommentAttachmentRequest;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<CommentAttachmentUpload, CommentAttachmentUploadError>> {
  const { target, request } = input;
  const liveState = input.liveState ?? createCommentLiveState(input.viewer);
  const authorized = await authorizeAttach({ ...input, liveState }, (db) =>
    findAuthoredComment(db, input)
  );
  if (!authorized.ok) {
    return authorized;
  }
  const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
  if (!bucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }
  const limited = await consumeAttachmentUploadLimit(
    target.organizationId,
    target.artifactId
  );
  if (!limited.ok) {
    return limited;
  }
  const attachmentId = uuidv7();
  const key = commentAttachmentKey({
    organizationId: target.organizationId,
    commentId: input.commentId,
    attachmentId,
  });
  // Signed before the row is written, so a signing failure leaves no row. The
  // type is bound so the stored object keeps the MIME type the row records.
  const uploadUrl = await getSignedUploadUrl(
    key,
    request.mimeType,
    ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
    bucket,
    request.size,
    { bindContentType: true }
  );
  return runCommentCommand({
    target,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    liveState,
    capability: CommentCapability.Attach,
    policies: input.policies,
    recordWrite,
    write: async (
      tx
    ): Promise<
      Result<CommentWrite<CommentAttachmentUpload>, CommentErrorCode>
    > => {
      // The row's foreign key takes only KEY SHARE, which a soft delete does
      // not wait on. Without this lock a delete that commits before the insert
      // misses the new row, and it outlives its comment.
      await tx.$queryRaw`SELECT 1 FROM "comments" WHERE "id" = ${input.commentId}::uuid FOR SHARE`;
      const found = await findAuthoredComment(tx, input);
      if (!found.ok) {
        return found;
      }
      await tx.commentAttachment.create({
        data: {
          id: attachmentId,
          commentId: input.commentId,
          name: request.name,
          mimeType: request.mimeType,
          size: request.size,
          bucket,
          key,
        },
        select: { id: true },
      });
      return Result.ok({
        changes: [],
        commentId: input.commentId,
        stored: true,
        present: () => Promise.resolve({ attachmentId, uploadUrl }),
      });
    },
  });
}

/**
 * The uploader confirms the object landed: it must exist in the bucket, then
 * the attachment shows and the thread's revision moves. A repeat changes
 * nothing.
 */
export async function completeUpload<T>(
  input: AttachActor & { attachmentId: string; present: CommentPresenter<T> },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  const { target } = input;
  const liveState = input.liveState ?? createCommentLiveState(input.viewer);
  const authorized = await authorizeAttach({ ...input, liveState }, (db) =>
    findAuthoredUpload(db, input)
  );
  if (!authorized.ok) {
    return authorized;
  }
  const { uploadedAt, bucket, key } = authorized.value;
  // The object is checked outside the transaction, so S3 holds no connection.
  if (uploadedAt === null && !(await headAttachmentObject(key, bucket))) {
    return Result.err(CommentErrorCode.NotFound);
  }
  return runCommentCommand({
    target,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    liveState,
    capability: CommentCapability.Attach,
    policies: input.policies,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const found = await findAuthoredUpload(tx, input);
      if (!found.ok) {
        return found;
      }
      const { threadId, commentId } = found.value;
      const { count } = await tx.commentAttachment.updateMany({
        where: { id: input.attachmentId, uploadedAt: null },
        data: { uploadedAt: new Date() },
      });
      return Result.ok({
        changes:
          count > 0 ? [{ threadId, kind: ThreadChangeKind.Updated }] : [],
        commentId,
        present: (client) => input.present(client, { threadId }),
      });
    },
  });
}

/**
 * Where an attachment the viewer may read is fetched from, after the same
 * org-scoped, served-target check a thread read makes: a confirmed upload's
 * signed URL, or the stored URL of a row a provider sync wrote with no file of
 * ours (PR #8851 review). An upload still pending is `not_found`.
 */
export async function attachmentDownloadUrl(input: {
  viewer: CommentViewer;
  attachmentId: string;
}): Promise<Result<string, CommentErrorCode>> {
  const { organizationId } = input.viewer;
  const owner = await withDb((db) =>
    db.commentAttachment.findFirst({
      where: {
        id: input.attachmentId,
        comment: { deletedAt: null, thread: { organizationId } },
      },
      select: { comment: { select: { threadId: true } } },
    })
  );
  if (!owner) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const { threadId } = owner.comment;
  const located = await resolveThreadCommentTarget({
    organizationId,
    threadId,
  });
  if (!located.ok) {
    return located;
  }
  const { target } = located.value;
  const row = await readServedTarget(target, (db) =>
    db.commentAttachment.findFirst({
      where: {
        id: input.attachmentId,
        comment: {
          deletedAt: null,
          thread: {
            id: threadId,
            organizationId,
            artifactId: target.artifactId,
          },
        },
      },
      select: {
        name: true,
        url: true,
        bucket: true,
        key: true,
        uploadedAt: true,
      },
    })
  );
  if (!row) {
    return Result.err(CommentErrorCode.NotFound);
  }
  if (row.bucket === null) {
    return storedUrl(row.url);
  }
  if (row.key === null || row.uploadedAt === null) {
    return Result.err(CommentErrorCode.NotFound);
  }
  return Result.ok(
    await getSignedDownloadUrlWithDisposition(
      row.key,
      row.name,
      COMMENT_ATTACHMENT_DOWNLOAD_EXPIRY_SECONDS,
      row.bucket
    )
  );
}

export type StoredAttachmentObject = { bucket: string; key: string };

/**
 * PLN-2187 T-2.4: inside a delete's transaction, every attachment row of the
 * deleted comments goes. The objects of ours they named are returned for
 * {@link deleteAttachmentObjects}; url-only rows name none.
 */
export async function removeCommentAttachmentRows(
  tx: TransactionClient,
  commentIds: readonly string[]
): Promise<StoredAttachmentObject[]> {
  if (commentIds.length === 0) {
    return [];
  }
  const where = { commentId: { in: [...commentIds] } };
  const rows = await tx.commentAttachment.findMany({
    where,
    select: { bucket: true, key: true },
  });
  if (rows.length === 0) {
    return [];
  }
  await tx.commentAttachment.deleteMany({ where });
  return rows.flatMap(({ bucket, key }) =>
    bucket && key ? [{ bucket, key }] : []
  );
}

/**
 * After the delete commits. A batch S3 refuses is logged and the delete
 * stands; its objects are left in place under `comment-attachments/` with no
 * row.
 */
export async function deleteAttachmentObjects(
  organizationId: string,
  objects: readonly StoredAttachmentObject[]
): Promise<void> {
  const keysByBucket = new Map<string, string[]>();
  for (const { bucket, key } of objects) {
    const keys = keysByBucket.get(bucket);
    if (keys) {
      keys.push(key);
    } else {
      keysByBucket.set(bucket, [key]);
    }
  }
  for (const [bucket, keys] of keysByBucket) {
    for (
      let start = 0;
      start < keys.length;
      start += S3_BATCH_DELETE_MAX_KEYS
    ) {
      const batch = keys.slice(start, start + S3_BATCH_DELETE_MAX_KEYS);
      try {
        await deleteObjects(batch, bucket);
      } catch (error) {
        log.warn(
          "[comment-attachments] Deleted comment's attachment objects left in place",
          {
            organizationId,
            bucket,
            objectCount: batch.length,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }
  }
}

export function commentAttachmentKey(input: {
  organizationId: string;
  commentId: string;
  attachmentId: string;
}): string {
  return `${COMMENT_ATTACHMENT_KEY_PREFIX}/${input.organizationId}/${input.commentId}/${input.attachmentId}`;
}

/**
 * The Attach grant, then the item, before anything outside the database is
 * touched; the command re-checks both inside its transaction.
 */
async function authorizeAttach<Item>(
  input: AttachActor & { liveState: CommentLiveState },
  locate: (db: TransactionClient) => Promise<Result<Item, CommentErrorCode>>
): Promise<Result<Item, CommentErrorCode>> {
  const available = await isCapabilityAvailable(
    nativeCommentPolicyKey(input.target.artifactType),
    CommentCapability.Attach,
    input.liveState,
    input.policies
  );
  if (!available) {
    return Result.err(CommentErrorCode.CapabilityDenied);
  }
  return withDb((db) => locate(db));
}

/** A live comment on the target, `capability_denied` unless the viewer wrote it. */
async function findAuthoredComment(
  db: TransactionClient,
  input: { target: CommentTarget; viewer: CommentViewer; commentId: string }
): Promise<Result<{ threadId: string }, CommentErrorCode>> {
  const found = await findCommentOnTarget(db, input.target, input.commentId);
  if (!found.ok) {
    return found;
  }
  return found.value.authorId === input.viewer.userId
    ? Result.ok({ threadId: found.value.threadId })
    : Result.err(CommentErrorCode.CapabilityDenied);
}

/** One of our uploads on a live comment the viewer wrote; url-only rows have none. */
async function findAuthoredUpload(
  db: TransactionClient,
  input: { target: CommentTarget; viewer: CommentViewer; attachmentId: string }
): Promise<
  Result<
    {
      threadId: string;
      commentId: string;
      bucket: string;
      key: string;
      uploadedAt: Date | null;
    },
    CommentErrorCode
  >
> {
  const row = await db.commentAttachment.findFirst({
    where: { id: input.attachmentId },
    select: { commentId: true, bucket: true, key: true, uploadedAt: true },
  });
  if (!(row?.bucket && row.key)) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const comment = await findAuthoredComment(db, {
    target: input.target,
    viewer: input.viewer,
    commentId: row.commentId,
  });
  if (!comment.ok) {
    return comment;
  }
  return Result.ok({
    threadId: comment.value.threadId,
    commentId: row.commentId,
    bucket: row.bucket,
    key: row.key,
    uploadedAt: row.uploadedAt,
  });
}

function storedUrl(url: string | null): Result<string, CommentErrorCode> {
  if (url === null || !URL.canParse(url)) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const { protocol } = new URL(url);
  return protocol === "https:"
    ? Result.ok(url)
    : Result.err(CommentErrorCode.NotFound);
}
