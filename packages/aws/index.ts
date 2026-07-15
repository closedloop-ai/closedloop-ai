import "server-only";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  StorageClass,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAwsCredentials } from "./credentials";
import { keys } from "./keys";

const config = keys();

/**
 * Cache-Control and Expires for an attachment GET response, bounding the browser
 * cache so a cached copy can never outlive the presigned URL that authorized it.
 *
 * Attachment keys embed a unique id (`attachments/{org}/{doc}/{createId()}`), so
 * an object's bytes never change once written. Within a signature's lifetime the
 * browser can serve repeat renders from its own HTTP cache instead of
 * re-downloading from S3. But the cached copy must NOT outlive the signature
 * that authorized it: once the signed URL expires (or the attachment is deleted
 * or access is revoked), a stale cached copy would keep serving bytes the viewer
 * is no longer authorized for.
 *
 * `max-age` is applied by the browser relative to FETCH time, so any
 * fetch-relative lifetime lets a delayed or near-expiry first fetch keep bytes
 * cached past signature expiry. Instead we pin an ABSOLUTE `Expires` equal to
 * the signing instant plus the URL TTL (the exact moment the signature lapses)
 * and send `Cache-Control: private` with no `max-age` or `immutable`, so the
 * absolute `Expires` governs freshness. The browser then caches at most until
 * the signature expires, regardless of when it first fetches, and revalidates
 * (re-authorizing via a freshly signed URL) once the window lapses. `private`
 * keeps shared/CDN caches out since the URLs are presigned per-user.
 *
 * Applied via the GET response-header overrides (`ResponseCacheControl` and
 * `ResponseExpires`), not at upload time: SigV4 treats `cache-control` as
 * unsignable and the presigner does not hoist it into the query string, so a
 * `CacheControl` on a presigned PUT is silently dropped. The GET overrides are
 * honored by S3 and cover every object, including those uploaded before these
 * headers existed.
 */
const ATTACHMENT_DOWNLOAD_CACHE_CONTROL = "private";

function attachmentCacheExpiresAt(expiresInSeconds: number): Date {
  const ttlSeconds = Math.max(0, Math.floor(expiresInSeconds));
  return new Date(Date.now() + ttlSeconds * 1000);
}

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

/** The S3 `DeleteObjects` hard cap on keys per request. */
const S3_BATCH_DELETE_MAX_KEYS = 1000;

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
    // Bound the browser cache by an ABSOLUTE expiry equal to this signed URL's
    // own deadline, so a cached copy can never outlive the signature that
    // authorized it (a fetch-relative max-age could, on a delayed first fetch).
    ResponseCacheControl: ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
    ResponseExpires: attachmentCacheExpiresAt(expiresIn),
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn });
}

// ---------------------------------------------------------------------------
// Session-transcript archive helpers (FEA-2714 / PLN-1287)
//
// The transcript control plane orchestrates S3 copy-append multipart uploads
// and mints presigned URLs; transcript bytes never transit apps/api. All
// helpers below default to the TRANSCRIPTS_BUCKET and use full-object
// CRC64NVME checksums so S3 can verify integrity across UploadPartCopy + the
// client's delta parts (the only checksum algorithm that composes across a
// server-side copy).
// ---------------------------------------------------------------------------

/**
 * Full-object checksum algorithm for transcript objects. CRC64NVME is the
 * owner-chosen algorithm (PLN-1287) — it is the only one S3 can compute as a
 * true full-object checksum across a mix of copied and freshly uploaded parts.
 */
export const TRANSCRIPT_CHECKSUM_ALGORITHM = "CRC64NVME" as const;

/** JSONL transcripts are newline-delimited JSON. */
const TRANSCRIPT_CONTENT_TYPE = "application/x-ndjson";

/** Default presigned-URL TTL for transcript upload URLs (1 hour). */
const TRANSCRIPT_PRESIGN_TTL_SECONDS = 3600;

