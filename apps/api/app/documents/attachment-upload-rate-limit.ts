import "server-only";

import { randomUUID } from "node:crypto";
import type { AttachmentUploadError as AttachmentUploadErrorType } from "@repo/api/src/types/attachment";
import { AttachmentUploadError as AttachmentUploadErrorContract } from "@repo/api/src/types/attachment";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { getPrismaErrorCode } from "@/lib/db-utils";

/**
 * Durable per-(org, document) abuse limit for direct attachment uploads.
 *
 * Extracted from `attachments-service` so the fixed-window consume/reset/race
 * recovery — which is the only consumer of the `oauth_rate_limits` row — owns
 * its own module alongside the `select` that projects that row.
 */

const ATTACHMENT_UPLOAD_LIMIT_BUCKET = "document_attachment_upload_request";
const ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS = 60;
const ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS = 60 * 60 * 1000;

type AttachmentUploadLimitClient = Pick<TransactionClient, "oAuthRateLimit">;

/**
 * The only three columns the limiter reads. `windowStartedAt` and `updatedAt`
 * are written but never read back, so they stay out of every RETURNING.
 */
const ATTACHMENT_UPLOAD_LIMIT_SELECT = {
  id: true,
  requestCount: true,
  windowExpiresAt: true,
} as const;

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function consumeAttachmentUploadLimit(
  organizationId: string,
  documentId: string
): Promise<ServiceResult<void, AttachmentUploadErrorType>> {
  const now = new Date();
  const subject = `${organizationId}:${documentId}`;
  const windowExpiresAt = new Date(
    now.getTime() + ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS
  );

  const consumeExistingWindow = async (
    db: AttachmentUploadLimitClient,
    record: {
      id: string;
      requestCount: number;
      windowExpiresAt: Date;
    }
  ): Promise<ServiceResult<void, AttachmentUploadErrorType>> => {
    const updateResult = await db.oAuthRateLimit.updateMany({
      where: {
        id: record.id,
        requestCount: { lt: ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS },
        windowExpiresAt: { gt: now },
      },
      data: { requestCount: { increment: 1 } },
    });
    if (updateResult.count === 1) {
      return Result.ok(undefined);
    }

    const latestRecord = await db.oAuthRateLimit.findUnique({
      where: {
        bucket_subject: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject,
        },
      },
      select: ATTACHMENT_UPLOAD_LIMIT_SELECT,
    });
    if (!latestRecord) {
      throw new Error("Attachment upload limiter row disappeared");
    }
    if (latestRecord.windowExpiresAt <= now) {
      return resetExpiredWindow(db, latestRecord);
    }

    return Result.err({
      type: AttachmentUploadErrorContract.RateLimited,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (latestRecord.windowExpiresAt.getTime() - now.getTime()) / 1000
        )
      ),
    });
  };

  const resetExpiredWindow = async (
    db: AttachmentUploadLimitClient,
    record: {
      id: string;
      windowExpiresAt: Date;
    }
  ): Promise<ServiceResult<void, AttachmentUploadErrorType>> => {
    const resetResult = await db.oAuthRateLimit.updateMany({
      where: {
        id: record.id,
        windowExpiresAt: { lte: now },
      },
      data: {
        requestCount: 1,
        windowStartedAt: now,
        windowExpiresAt,
      },
    });
    if (resetResult.count === 1) {
      return Result.ok(undefined);
    }

    const latestRecord = await db.oAuthRateLimit.findUnique({
      where: {
        bucket_subject: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject,
        },
      },
      select: ATTACHMENT_UPLOAD_LIMIT_SELECT,
    });
    if (!latestRecord) {
      throw new Error("Attachment upload limiter row disappeared");
    }
    if (latestRecord.windowExpiresAt <= now) {
      return resetExpiredWindow(db, latestRecord);
    }
    return consumeExistingWindow(db, latestRecord);
  };

  await withDb((db) =>
    cleanupExpiredAttachmentUploadLimitRows(db, subject, now)
  );

  try {
    return await withDb.tx(async (db) => {
      const record = await db.oAuthRateLimit.findUnique({
        where: {
          bucket_subject: {
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
          },
        },
        select: ATTACHMENT_UPLOAD_LIMIT_SELECT,
      });

      if (!record) {
        await db.oAuthRateLimit.create({
          data: {
            id: randomUUID(),
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
            requestCount: 1,
            windowStartedAt: now,
            windowExpiresAt,
          },
          select: { id: true },
        });
        return Result.ok(undefined);
      }

      if (record.windowExpiresAt <= now) {
        return resetExpiredWindow(db, record);
      }
      return consumeExistingWindow(db, record);
    });
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }

    // A failed create can poison Prisma's interactive transaction, so recover
    // from the first-window race after rollback in a fresh transaction.
    return await withDb.tx(async (db) => {
      const racedRecord = await db.oAuthRateLimit.findUnique({
        where: {
          bucket_subject: {
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
          },
        },
        select: ATTACHMENT_UPLOAD_LIMIT_SELECT,
      });
      if (!racedRecord) {
        throw error;
      }
      if (racedRecord.windowExpiresAt <= now) {
        return resetExpiredWindow(db, racedRecord);
      }
      return consumeExistingWindow(db, racedRecord);
    });
  }
}

/**
 * Clears stale limiter rows without blocking the upload path. The active
 * subject is excluded so its expired row can be reset atomically by the caller.
 */
async function cleanupExpiredAttachmentUploadLimitRows(
  db: AttachmentUploadLimitClient,
  subject: string,
  now: Date
): Promise<void> {
  try {
    await db.oAuthRateLimit.deleteMany({
      where: {
        bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
        subject: { not: subject },
        windowExpiresAt: { lt: now },
      },
    });
  } catch (error) {
    log.warn(
      "[attachments-service] Failed to clean up expired attachment upload limiter rows",
      {
        bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
        error: getSafeErrorMessage(error),
      }
    );
  }
}

export {
  ATTACHMENT_UPLOAD_LIMIT_BUCKET,
  ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS,
  ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS,
  consumeAttachmentUploadLimit,
};
