import "server-only";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ATTACHMENT_DOWNLOAD_CACHE_CONTROL,
  attachmentCacheExpiresAt,
  config,
  INTELLIGENT_TIERING_STORAGE_CLASS,
  isS3NotFound,
  s3Client,
} from "./s3-client";

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
 * environment variable is not set (mirrors `resolveTranscriptsBucket` in
 * ./transcript-storage).
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
