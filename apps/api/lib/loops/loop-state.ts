import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { INTELLIGENT_TIERING_STORAGE_CLASS } from "@repo/aws";
import { getAwsCredentials } from "@repo/aws/credentials";
import type { ContextPack } from "@closedloop-ai/loops-api/context-pack";
import { log } from "@repo/observability/log";

/**
 * S3 key structure for Loop state:
 * {organizationId}/loops/{loopId}/
 *   ├── context-pack.json         (input: assembled by backend, born pre-scrubbed — never holds secrets)
 *   ├── context-pack.secrets.json (input: ephemeral secrets sidecar read once by the runner, then deleted)
 *   ├── conversation.json    (output: full Claude Code conversation history)
 *   ├── metadata.json        (output: loop execution metadata)
 *   ├── logs/
 *   │   └── conversation.jsonl  (output: line-by-line event log)
 *   └── work/                (output: work directory snapshot)
 */

const LOOP_STATE_PREFIX = (orgId: string, loopId: string, runId: string) =>
  `${orgId}/loops/${loopId}/${runId}`;

/**
 * Loop-level S3 prefix covering EVERY run of a loop: `{orgId}/loops/{loopId}/`.
 * Unlike {@link getStateKeyPrefix} (which appends a per-run id), this is the
 * parent under which all of a loop's run-state objects live, so a single sweep
 * over this prefix removes the loop's entire S3 footprint regardless of how many
 * times it was resumed. Used by the loop-state retention cleanup.
 */
export function getLoopPrefix(orgId: string, loopId: string): string {
  return `${orgId}/loops/${loopId}/`;
}

// Lazy-init S3 client targeting the dedicated loop-state bucket.
// The ECS harness reads from S3_BUCKET (set in task definition), so the
// backend must write to the same bucket via LOOP_STATE_BUCKET.
let _s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3Client) {
    _s3Client = new S3Client({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: getAwsCredentials(),
    });
  }
  return _s3Client;
}

// INFRA NOTE (LOOP_STATE_BUCKET lifecycle): writers here set
// StorageClass: "INTELLIGENT_TIERING" so cold loop state auto-tiers to cheaper
// storage with no retrieval fees, but tiering alone never deletes. To bound
// long-term cost, the bucket should also carry a lifecycle rule that expires
// (deletes) loop-state objects after they are no longer needed — e.g. an
// Expiration rule of ~90 days on the bucket/prefix, plus an
// AbortIncompleteMultipartUpload rule to reap stalled harness uploads. This is
// provisioned on the bucket itself (Terraform/console), not in app code.
function requireBucket(): string {
  const bucket = process.env.LOOP_STATE_BUCKET;
  if (!bucket) {
    throw new Error(
      "LOOP_STATE_BUCKET is not configured. " +
        "This must point to the dedicated loop-state S3 bucket."
    );
  }
  return bucket;
}

// S3 storage class for all loop-state writes (backend `putObject` and harness
// presigned uploads via `generateUploadUrl`). Intelligent-Tiering auto-moves
// cold loop-run state to cheaper storage with no retrieval fees and is
// read-path safe (getObject does not inspect storage class). Reuses the shared
// INTELLIGENT_TIERING_STORAGE_CLASS from @repo/aws (derived from the SDK's
// StorageClass enum) so both write paths — and their tests — stay in sync with
// every other cold-data upload path.

async function putObject(
  key: string,
  body: string,
  contentType: string,
  // Compression is opt-in per call rather than unconditional: this helper is
  // generic object storage, and an object is only safe to gzip if every reader
  // honors ContentEncoding. getObject (below), the harness SDK fallback, and
  // presigned-URL HTTP readers all do, so context-pack writers pass `gzip:true`;
  // any future caller must confirm its read path before opting in.
  { gzip = false }: { gzip?: boolean } = {}
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: gzip ? gzipSync(Buffer.from(body)) : Buffer.from(body),
      ContentType: contentType,
      // Advertise gzip via ContentEncoding so readers transparently decompress.
      ...(gzip ? { ContentEncoding: "gzip" } : {}),
      // Loop run-state (context-pack, metadata, scrub re-write) is read back
      // only during the active run and almost never afterward. Intelligent
      // tiering auto-moves cold objects to cheaper storage with no retrieval
      // fees, and is read-path safe (getObject does not inspect storage class).
      StorageClass: INTELLIGENT_TIERING_STORAGE_CLASS,
    })
  );
}

