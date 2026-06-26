import "server-only";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAwsCredentials } from "./credentials";
import { keys } from "./keys";

const config = keys();

function resolveCredentials(): S3ClientConfig["credentials"] {
  // Explicit access keys take precedence (local dev)
  if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    };
  }
  // Vercel OIDC or default credential chain (ECS task role, etc.)
  return getAwsCredentials();
}

const s3Client = new S3Client({
  region: config.AWS_REGION,
  credentials: resolveCredentials(),
});

/**
 * Delete an object from S3.
 */
export async function deleteArtifact(
  key: string,
  bucket?: string
): Promise<void> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: resolvedBucket,
      Key: key,
    })
  );
}

/**
 * Generate a presigned URL for downloading an artifact.
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresIn = 3600,
  bucket?: string
): Promise<string> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a presigned URL for uploading an artifact.
 */
export async function getSignedUploadUrl(
  key: string,
  contentType = "application/octet-stream",
  expiresIn = 3600,
  bucket?: string,
  contentLength?: number
): Promise<string> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const command = new PutObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
    ContentType: contentType,
    ...(contentLength != null && { ContentLength: contentLength }),
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a presigned URL for downloading a file with a forced download disposition.
 * The browser will prompt the user to save the file using the provided filename.
 */
export async function getSignedDownloadUrlWithDisposition(
  key: string,
  filename: string,
  expiresIn = 3600,
  bucket?: string
): Promise<string> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  // Sanitize filename to prevent header injection via quotes, backslashes, or CRLF
  const safeName = filename.replaceAll(/["\\\r\n]/g, "");

  const command = new GetObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}
