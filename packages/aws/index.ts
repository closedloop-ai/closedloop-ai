import "server-only";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { keys } from "./keys";

const config = keys();

const s3Client = new S3Client({
  region: config.AWS_REGION,
  ...(config.AWS_ACCESS_KEY_ID &&
    config.AWS_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    }),
});

/**
 * Upload content to S3.
 * Returns the S3 key (path) of the uploaded object.
 */
export async function uploadArtifact(
  key: string,
  content: Buffer | string,
  contentType?: string,
  bucket?: string
): Promise<string> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const body = typeof content === "string" ? Buffer.from(content) : content;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: resolvedBucket,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );

  return key;
}

/**
 * Download content from S3.
 */
export async function downloadArtifact(
  key: string,
  bucket?: string
): Promise<Buffer> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: resolvedBucket,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error(`No body returned for key: ${key}`);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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

/**
 * Generate the full S3 URL for an artifact.
 */
export function getArtifactUrl(key: string): string {
  if (!config.FILE_ATTACHMENTS_BUCKET) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  return `https://${config.FILE_ATTACHMENTS_BUCKET}.s3.${config.AWS_REGION}.amazonaws.com/${key}`;
}