async function getObject(key: string): Promise<Buffer> {
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: requireBucket(),
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
  const buffer = Buffer.concat(chunks);
  // Context packs are stored gzip-encoded (see putObject). Other objects under
  // this prefix (metadata.json, artifacts) are uploaded uncompressed by the
  // harness via presigned PUT and carry no ContentEncoding, so gate
  // decompression on the header to pass those through unchanged.
  return response.ContentEncoding === "gzip" ? gunzipSync(buffer) : buffer;
}

async function deleteObject(key: string): Promise<void> {
  // S3 DeleteObject is idempotent: deleting a missing key succeeds, so the
  // multiple scrub triggers (onStarted, launch-failure cleanup, runner-race
  // path, and the timeout cron) can all run safely without coordination.
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: requireBucket(), Key: key })
  );
}

// --- Context Pack (uploaded by backend before container start) ---
// Types re-exported from @closedloop-ai/loops-api/context-pack (shared contract)

export type {
  ContextPack,
  ContextPackAttachment,
} from "@closedloop-ai/loops-api/context-pack";

// Canonical, long-lived context pack object. Always born pre-scrubbed of the raw
// API key / git tokens (see stripContextPackSecrets), so there is no exposure
// window on it for those credentials and no permanent leak if the post-start
// scrub never runs. Read by resume/parent-state download.
const CONTEXT_PACK_FILENAME = "context-pack.json";
// Ephemeral secrets sidecar. Holds the raw secrets the runner needs at startup;
// read exactly once via its presigned URL, then deleted on "started". Excluded
// from bulk download URLs so it can never be re-surfaced (e.g. to a resumed child).
const CONTEXT_PACK_SECRETS_FILENAME = "context-pack.secrets.json";

/** Return whether the pack carries any secret material (top-level or per-repo). */
function hasContextPackSecrets(contextPack: ContextPack): boolean {
  return (
    !!contextPack.secrets ||
    !!contextPack.additionalRepos?.some((r) => r.githubToken)
  );
}

/**
 * Return a copy of the pack with all secret fields removed.
 * FEA-585 supportingArtifacts and codeEvaluationContext are intentionally
 * metadata/source artifacts only; their schemas do not admit token fields.
 */
function stripContextPackSecrets(contextPack: ContextPack): ContextPack {
  return {
    ...contextPack,
    secrets: undefined,
    additionalRepos: contextPack.additionalRepos?.map(
      ({ githubToken: _githubToken, ...rest }) => rest
    ),
  };
}

export async function uploadContextPack(
  stateKeyPrefix: string,
  contextPack: ContextPack
): Promise<string> {
  const canonicalKey = `${stateKeyPrefix}/${CONTEXT_PACK_FILENAME}`;
  // No human-readable indentation: the pack is machine-read only. Gzip is a real
  // per-run storage win — context packs are large JSON read only during the
  // active run/resume, and every reader honors ContentEncoding "gzip".

  // Fast path: nothing secret to isolate, so the canonical object is already
  // safe and the runner reads it directly.
  if (!hasContextPackSecrets(contextPack)) {
    await putObject(
      canonicalKey,
      JSON.stringify(contextPack),
      "application/json",
      { gzip: true }
    );
    log.info("Context pack uploaded", { stateKeyPrefix, key: canonicalKey });
    return canonicalKey;
  }

  // Secrets present: write the canonical context-pack.json pre-scrubbed (so the
  // persistent object never holds the raw API key / git tokens), and the raw
  // secrets into a separate ephemeral sidecar that the runner downloads once via
  // the returned key. scrubContextPackSecrets deletes the sidecar after "started".
  //
  // Order matters: write the scrubbed canonical FIRST, then the sidecar. If
  // either PUT throws, uploadContextPack rejects before returning, and the
  // launch-failure cleanup never sees an s3StateKey (prepareContext never
  // returned) — so it cannot scrub. Writing the canonical first guarantees the
  // only object that can be orphaned by a partial failure is the secret-free
  // canonical; the secrets sidecar is written last and only after it succeeds is
  // there anything sensitive at rest.
  const secretsKey = `${stateKeyPrefix}/${CONTEXT_PACK_SECRETS_FILENAME}`;
  await putObject(
    canonicalKey,
    JSON.stringify(stripContextPackSecrets(contextPack)),
    "application/json",
    { gzip: true }
  );
  await putObject(secretsKey, JSON.stringify(contextPack), "application/json", {
    gzip: true,
  });
  log.info("Context pack uploaded", { stateKeyPrefix, key: secretsKey });
  return secretsKey;
}