// Transcripts are cold archive data the moment a session ends — read back rarely
// (if ever) after upload. Tier them like loop state (apps/api/lib/loops/
// loop-state.ts) so cold objects auto-move to cheaper storage with no retrieval
// fees; without this every per-session transcript lands on S3 Standard and
// accrues full cost forever. Auto-tiering is read-path safe and, for the
// copy-append multipart path, adds no retrieval fee to the server-side part
// copy. Set once at multipart-create time (parts inherit it) and hoisted into
// the signed query string on the presigned `fullPut`, so no client change is
// needed for the storage class to apply. Tiering never deletes, so the bucket
// should also carry a lifecycle Expiration rule (provisioned on the bucket, not
// in app code) to bound long-term cost.
// Single source of truth for the INTELLIGENT_TIERING storage class, reused by
// every cold-data upload path (transcripts, catalog zip bundles). Derived from
// the SDK's `StorageClass` enum so the value cannot drift from the SDK or other
// S3 helpers.
export const INTELLIGENT_TIERING_STORAGE_CLASS =
  StorageClass.INTELLIGENT_TIERING;

const TRANSCRIPT_STORAGE_CLASS = INTELLIGENT_TIERING_STORAGE_CLASS;

function resolveTranscriptsBucket(bucket?: string): string {
  const resolved = bucket || config.TRANSCRIPTS_BUCKET;
  if (!resolved) {
    throw new Error("TRANSCRIPTS_BUCKET is not configured");
  }
  return resolved;
}

/**
 * Encode an object key for an `x-amz-copy-source` header: percent-encode each
 * path segment but keep the `/` separators intact, so keys with arbitrary
 * subagent file ids copy correctly.
 */
