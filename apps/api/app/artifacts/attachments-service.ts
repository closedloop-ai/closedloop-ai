import "server-only";

import type { ContextPackAttachment } from "@closedloop-ai/loops-api/context-pack";
import { createId } from "@paralleldrive/cuid2";
import type {
  AttachmentDownloadResponse,
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import { isImageMimeType } from "@repo/api/src/types/attachment";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
} from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Convert a Prisma FileAttachment record to the API FileAttachment type.
 * createdAt is serialized to ISO 8601 string.
 */
function toFileAttachment(record: {
  id: string;
  artifactId: string | null;
  featureId?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  createdById: string;
}): FileAttachment {
  return {
    id: record.id,
    artifactId: record.artifactId ?? "",
    featureId: record.featureId ?? undefined,
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

/**
 * Verify a feature exists and belongs to the given org.
 * Throws "Feature not found" if missing or org-mismatched.
 */
async function requireFeature(
  featureId: string,
  organizationId: string
): Promise<void> {
  const feature = await withDb((db) =>
    db.feature.findUnique({
      where: { id: featureId, organizationId },
      select: { id: true },
    })
  );

  if (!feature) {
    throw new Error("Feature not found");
  }
}

/**
 * Populate inline preview URLs on image attachments in-place.
 * Non-image attachments and S3 errors are silently skipped.
 */
async function populatePreviewUrls(
  records: Array<{ id: string; mimeType: string; key: string; bucket: string }>,
  attachments: FileAttachment[]
): Promise<void> {
  const imageRecords = records.filter((r) => isImageMimeType(r.mimeType));
  if (imageRecords.length === 0) {
    return;
  }

  const previewUrls = await Promise.all(
    imageRecords.map(async (r) => ({
      id: r.id,
      url: await getSignedDownloadUrl(r.key, 3600, r.bucket).catch(
        () => undefined
      ),
    }))
  );
  const urlMap = new Map(
    previewUrls.filter((p) => p.url).map((p) => [p.id, p.url])
  );
  for (const attachment of attachments) {
    const url = urlMap.get(attachment.id);
    if (url) {
      attachment.previewUrl = url;
    }
  }
}

const SIGNED_URL_EXPIRY_SECONDS = 3600;

/** Maximum number of attachments returned by the signed-URL listing methods. */
export const ATTACHMENT_SIGNED_URL_MAX_FILES = 20;

const signedUrlSelect = {
  id: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  key: true,
  bucket: true,
} as const;

type SignedUrlRecord = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  key: string;
  bucket: string;
};

/**
 * Convert attachment records to ContextPackAttachment entries with presigned download URLs.
 */
async function toContextPackAttachments(
  records: SignedUrlRecord[]
): Promise<ContextPackAttachment[]> {
  const results = await Promise.allSettled(
    records.map(async (record) => ({
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      signedUrl: await getSignedDownloadUrl(
        record.key,
        SIGNED_URL_EXPIRY_SECONDS,
        record.bucket
      ),
      signedUrlExpiresAt: new Date(
        Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000
      ).toISOString(),
    }))
  );

  const attachments: ContextPackAttachment[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      attachments.push(result.value);
    } else {
      log.warn(
        "[attachments-service] Failed to sign attachment URL, skipping",
        {
          error: result.reason,
        }
      );
    }
  }
  return attachments;
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
    const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
    }

    await requireArtifact(artifactId, organizationId);

    const key = `attachments/${organizationId}/${artifactId}/${createId()}`;

    // Generate presigned URL first — if this fails, no orphaned DB record is created
    const uploadUrl = await getSignedUploadUrl(
      key,
      mimeType,
      900,
      bucket,
      sizeBytes
    );

    const created = await withDb((db) =>
      db.fileAttachment.create({
        data: {
          artifactId,
          bucket,
          key,
          filename,
          mimeType,
          sizeBytes,
          createdById: userId,
        },
      })
    );

    return { attachmentId: created.id, uploadUrl, key };
  },

  /**
   * Initiate a file upload attached directly to a feature (not an artifact).
   * Used for non-document context attachments (images, video, etc.).
   */
  async requestFeatureUpload(
    featureId: string,
    organizationId: string,
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number
  ): Promise<CreateAttachmentResponse> {
    const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
    }

    const key = `attachments/${organizationId}/features/${featureId}/${createId()}`;

    const uploadUrl = await getSignedUploadUrl(
      key,
      mimeType,
      900,
      bucket,
      sizeBytes
    );

    const created = await withDb((db) =>
      db.fileAttachment.create({
        data: {
          featureId,
          bucket,
          key,
          filename,
          mimeType,
          sizeBytes,
          createdById: userId,
        },
      })
    );

    return { attachmentId: created.id, uploadUrl, key };
  },

  /**
   * List all attachments for a feature (org-scoped, newest first).
   */
  async listByFeature(
    featureId: string,
    organizationId: string
  ): Promise<FileAttachment[]> {
    await requireFeature(featureId, organizationId);

    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: { featureId, feature: { organizationId } },
        orderBy: { createdAt: "desc" },
      })
    );

    const attachments = records.map(toFileAttachment);
    await populatePreviewUrls(records, attachments);
    return attachments;
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
        where: { artifactId, artifact: { organizationId } },
        orderBy: { createdAt: "desc" },
      })
    );

    const attachments = records.map(toFileAttachment);
    await populatePreviewUrls(records, attachments);
    return attachments;
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
      attachment.filename,
      3600,
      attachment.bucket
    );

    return { downloadUrl };
  },

  async getFeatureDownloadUrl(
    featureId: string,
    organizationId: string,
    attachmentId: string
  ): Promise<AttachmentDownloadResponse> {
    await requireFeature(featureId, organizationId);

    const attachment = await withDb((db) =>
      db.fileAttachment.findUnique({
        where: { id: attachmentId, featureId },
      })
    );

    if (!attachment) {
      throw new Error("Attachment not found");
    }

    const downloadUrl = await getSignedDownloadUrlWithDisposition(
      attachment.key,
      attachment.filename,
      3600,
      attachment.bucket
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

    // Use transaction to atomically find + delete, avoiding TOCTOU race
    const attachment = await withDb.tx(async (tx) => {
      const record = await tx.fileAttachment.findUnique({
        where: { id: attachmentId, artifactId },
        select: { bucket: true, key: true },
      });

      if (!record) {
        throw new Error("Attachment not found");
      }

      await tx.fileAttachment.delete({ where: { id: attachmentId } });
      return record;
    });

    try {
      await deleteArtifact(attachment.key, attachment.bucket);
    } catch (error) {
      log.error("[attachments-service] Failed to delete S3 object", {
        key: attachment.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * List all attachments for an artifact with presigned download URLs (for context pack use).
   */
  async listWithSignedUrlsByArtifact(
    artifactId: string,
    organizationId: string
  ): Promise<ContextPackAttachment[]> {
    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: { artifactId, artifact: { organizationId } },
        select: signedUrlSelect,
        orderBy: { createdAt: "desc" },
        take: ATTACHMENT_SIGNED_URL_MAX_FILES,
      })
    );

    return toContextPackAttachments(records);
  },

  /**
   * List all attachments for a feature with presigned download URLs (for context pack use).
   */
  async listWithSignedUrlsByFeature(
    featureId: string,
    organizationId: string
  ): Promise<ContextPackAttachment[]> {
    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: { featureId, feature: { organizationId } },
        select: signedUrlSelect,
        orderBy: { createdAt: "desc" },
        take: ATTACHMENT_SIGNED_URL_MAX_FILES,
      })
    );

    return toContextPackAttachments(records);
  },

  /**
   * Delete a feature attachment from the database and S3.
   */
  async deleteFeatureAttachment(
    featureId: string,
    organizationId: string,
    attachmentId: string
  ): Promise<void> {
    await requireFeature(featureId, organizationId);
    const attachment = await withDb.tx(async (tx) => {
      const record = await tx.fileAttachment.findUnique({
        where: { id: attachmentId, featureId },
        select: { bucket: true, key: true },
      });

      if (!record) {
        throw new Error("Attachment not found");
      }

      await tx.fileAttachment.delete({ where: { id: attachmentId } });
      return record;
    });

    try {
      await deleteArtifact(attachment.key, attachment.bucket);
    } catch (error) {
      log.error("[attachments-service] Failed to delete S3 object", {
        key: attachment.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
