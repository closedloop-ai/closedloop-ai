import "server-only";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
  attachmentCacheExpiresAt,
  config,
  isS3NotFound,
  S3_BATCH_DELETE_MAX_KEYS,
  s3Client,
} from "./s3-client";

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
 * Delete up to {@link S3_BATCH_DELETE_MAX_KEYS} objects in a single batched
 * `DeleteObjects` request — far cheaper than one round-trip per key for sweeps
 * that prune many objects at once.
 *
 * Throws if S3 reports any per-key error, so callers surface partial failure
 * (and can retry on the next run) rather than silently leaving objects behind.
 */
export async function deleteObjects(
  keys: string[],
  bucket?: string
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  if (keys.length > S3_BATCH_DELETE_MAX_KEYS) {
    throw new Error(
      `deleteObjects accepts at most ${S3_BATCH_DELETE_MAX_KEYS} keys per call (got ${keys.length})`
    );
  }
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const response = await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: resolvedBucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    })
  );

  const errors = response.Errors ?? [];
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `DeleteObjects failed for ${errors.length} object(s); first: ${first.Key} (${first.Code}: ${first.Message})`
    );
  }
}

/** A single object surfaced by {@link listObjects}. */
export type ListedObject = {
  key: string;
  lastModified?: Date;
  size?: number;
};

/** One page of a paginated {@link listObjects} listing. */
export type ListObjectsPage = {
  objects: ListedObject[];
  /** Token to fetch the next page; `undefined` when the listing is exhausted. */
  nextContinuationToken?: string;
};

/**
 * List a single page of objects under an optional key prefix.
 *
 * Returns each object's key (plus `lastModified`/`size`) and a continuation
 * token when the listing is truncated, so callers can enumerate an entire
 * bucket prefix by looping until `nextContinuationToken` is `undefined`. Used by
 * reconcile sweeps that must walk every stored object to detect orphans.
 */
export async function listObjects(
  options: {
    prefix?: string;
    continuationToken?: string;
    maxKeys?: number;
    bucket?: string;
  } = {}
): Promise<ListObjectsPage> {
  const resolvedBucket = options.bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: resolvedBucket,
      Prefix: options.prefix,
      ContinuationToken: options.continuationToken,
      MaxKeys: options.maxKeys,
    })
  );

  const objects: ListedObject[] = (response.Contents ?? [])
    .filter((obj): obj is { Key: string; LastModified?: Date; Size?: number } =>
      Boolean(obj.Key)
    )
    .map((obj) => ({
      key: obj.Key,
      lastModified: obj.LastModified,
      size: obj.Size,
    }));

  return {
    objects,
    nextContinuationToken: response.IsTruncated
      ? response.NextContinuationToken
      : undefined,
  };
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
    // Bound the browser cache by an ABSOLUTE expiry equal to this signed URL's
    // own deadline, so a cached copy can never outlive the signature that
    // authorized it (a fetch-relative max-age could, on a delayed first fetch).
    ResponseCacheControl: ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
    ResponseExpires: attachmentCacheExpiresAt(expiresIn),
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a presigned URL for uploading an artifact.
 *
 * The presigner signs Content-Length but leaves Content-Type unsigned, so a
 * PUT may store any type. `bindContentType` signs it, and S3 then refuses a
 * PUT whose Content-Type differs from `contentType`.
 */
export async function getSignedUploadUrl(
  key: string,
  contentType = "application/octet-stream",
  expiresIn = 3600,
  bucket?: string,
  contentLength?: number,
  options?: { bindContentType?: boolean }
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

  return await s3GetSignedUrl(s3Client, command, {
    expiresIn,
    ...(options?.bindContentType && {
      signableHeaders: new Set(["content-type"]),
    }),
  });
}

/**
 * Upload document attachment bytes through the server-owned S3 client.
 */
export async function putAttachmentObject(params: {
  key: string;
  body: Uint8Array;
  contentType: string;
  contentLength: number;
  bucket?: string;
}): Promise<void> {
  const resolvedBucket = params.bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  await s3Client.send(
    new PutObjectCommand({
      Body: params.body,
      Bucket: resolvedBucket,
      ContentLength: params.contentLength,
      ContentType: params.contentType,
      Key: params.key,
    })
  );
}

/**
 * Call HeadObject on a document attachment key to confirm the object exists.
 * Returns metadata when found, and `null` ONLY on an authoritative 404 — every
 * other failure (throttle, timeout, credential or permission error, 5xx) throws
 * so callers can distinguish "proven absent" from "could not determine".
 *
 * That distinction is load-bearing for the DB-row reconcile sweep, which
 * deletes rows: a thrown error must never be read as evidence of absence.
 */
export async function headAttachmentObject(
  key: string,
  bucket?: string
): Promise<{ byteSize?: number; etag?: string } | null> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  try {
    const response = await s3Client.send(
      new HeadObjectCommand({ Bucket: resolvedBucket, Key: key })
    );
    return { byteSize: response.ContentLength, etag: response.ETag };
  } catch (error) {
    if (isS3NotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Probe that the attachments bucket itself exists and is reachable. Resolves on
 * success and throws on any failure, including a missing bucket.
 *
 * Required before any sweep that reads a per-object 404 as proof of absence. A
 * HEAD reply has no body for the SDK to parse an error code from, so a deleted
 * or misconfigured bucket can surface on every key as an indistinguishable 404 —
 * i.e. as a whole table of "orphans". One probe per run turns that into a single
 * run-level failure instead of unbounded per-row misclassification.
 */
export async function headAttachmentsBucket(bucket?: string): Promise<void> {
  const resolvedBucket = bucket || config.FILE_ATTACHMENTS_BUCKET;
  if (!resolvedBucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  await s3Client.send(new HeadBucketCommand({ Bucket: resolvedBucket }));
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
    // Bound the browser cache by an ABSOLUTE expiry equal to this signed URL's
    // own deadline, so a cached copy can never outlive the signature that
    // authorized it (a fetch-relative max-age could, on a delayed first fetch).
    ResponseCacheControl: ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
    ResponseExpires: attachmentCacheExpiresAt(expiresIn),
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}

/** One page of a {@link listCommonPrefixes} listing. */
export type CommonPrefixesPage = {
  prefixes: string[];
  /** Token to fetch the next page; `undefined` when the listing is exhausted. */
  nextContinuationToken?: string;
};

/**
 * List one page of the distinct "directories" directly under `prefix`: every
 * key prefix that ends at the next `/`, without listing the objects beneath.
 */
export async function listCommonPrefixes(options: {
  prefix: string;
  bucket: string;
  continuationToken?: string;
  maxKeys?: number;
}): Promise<CommonPrefixesPage> {
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: options.bucket,
      Prefix: options.prefix,
      Delimiter: "/",
      ContinuationToken: options.continuationToken,
      MaxKeys: options.maxKeys,
    })
  );

  return {
    prefixes: (response.CommonPrefixes ?? []).flatMap((entry) =>
      entry.Prefix ? [entry.Prefix] : []
    ),
    nextContinuationToken: response.IsTruncated
      ? response.NextContinuationToken
      : undefined,
  };
}
