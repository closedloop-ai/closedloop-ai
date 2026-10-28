import "server-only";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
  attachmentCacheExpiresAt,
  config,
  isS3NotFound,
  S3_BATCH_DELETE_MAX_KEYS,
  s3Client,
  TRANSCRIPT_STORAGE_CLASS_FIELDS,
} from "./s3-client";

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
export const TRANSCRIPT_CONTENT_TYPE = "application/x-ndjson";

/** Default presigned-URL TTL for transcript upload URLs (1 hour). */
const TRANSCRIPT_PRESIGN_TTL_SECONDS = 3600;

// Transcripts are cold archive data the moment a session ends — read back rarely
// (if ever) after upload. Tier them so cold objects auto-move to cheaper
// storage with no retrieval fees; without this every per-session transcript
// lands on S3 Standard and accrues full cost forever. Auto-tiering is
// read-path safe and, for the
// copy-append multipart path, adds no retrieval fee to the server-side part
// copy. Set once at multipart-create time (parts inherit it) and hoisted into
// the signed query string on the presigned `fullPut`, so no client change is
// needed for the storage class to apply. Tiering never deletes, so the bucket
// should also carry a lifecycle Expiration rule (provisioned on the bucket, not
// in app code) to bound long-term cost. A local S3-compatible store gets no
// storage class at all (`TRANSCRIPT_STORAGE_CLASS_FIELDS`).

function resolveTranscriptsBucket(bucket?: string): string {
  const resolved = bucket || config.TRANSCRIPTS_BUCKET;
  if (!resolved) {
    throw new TranscriptStorageNotConfiguredError(
      "TRANSCRIPTS_BUCKET is not configured"
    );
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
      ...TRANSCRIPT_STORAGE_CLASS_FIELDS,
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
export const S3_CHECKSUM_CRC64NVME_HEADER = "x-amz-checksum-crc64nvme";

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
    ...TRANSCRIPT_STORAGE_CLASS_FIELDS,
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

/**
 * Download the FIRST `maxBytes` bytes of a transcript object server-side via a
 * ranged GET (FEA-3930). Transcript archives can be tens of GB, so the search
 * indexer must never buffer the whole object — it only needs a bounded prefix
 * of the JSONL to build a capped searchable body. The `Range` header caps S3
 * egress and memory to the requested window; a smaller object simply returns
 * fewer bytes. Returns null for a missing object (deleted/not-yet-uploaded) so
 * the caller can skip indexing rather than 500.
 */
export async function getTranscriptObjectBytesRange(
  key: string,
  maxBytes: number,
  bucket?: string
): Promise<Buffer | null> {
  const resolvedBucket = resolveTranscriptsBucket(bucket);
  // Range is inclusive of both ends and 0-based, so the last byte index is
  // maxBytes - 1. Floor at a single byte so a zero/negative cap cannot request
  // an invalid range.
  const lastByte = Math.max(1, Math.floor(maxBytes)) - 1;
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolvedBucket,
        Key: key,
        Range: `bytes=0-${lastByte}`,
      })
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      return null;
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (isS3NotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Thrown by {@link resolveTranscriptsBucket} when `TRANSCRIPTS_BUCKET` is
 * unset. PRD-699 Appendix A classifies this as ENVIRONMENTAL rather than
 * row-attributable — a retry could plausibly succeed with no change to what a
 * caller sends, once an admin sets the variable — so callers must route it to
 * the long-backoff 503 family, never a 4xx. The discriminant field lets a
 * classifier read a contract instead of matching on the message string, which
 * is free to change for humans reading logs.
 */
export class TranscriptStorageNotConfiguredError extends Error {
  readonly transcriptStorageNotConfigured = true as const;

  constructor(message: string) {
    super(message);
    this.name = "TranscriptStorageNotConfiguredError";
  }
}