/**
 * Scrub secrets from an uploaded context pack after the container sends the
 * "started" event (the container has already consumed the secrets).
 *
 * The canonical context-pack.json is uploaded pre-scrubbed (see
 * uploadContextPack), so scrubbing only needs to delete the ephemeral secrets
 * sidecar the runner read at startup. Deleting is idempotent and a no-op when no
 * sidecar exists (packs without secrets never write one).
 */
export async function scrubContextPackSecrets(
  stateKeyPrefix: string
): Promise<void> {
  const secretsKey = `${stateKeyPrefix}/${CONTEXT_PACK_SECRETS_FILENAME}`;
  await deleteObject(secretsKey);
  log.info("Context pack secrets scrubbed", { stateKeyPrefix });
}

// --- Conversation History (uploaded by container after completion) ---

// --- Metadata (uploaded by container after completion) ---

export type LoopMetadata = {
  loopId: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt: string;
  tokensInput: number;
  tokensOutput: number;
  tokensByModel?: Record<string, { input: number; output: number }>;
  filesRead: string[];
  filesWritten: string[];
  toolCalls: number;
};

export async function downloadMetadata(
  stateKeyPrefix: string
): Promise<LoopMetadata | null> {
  try {
    const key = `${stateKeyPrefix}/metadata.json`;
    const data = await getObject(key);
    return JSON.parse(data.toString()) as LoopMetadata;
  } catch (error) {
    log.warn("Metadata not found", { stateKeyPrefix, error });
    return null;
  }
}

// --- Event Logs (JSONL format, uploaded by container) ---

// --- Full state download (for Resume) ---

export function getStateKeyPrefix(
  organizationId: string,
  loopId: string,
  runId: string = randomUUID()
): string {
  return LOOP_STATE_PREFIX(organizationId, loopId, runId);
}

// ---------------------------------------------------------------------------
// Pre-signed URLs (for multi-tenant S3 isolation)
// ---------------------------------------------------------------------------
// These functions generate pre-signed URLs so the ECS container can access
// only the specific S3 objects it needs, without having direct S3 credentials.
// This prevents a compromised container from reading other orgs' data.

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 7200; // 2 hours (covers 55-min run + overhead)

/**
 * Generate a pre-signed GET URL for downloading an object from the loop state bucket.
 */
export async function generateDownloadUrl(
  key: string,
  expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: requireBucket(),
    Key: key,
  });
  return await getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * Generate a pre-signed PUT URL for uploading an object to the loop state bucket.
 *
 * `contentEncoding` opts a specific key into compressed storage: the client
 * gzip-compresses the body and PUTs it, and S3 stores the object with that
 * ContentEncoding metadata so every reader (presigned GET in the browser, the
 * SDK getObject above) transparently decompresses. Unlike StorageClass — which
 * the presigner hoists into the signed query string — ContentEncoding is a
 * standard request header, so it is added to the URL's SignedHeaders and the
 * client MUST send a matching `Content-Encoding` header on the PUT. Callers that
 * omit it (the ECS harness) get an uncompressed URL unchanged.
 */