function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${bucket}/${encodedKey}`;
}

/** A part reported by {@link listTranscriptParts}, ready for resume decisions. */
export type TranscriptUploadedPart = {
  partNumber: number;
  etag: string;
  size?: number;
  checksumCrc64Nvme?: string;
};

/** A part supplied to {@link completeTranscriptMultipartUpload}. */
export type TranscriptCompletedPart = {
  partNumber: number;
  etag: string;
  checksumCrc64Nvme?: string;
};

/**
 * Start a multipart upload for a transcript object with a full-object
 * CRC64NVME checksum. The checksum type is fixed at creation time and cannot
 * change afterwards, so this is where the integrity contract is established.
 */
export async function createTranscriptMultipartUpload(
  key: string,
  options: { bucket?: string } = {}
): Promise<{ uploadId: string }> {
  const resolvedBucket = resolveTranscriptsBucket(options.bucket);
  const response = await s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: resolvedBucket,
      Key: key,
      ContentType: TRANSCRIPT_CONTENT_TYPE,
      ChecksumAlgorithm: TRANSCRIPT_CHECKSUM_ALGORITHM,
      ChecksumType: "FULL_OBJECT",
      StorageClass: TRANSCRIPT_STORAGE_CLASS,
    })
  );
  if (!response.UploadId) {
    throw new Error("CreateMultipartUpload did not return an UploadId");
  }
  return { uploadId: response.UploadId };
}

/**
 * Server-side copy of the current object into part {@link params.partNumber} of
 * a multipart upload — the mechanism that makes append possible (part 1 is the
 * existing object). Guarded by `x-amz-copy-source-if-match`, so a concurrent
 * rewrite of the source fails the copy (412) instead of appending to stale
 * bytes.
 */
export async function copyTranscriptPart(params: {
  key: string;
  uploadId: string;
  partNumber: number;
  sourceKey: string;
  ifMatchEtag: string;
  bucket?: string;
}): Promise<{ partNumber: number; etag: string; checksumCrc64Nvme?: string }> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  const response = await s3Client.send(
    new UploadPartCopyCommand({
      Bucket: resolvedBucket,
      Key: params.key,
      UploadId: params.uploadId,
      PartNumber: params.partNumber,
      CopySource: encodeCopySource(resolvedBucket, params.sourceKey),
      CopySourceIfMatch: params.ifMatchEtag,
    })
  );
  const etag = response.CopyPartResult?.ETag;
  if (!etag) {
    throw new Error("UploadPartCopy did not return an ETag");
  }
  return {
    partNumber: params.partNumber,
    etag,
    checksumCrc64Nvme: response.CopyPartResult?.ChecksumCRC64NVME,
  };
}

/**
 * Presign a single `UploadPart` URL so the desktop can PUT delta bytes for one
 * part directly to S3.
 */
export async function presignTranscriptUploadPart(params: {
  key: string;
  uploadId: string;
  partNumber: number;
  expiresIn?: number;
  bucket?: string;
}): Promise<string> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  const command = new UploadPartCommand({
    Bucket: resolvedBucket,
    Key: params.key,
    UploadId: params.uploadId,
    PartNumber: params.partNumber,
  });
  return await s3GetSignedUrl(s3Client, command, {
    expiresIn: params.expiresIn ?? TRANSCRIPT_PRESIGN_TTL_SECONDS,
  });
}

/** The full-object checksum header the desktop sends on the `fullPut` PUT. */
const S3_CHECKSUM_CRC64NVME_HEADER = "x-amz-checksum-crc64nvme";

/**
 * Presign a single `PutObject` URL for the `fullPut` path (payload fits one
 * part, no server-side copy needed).
 *
 * The desktop sends the full-object checksum as an `x-amz-checksum-crc64nvme`
 * request header, so that exact header must be covered by the presigned
 * signature — S3 rejects any `x-amz-*` header present but unsigned ("There were
 * headers present in the request which were not signed"). Setting only
 * `ChecksumAlgorithm` does NOT achieve this: with no body at presign time the
 * SDK hoists an empty checksum placeholder into the query string and leaves
 * `SignedHeaders: host`, so the client's header is unsigned and S3 403s. Instead
 * we sign the concrete value (`ChecksumCRC64NVME` — which the client already
 * reported in the sync-plan request) and mark the header unhoistable so it stays
 * a signed request header the client matches byte-for-byte. On success S3 stores
 * the object with that full-object checksum, which `complete` reads back via
 * HeadObject (`ChecksumMode: ENABLED`) to verify integrity.
 */
export async function presignTranscriptPutObject(params: {
  key: string;
  checksumCrc64Nvme: string;
  expiresIn?: number;
  bucket?: string;
}): Promise<string> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  const command = new PutObjectCommand({
    Bucket: resolvedBucket,
    Key: params.key,
    ContentType: TRANSCRIPT_CONTENT_TYPE,
    // Sign the concrete full-object checksum (not just the algorithm) so the
    // desktop's `x-amz-checksum-crc64nvme` header is covered by the signature.
    ChecksumCRC64NVME: params.checksumCrc64Nvme,
    // Hoisted into the signed query string by the presigner, so the desktop
    // `fullPut` applies the storage class with no header change.
    StorageClass: TRANSCRIPT_STORAGE_CLASS,
  });
  return await s3GetSignedUrl(s3Client, command, {
    expiresIn: params.expiresIn ?? TRANSCRIPT_PRESIGN_TTL_SECONDS,
    // Keep the checksum header a signed request header instead of hoisting it
    // into the query string, so it matches the header the desktop client sends.
    unhoistableHeaders: new Set([S3_CHECKSUM_CRC64NVME_HEADER]),
  });
}

/**
 * List the already-uploaded parts of an in-flight multipart upload, following
 * pagination. Used to resume a crashed upload by re-signing only the missing
 * parts (recovery invariant 4).
 */
export async function listTranscriptParts(params: {
  key: string;
  uploadId: string;
  bucket?: string;
}): Promise<TranscriptUploadedPart[]> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  const parts: TranscriptUploadedPart[] = [];
  let partNumberMarker: string | undefined;
  do {
    const response = await s3Client.send(
      new ListPartsCommand({
        Bucket: resolvedBucket,
        Key: params.key,
        UploadId: params.uploadId,
        PartNumberMarker: partNumberMarker,
      })
    );
    for (const part of response.Parts ?? []) {
      if (part.PartNumber != null && part.ETag) {
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
          checksumCrc64Nvme: part.ChecksumCRC64NVME,
        });
      }
    }
    partNumberMarker = response.IsTruncated
      ? response.NextPartNumberMarker
      : undefined;
  } while (partNumberMarker);
  return parts;
}

/**
 * Finalize a transcript multipart upload. Supplying `checksumCrc64Nvme` makes
 * S3 verify the full-object checksum server-side (BadDigest on mismatch);
 * supplying `ifMatchEtag` guards against a concurrent overwrite of an existing
 * object (412 on mismatch — a stale append).
 */
export async function completeTranscriptMultipartUpload(params: {
  key: string;
  uploadId: string;
  parts: TranscriptCompletedPart[];
  checksumCrc64Nvme?: string;
  ifMatchEtag?: string;
  bucket?: string;
}): Promise<{ etag?: string; checksumCrc64Nvme?: string }> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  const orderedParts = [...params.parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((part) => ({
      PartNumber: part.partNumber,
      ETag: part.etag,
      ...(part.checksumCrc64Nvme
        ? { ChecksumCRC64NVME: part.checksumCrc64Nvme }
        : {}),
    }));
  const response = await s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: resolvedBucket,
      Key: params.key,
      UploadId: params.uploadId,
      MultipartUpload: { Parts: orderedParts },
      ...(params.checksumCrc64Nvme
        ? {
            ChecksumCRC64NVME: params.checksumCrc64Nvme,
            ChecksumType: "FULL_OBJECT" as const,
          }
        : {}),
      ...(params.ifMatchEtag ? { IfMatch: params.ifMatchEtag } : {}),
    })
  );
  return {
    etag: response.ETag,
    checksumCrc64Nvme: response.ChecksumCRC64NVME,
  };
}

/**
 * Read an object's byte size + full-object checksum for post-upload
 * verification. Returns `null` when the object does not exist (404) so callers
 * can branch on absence without a try/catch.
 */
export async function headTranscriptObject(
  key: string,
  bucket?: string
): Promise<{
  byteSize?: number;
  etag?: string;
  checksumCrc64Nvme?: string;
} | null> {
  const resolvedBucket = resolveTranscriptsBucket(bucket);
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: resolvedBucket,
        Key: key,
        ChecksumMode: "ENABLED",
      })
    );
    return {
      byteSize: response.ContentLength,
      etag: response.ETag,
      checksumCrc64Nvme: response.ChecksumCRC64NVME,
    };
  } catch (error) {
    if (isS3NotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Abort an in-flight multipart upload (stale or superseded). The bucket's
 * 7-day `AbortIncompleteMultipartUpload` lifecycle rule is the backstop, but
 * aborting eagerly frees the invisible part storage immediately.
 */
export async function abortTranscriptMultipartUpload(params: {
  key: string;
  uploadId: string;
  bucket?: string;
}): Promise<void> {
  const resolvedBucket = resolveTranscriptsBucket(params.bucket);
  await s3Client.send(
    new AbortMultipartUploadCommand({
      Bucket: resolvedBucket,
      Key: params.key,
      UploadId: params.uploadId,
    })
  );
}

/**
 * Delete transcript objects from the transcripts bucket, batching into
 * `DeleteObjects` requests of at most {@link S3_BATCH_DELETE_MAX_KEYS} keys
 * (S3's per-request cap). Used when the owning entity (e.g. a compute target)
 * is deleted so the raw JSONL bytes do not outlive their DB metadata.
 *
 * All batches are attempted even when earlier batches fail. Any per-key S3
 * errors — plus keys in batches that could not be attempted due to a thrown
 * network/request error — are accumulated and reported in a single throw at the
 * end, so callers see the full count of undeleted objects and can surface them
 * for retry or observability rather than silently leaving them behind. Empty
 * input is a no-op.
 */
export async function deleteTranscriptObjects(
  keys: string[],
  bucket?: string
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const resolvedBucket = resolveTranscriptsBucket(bucket);
  const failedKeys: string[] = [];
  for (let i = 0; i < keys.length; i += S3_BATCH_DELETE_MAX_KEYS) {
    const chunk = keys.slice(i, i + S3_BATCH_DELETE_MAX_KEYS);
    try {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: resolvedBucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        })
      );
      for (const err of response.Errors ?? []) {
        if (err.Key) {
          failedKeys.push(err.Key);
        }
      }
    } catch {
      // The entire batch request failed (network error, auth error, etc.).
      // Treat every key in the chunk as undeleted and continue with remaining
      // batches so one bad batch does not abandon the rest.
      failedKeys.push(...chunk);
    }
  }
  if (failedKeys.length > 0) {
    throw new Error(
      `DeleteObjects failed for ${failedKeys.length} transcript object(s) out of ${keys.length} total`
    );
  }
}

/**
 * Mint a short-lived presigned GET URL for reading a transcript object (the
 * read path, FEA-2716). The URL is generated per authorized request and never
 * stored; its TTL bounds how long the signature is valid. `expiresIn` is
 * required — the canonical value lives in the shared contract
 * (`TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS` in `@repo/api`), so this helper does
 * not re-declare it. Defaults to the TRANSCRIPTS_BUCKET so the read route never
 * targets the attachments bucket.
 */
export async function getSignedTranscriptDownloadUrl(
  key: string,
  options: { expiresIn: number; bucket?: string }
): Promise<string> {
  const resolvedBucket = resolveTranscriptsBucket(options.bucket);
  const command = new GetObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
    // Bound the browser cache to this URL's own expiry so a cached transcript
    // copy can never outlive the signature that authorized it (transcripts are
    // high-sensitivity — source, secrets, prompts).
    ResponseCacheControl: ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
    ResponseExpires: attachmentCacheExpiresAt(options.expiresIn),
  });
  return await s3GetSignedUrl(s3Client, command, {
    expiresIn: options.expiresIn,
  });
}

// ---------------------------------------------------------------------------
// Catalog / plugin-distribution asset helpers (FEA-2923 batch 3)
//
// Assets for CatalogItems (zip bundles + logo images) live in a dedicated
// PLUGIN_STORE_BUCKET under org-scoped key prefixes so they are isolated from
// document attachments and transcripts.
// ---------------------------------------------------------------------------

/**
 * Kind of catalog asset stored in S3. Determines the filename segment used
 * inside the org-scoped key prefix.
 *
 * - `zip` — distributable bundle (`.zip`).
 * - `logo` — display image (any image MIME type, typically PNG/SVG).
 * - `files` — general supplementary files archive.
 */
export type CatalogAssetKind = "zip" | "logo" | "files";

/**
 * Return the S3 key for a CatalogItem asset under the org-scoped prefix
 * `org/{orgId}/catalog/{itemId}/{kind}`.
 *
 * The key is deterministic given (orgId, itemId, kind): storing an updated
 * asset overwrites the previous version in place. This matches the
 * document-attachment pattern where keys embed a unique id and never change.
 * Callers should confirm via HeadObject before recording the key in DB
 * (see `POST /catalog/confirm`).
 */
export function catalogAssetKey(
  orgId: string,
  itemId: string,
  kind: CatalogAssetKind
): string {
  return `org/${orgId}/catalog/${itemId}/${kind}`;
}

/**
 * Resolve the PLUGIN_STORE_BUCKET name; throws at call time when the
 * environment variable is not set (mirrors `resolveTranscriptsBucket`).
 */
export function resolveCatalogBucket(bucket?: string): string {
  const resolved = bucket || config.PLUGIN_STORE_BUCKET;
  if (!resolved) {
    throw new Error("PLUGIN_STORE_BUCKET is not configured");
  }
  return resolved;
}

/**
 * Generate a presigned S3 PUT URL for a catalog asset. Enforces a file-size
 * cap via `ContentLength` on the `PutObject` command so S3 rejects uploads
 * that exceed the cap server-side. TTL defaults to 15 minutes (900 s) —
 * callers must download/upload within this window.
 *
 * @param orgId - Organization UUID (used in the org-scoped key prefix).
 * @param itemId - CatalogItem UUID.
 * @param kind - Asset kind (`zip` | `logo` | `files`).
 * @param contentType - MIME type of the asset (e.g. `application/zip`).
 * @param contentLength - Exact byte size the S3 PUT must match.
 * @param expiresIn - URL TTL in seconds (default 900 = 15 min).
 * @param bucket - Override bucket name (defaults to PLUGIN_STORE_BUCKET).
 */
export async function getCatalogAssetUploadUrl(params: {
  orgId: string;
  itemId: string;
  kind: CatalogAssetKind;
  contentType: string;
  contentLength: number;
  expiresIn?: number;
  bucket?: string;
}): Promise<{ uploadUrl: string; key: string }> {
  const resolvedBucket = resolveCatalogBucket(params.bucket);
  const key = catalogAssetKey(params.orgId, params.itemId, params.kind);
  const command = new PutObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
    // Zip bundles are cold data — each is downloaded once per compute target
    // during a distribution install — so tier them to INTELLIGENT_TIERING to
    // auto-tier to cheaper storage. Logos are hot-read on every catalog listing,
    // so they stay on S3 Standard (the default, applied by omitting StorageClass).
    // The class is hoisted into the signed query string by the presigner, so the
    // uploader applies it with no header change.
    ...(params.kind === "zip"
      ? { StorageClass: INTELLIGENT_TIERING_STORAGE_CLASS }
      : {}),
  });
  const uploadUrl = await s3GetSignedUrl(s3Client, command, {
    expiresIn: params.expiresIn ?? 900,
  });
  return { uploadUrl, key };
}

/**
 * Call HeadObject on a catalog asset key to confirm it exists.
 * Returns metadata (byteSize, etag) when found, or `null` when the object
 * does not exist (404).
 */
export async function headCatalogAsset(
  key: string,
  bucket?: string
): Promise<{ byteSize?: number; etag?: string } | null> {
  const resolvedBucket = resolveCatalogBucket(bucket);
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
 * Generate a short-lived presigned GET URL for a catalog asset (logo or zip).
 * TTL defaults to 900 s (15 min) — sufficient for the desktop to download the
 * asset and for a browser to display a logo.
 */
export async function getCatalogAssetDownloadUrl(
  key: string,
  options: { expiresIn?: number; bucket?: string } = {}
): Promise<string> {
  const resolvedBucket = resolveCatalogBucket(options.bucket);
  const command = new GetObjectCommand({
    Bucket: resolvedBucket,
    Key: key,
    ResponseCacheControl: ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
    ResponseExpires: attachmentCacheExpiresAt(options.expiresIn ?? 900),
  });
  return await s3GetSignedUrl(s3Client, command, {
    expiresIn: options.expiresIn ?? 900,
  });
}

/**
 * Hard cap on the raw byte size of a catalog asset we will pull into memory
 * server-side. Matches the 50 MB compressed upload cap enforced at upload-intent
 * (`ZIP_MAX_BYTES` in the catalog service); the actual stored object should
 * never exceed it, so a larger object means the upload-intent cap was bypassed
 * (e.g. a direct S3 PUT) and we refuse to buffer it. The decompressed footprint
 * of a zip is bounded separately in `parsePackZip`.
 */
export const CATALOG_ASSET_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Thrown when a catalog asset's raw byte size exceeds
 * `CATALOG_ASSET_MAX_BYTES`. The caller maps this to a 4xx rather than
 * buffering an unbounded object and risking an OOM.
 */
export class CatalogAssetTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetTooLargeError";
  }
}

/**
 * Download a catalog asset's raw bytes server-side (e.g. to parse an uploaded
 * Pack zip). Direct GetObject — no presign round-trip.
 *
 * The object size is bounded at `CATALOG_ASSET_MAX_BYTES`: the response's
 * declared `ContentLength` is checked before streaming (cheap early reject),
 * and the actual downloaded buffer length is re-checked afterwards rather than
 * trusting either the client-declared upload size or the S3-reported length.
 */
export async function getCatalogAssetBytes(
  key: string,
  bucket?: string
): Promise<Buffer> {
  const resolvedBucket = resolveCatalogBucket(bucket);
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: resolvedBucket, Key: key })
  );

  if (
    typeof response.ContentLength === "number" &&
    response.ContentLength > CATALOG_ASSET_MAX_BYTES
  ) {
    throw new CatalogAssetTooLargeError(
      `Catalog asset "${key}" is ${response.ContentLength} bytes, over the ` +
        `${CATALOG_ASSET_MAX_BYTES}-byte cap.`
    );
  }

  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error("Empty catalog asset body");
  }

  if (bytes.length > CATALOG_ASSET_MAX_BYTES) {
    throw new CatalogAssetTooLargeError(
      `Catalog asset "${key}" is ${bytes.length} bytes, over the ` +
        `${CATALOG_ASSET_MAX_BYTES}-byte cap.`
    );
  }

  return Buffer.from(bytes);
}

/** True when an S3 error is a 404 / NotFound (missing object). */
function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
