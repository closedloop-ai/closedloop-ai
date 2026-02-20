import "server-only";

import { createId } from "@paralleldrive/cuid2";
import type {
  AttachmentDownloadResponse,
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import {
  deleteArtifact,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
} from "@repo/aws";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Convert a Prisma FileAttachment record to the API FileAttachment type.
 * createdAt is serialized to ISO 8601 string.
 */
function toFileAttachment(record: {
  id: string;
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  createdById: string;
}): FileAttachment {
  return {
    id: record.id,
    artifactId: record.artifactId,
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
    createdById: record.createdById,
  };
}

/**
 * Verify an artifact exists and belongs to the given org.
 * Throws "Artifact not found" if missing or org-mismatched.
 */
async function requireArtifact(
  artifactId: string,
  organizationId: string
): Promise<void> {
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { id: artifactId, organizationId },
      select: { id: true },
    })
  );

  if (!artifact) {
    throw new Error("Artifact not found");
  }
}

export const attachmentsService = {
  /**
   * Initiate a file upload for an artifact.
   * Returns a presigned S3 upload URL and the attachment record ID.
   * The caller should PUT the file directly to the upload URL.
   */
  async requestUpload(
    artifactId: string,
    organizationId: string,
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number
  ): Promise<CreateAttachmentResponse> {
    await requireArtifact(artifactId, organizationId);

    const key = `attachments/${artifactId}/${createId()}`;

    const created = await withDb((db) =>
      db.fileAttachment.create({
        data: {
          artifactId,
          bucket: process.env.S3_BUCKET_NAME ?? "",
          key,
          filename,
          mimeType,
          sizeBytes,
          createdById: userId,
        },
      })
    );

    const uploadUrl = await getSignedUploadUrl(key, mimeType, 900);

    return { attachmentId: created.id, uploadUrl, key };
  },

  /**
   * List all attachments for an artifact (org-scoped, newest first).
   */
  async listByArtifact(
    artifactId: string,
    organizationId: string
  ): Promise<FileAttachment[]> {
    await requireArtifact(artifactId, organizationId);

    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: { artifactId },
        orderBy: { createdAt: "desc" },
      })
    );

    return records.map(toFileAttachment);
  },

  /**
   * Generate a presigned download URL for an attachment.
   * Forces browser download via Content-Disposition: attachment.
   */
  async getDownloadUrl(
    artifactId: string,
    organizationId: string,
    attachmentId: string
  ): Promise<AttachmentDownloadResponse> {
    await requireArtifact(artifactId, organizationId);

    const attachment = await withDb((db) =>
      db.fileAttachment.findUnique({
        where: { id: attachmentId, artifactId },
      })
    );

    if (!attachment) {
      throw new Error("Attachment not found");
    }

    const downloadUrl = await getSignedDownloadUrlWithDisposition(
      attachment.key,
      attachment.filename
    );

    return { downloadUrl };
  },

  /**
   * Delete an attachment from the database and S3.
   * DB record is deleted first; S3 deletion failure is logged but not re-thrown.
   */
  async deleteAttachment(
    artifactId: string,
    organizationId: string,
    attachmentId: string
  ): Promise<void> {
    await requireArtifact(artifactId, organizationId);

    const attachment = await withDb((db) =>
      db.fileAttachment.findUnique({
        where: { id: attachmentId, artifactId },
      })
    );

    if (!attachment) {
      throw new Error("Attachment not found");
    }

    await withDb((db) =>
      db.fileAttachment.delete({ where: { id: attachmentId } })
    );

    try {
      await deleteArtifact(attachment.key);
    } catch (error) {
      log.error("[attachments-service] Failed to delete S3 object", {
        key: attachment.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