export async function generateUploadUrl(
  key: string,
  expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS,
  { contentEncoding }: { contentEncoding?: string } = {}
): Promise<string> {
  // Intentionally omit ContentType so the pre-signed URL accepts any content
  // type the harness sends (text/plain for logs, application/json for metadata,
  // application/octet-stream for binary state files, etc.).
  const command = new PutObjectCommand({
    Bucket: requireBucket(),
    Key: key,
    ...(contentEncoding ? { ContentEncoding: contentEncoding } : {}),
    // Tier harness-uploaded loop state (artifacts, metadata, logs) the same as
    // backend writes in putObject above; without this, presigned uploads land on
    // S3 Standard and accrue full cost indefinitely. The StorageClass is hoisted
    // into the signed query string, so the harness PUT applies it with no change.
    StorageClass: INTELLIGENT_TIERING_STORAGE_CLASS,
  });
  return await getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * Maximum number of objects to return from a single download-urls request.
 * Prevents runaway responses for loops with large state directories.
 */
const MAX_DOWNLOAD_URLS = 1000;
const S3_LIST_MAX_KEYS = 1000;

/** 50 MB — mirrors harness upload limit; skip objects above this size. */
const MAX_OBJECT_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Decide whether a listed S3 object should be excluded from bulk download URLs.
 * Skips keyless/oversized objects and — critically — the ephemeral secrets
 * sidecar, which is read once by the launching runner through its dedicated
 * presigned context URL and must never be re-surfaced (e.g. to a resumed child)
 * even if a scrub failed to delete it.
 */
function shouldSkipDownloadObject(obj: {
  Key?: string;
  Size?: number;
}): boolean {
  if (!obj.Key) {
    return true;
  }
  if (obj.Key.endsWith(`/${CONTEXT_PACK_SECRETS_FILENAME}`)) {
    return true;
  }
  return !!obj.Size && obj.Size > MAX_OBJECT_SIZE_BYTES;
}

/**
 * List all objects under a prefix and generate pre-signed GET URLs for each.
 * Used for parent state download during resume — the container needs to fetch
 * an entire directory tree without direct S3 ListObjects access.
 *
 * Capped at MAX_DOWNLOAD_URLS objects to prevent runaway responses.
 */
export async function listAndGenerateDownloadUrls(
  prefix: string,
  expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS
): Promise<Array<{ key: string; url: string }>> {
  const bucket = requireBucket();
  const client = getS3Client();
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const results: Array<{ key: string; url: string }> = [];

  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        MaxKeys: Math.min(S3_LIST_MAX_KEYS, MAX_DOWNLOAD_URLS - results.length),
        ContinuationToken: continuationToken,
      })
    );

    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (shouldSkipDownloadObject(obj)) {
          continue;
        }
        // shouldSkipDownloadObject guarantees obj.Key is set.
        const key = obj.Key as string;
        const url = await generateDownloadUrl(key, expiresIn);
        results.push({ key, url });
      }
    }

    if (results.length >= MAX_DOWNLOAD_URLS) {
      log.warn("Download URL cap reached", {
        prefix: normalizedPrefix,
        cap: MAX_DOWNLOAD_URLS,
      });
      return results;
    }

    continuationToken = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return results;
}

/**
 * Delete every object under a loop's S3 prefix (conversation history,
 * context-pack, event logs, work-dir snapshots, …). Paginates the listing and
 * issues one batched `DeleteObjects` request per page. Each page is ≤
 * {@link S3_LIST_MAX_KEYS} (1000) keys, which is exactly the `DeleteObjects`
 * per-request hard cap, so a page always fits one delete call. Returns the
 * number of objects deleted.
 *
 * The loop-state bucket has no S3 lifecycle policy, so terminal-loop state would
 * otherwise persist indefinitely; the retention cleanup cron drives this to
 * purge state for long-completed loops. Throws if S3 reports any per-key error
 * so the caller can surface partial failure and retry on the next run rather
 * than silently leaving objects behind.
 */
