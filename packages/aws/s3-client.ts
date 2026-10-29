import "server-only";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { S3Client, StorageClass } from "@aws-sdk/client-s3";
import { getAwsCredentials } from "./credentials";
import { keys } from "./keys";
import { boundedRequestHandler, STREAMING_BOUNDS } from "./request-handler";
import type { S3KeyspacePrefixResolver } from "./s3-keyspace-prefix";
import {
  installKeyspacePrefixMiddleware,
  setKeyspacePrefixResolver,
} from "./s3-keyspace-prefix";

const env = keys();

/**
 * Bucket names only. The parsed env also carries plaintext AWS credentials, and
 * splitting this module out must not hand every sibling a second path to them
 * (`@repo/aws/keys` is the one that already exists). Credentials stay private to
 * `resolveCredentials` below.
 */
export const config = {
  FILE_ATTACHMENTS_BUCKET: env.FILE_ATTACHMENTS_BUCKET,
  TRANSCRIPTS_BUCKET: env.TRANSCRIPTS_BUCKET,
  PLUGIN_STORE_BUCKET: env.PLUGIN_STORE_BUCKET,
} as const;

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
export const ATTACHMENT_DOWNLOAD_CACHE_CONTROL = "private";

export function attachmentCacheExpiresAt(expiresInSeconds: number): Date {
  const ttlSeconds = Math.max(0, Math.floor(expiresInSeconds));
  return new Date(Date.now() + ttlSeconds * 1000);
}

function resolveCredentials(): S3ClientConfig["credentials"] {
  // Explicit access keys take precedence (local dev)
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    };
  }
  // Vercel OIDC or default credential chain (ECS task role, etc.)
  return getAwsCredentials();
}

export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: resolveCredentials(),
  // Attachment/transcript/catalog reads and writes stream object bodies, so
  // this client takes the streaming (inactivity) bound.
  requestHandler: boundedRequestHandler(STREAMING_BOUNDS),
  ...endpointOverride(env.AWS_S3_ENDPOINT),
});

// ISS-12135: installed on every copy of this module, so a route bundle's client
// applies the resolver its instrumentation entry set. With no resolver set the
// middleware passes every key through unchanged.
installKeyspacePrefixMiddleware(s3Client);

/** The S3 `DeleteObjects` hard cap on keys per request. */
export const S3_BATCH_DELETE_MAX_KEYS = 1000;

// Single source of truth for the INTELLIGENT_TIERING storage class, reused by
// every cold-data upload path (transcripts, catalog zip bundles). Derived from
// the SDK's `StorageClass` enum so the value cannot drift from the SDK or other
// S3 helpers.
export const INTELLIGENT_TIERING_STORAGE_CLASS =
  StorageClass.INTELLIGENT_TIERING;

/**
 * ISS-12043: the storage-class field for transcript uploads. A local
 * S3-compatible store (`AWS_S3_ENDPOINT`, the vibe environment's MinIO)
 * rejects multipart uploads that name INTELLIGENT_TIERING, so the class is
 * omitted there; with no endpoint override (every deployed environment) it is
 * always INTELLIGENT_TIERING.
 */
export const TRANSCRIPT_STORAGE_CLASS_FIELDS: {
  readonly StorageClass?: StorageClass;
} =
  env.AWS_S3_ENDPOINT === undefined
    ? { StorageClass: INTELLIGENT_TIERING_STORAGE_CLASS }
    : {};

/**
 * S3 error code for a missing bucket. It is reported with
 * `$metadata.httpStatusCode === 404`, exactly like a missing key, so a
 * status-only test reads a deleted, renamed, or misconfigured bucket as "every
 * object in it is absent". For a caller that deletes on absence that turns one
 * systemic failure into unbounded data loss, so it is discriminated by CODE
 * before the status is consulted.
 */
const S3_NO_SUCH_BUCKET_CODE = "NoSuchBucket";

/**
 * True when an S3 error is an authoritative 404 for the requested KEY.
 *
 * A bucket-level 404 is excluded: it says nothing about the key. Note that an
 * S3 HEAD reply carries no body for the SDK to parse an error `Code` from, so a
 * missing bucket can still surface as a bare `NotFound` — the code check here is
 * a backstop, not the primary defense. Callers that act destructively on
 * absence must additionally probe the bucket once per run
 * (`headAttachmentsBucket` in ./index) so a systemic failure fails the run
 * outright.
 */
export function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    name?: string;
    // Wire-format key from the S3 error body; not renamed to camelCase.
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (
    candidate.name === S3_NO_SUCH_BUCKET_CODE ||
    candidate.Code === S3_NO_SUCH_BUCKET_CODE
  ) {
    return false;
  }
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * ISS-12017: the client config for a local S3-compatible store, and nothing at
 * all when none is configured, so the AWS config stays exactly as it was. A
 * local store answers every bucket on one host and port, with no per-bucket
 * DNS name, so requests and presigned URLs use path-style addressing.
 */
function endpointOverride(
  endpoint: string | undefined
): Pick<S3ClientConfig, "endpoint" | "forcePathStyle"> {
  if (endpoint === undefined) {
    return {};
  }
  return { endpoint, forcePathStyle: true };
}

/**
 * ISS-12056: moves every key the shared client sends (presigned URLs included)
 * under the prefix the resolver returns, and strips it from listed keys. A
 * runtime that never sets a resolver (stage, production, every non-vibe
 * preview) sends exactly what it sent before. `null` restores unprefixed keys.
 */
export function setS3KeyspacePrefixResolver(
  resolver: S3KeyspacePrefixResolver | null
): void {
  setKeyspacePrefixResolver(resolver);
}