export async function deleteLoopState(prefix: string): Promise<number> {
  const bucket = requireBucket();
  const client = getS3Client();
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  let deleted = 0;

  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        MaxKeys: S3_LIST_MAX_KEYS,
        ContinuationToken: continuationToken,
      })
    );

    const keys = (resp.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => Boolean(key));

    if (keys.length > 0) {
      const delResp = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        })
      );
      const errors = delResp.Errors ?? [];
      if (errors.length > 0) {
        const first = errors[0];
        throw new Error(
          `DeleteObjects failed for ${errors.length} object(s) under ${normalizedPrefix}; ` +
            `first: ${first.Key} (${first.Code}: ${first.Message})`
        );
      }
      deleted += keys.length;
    }

    continuationToken = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deleted;
}

/**
 * Validate that an S3 key belongs to a specific loop's prefix.
 * Scoped to `{orgId}/loops/{loopId}/` — prevents a runner from accessing
 * other loops' state under the same organization.
 */
export function validateKeyBelongsToLoop(
  key: string,
  organizationId: string,
  loopId: string
): boolean {
  if (key.includes("..") || key.includes("./")) {
    return false;
  }
  return key.startsWith(`${organizationId}/loops/${loopId}/`);
}

/**
 * Download a single artifact file from a loop's S3 state.
 * Returns the file content as a Buffer, or null if not found.
 */
export async function downloadArtifactFile(
  stateKeyPrefix: string,
  filename: string
): Promise<Buffer | null> {
  try {
    const key = `${stateKeyPrefix}/artifacts/${filename}`;
    return await getObject(key);
  } catch (error) {
    const code =
      (error as { Code?: string; name?: string }).Code ??
      (error as { name?: string }).name;
    if (code !== "NoSuchKey" && code !== "NotFound") {
      throw error;
    }
    log.warn("loop.state.artifact_not_found", {
      stateKeyPrefix,
      filename,
    });
    return null;
  }
}

/**
 * Download markdown prompt snapshot files from `artifacts/agents-snapshot/`.
 * Returns entry names relative to `artifacts/` (for parser compatibility).
 *
 * Capped at MAX_DOWNLOAD_URLS entries; skips files > 50 MB.
 */
export async function downloadPromptSnapshotMarkdownEntries(
  stateKeyPrefix: string
): Promise<Array<{ name: string; data: Buffer }>> {
  const bucket = requireBucket();
  const client = getS3Client();
  const artifactPrefix = `${stateKeyPrefix}/artifacts/`;
  const snapshotPrefix = `${artifactPrefix}agents-snapshot/`;
  const entries: Array<{ name: string; data: Buffer }> = [];

  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: snapshotPrefix,
        MaxKeys: Math.max(
          1,
          Math.min(S3_LIST_MAX_KEYS, MAX_DOWNLOAD_URLS - entries.length)
        ),
        ContinuationToken: continuationToken,
      })
    );

    const objects = (response.Contents ?? [])
      .filter((obj): obj is { Key: string; Size?: number } => Boolean(obj.Key))
      .filter((obj) => obj.Key.endsWith(".md"))
      .filter((obj) => !obj.Size || obj.Size <= MAX_OBJECT_SIZE_BYTES);

    const pageEntries = await Promise.all(
      objects.map(async (obj) => {
        const key = obj.Key;
        try {
          const data = await getObject(key);
          const relativeName = key.startsWith(artifactPrefix)
            ? key.slice(artifactPrefix.length)
            : key;
          return { name: relativeName, data };
        } catch (err) {
          log.warn("loop.state.agent_snapshot_download_failed", {
            key,
            err,
          });
          return null;
        }
      })
    );
    entries.push(
      ...pageEntries.filter(
        (e): e is { name: string; data: Buffer } => e !== null
      )
    );

    if (entries.length >= MAX_DOWNLOAD_URLS) {
      log.warn("loop.state.prompt_snapshot_cap_reached", {
        stateKeyPrefix,
        cap: MAX_DOWNLOAD_URLS,
      });
      return entries;
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  if (entries.length > 0) {
    log.info("loop.state.prompt_snapshot_downloaded", {
      stateKeyPrefix,
      count: entries.length,
    });
  }

  return entries;
}
