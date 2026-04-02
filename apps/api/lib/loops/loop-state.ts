import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAwsCredentials } from "@repo/aws/credentials";
import { log } from "@repo/observability/log";

/**
 * S3 key structure for Loop state:
 * {organizationId}/loops/{loopId}/
 *   ├── context-pack.json    (input: assembled by backend before container start)
 *   ├── conversation.json    (output: full Claude Code conversation history)
 *   ├── metadata.json        (output: loop execution metadata)
 *   ├── logs/
 *   │   └── conversation.jsonl  (output: line-by-line event log)
 *   └── work/                (output: work directory snapshot)
 */

const LOOP_STATE_PREFIX = (orgId: string, loopId: string, runId: string) =>
  `${orgId}/loops/${loopId}/${runId}`;

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

async function putObject(
  key: string,
  body: string,
  contentType: string
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: Buffer.from(body),
      ContentType: contentType,
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
  return Buffer.concat(chunks);
}

// --- Context Pack (uploaded by backend before container start) ---

export type ContextPackAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

export type ContextPack = {
  command: string;
  prompt?: string;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
  }>;
  repoInfo?: {
    fullName: string;
    branch: string;
  };
  priorLoopSummaries?: Array<{
    loopId: string;
    command: string;
    summary: string;
  }>;
  committer?: {
    name: string;
    email: string;
  };
  secrets?: {
    anthropicApiKey?: string;
    githubToken?: string;
  };
  /**
   * User-supplied Additional Context from ArtifactVersion v1.
   * Carries free-form text the user entered alongside the artifact when
   * dispatching the loop. scrubContextPackSecrets preserves this field
   * intentionally — it contains no secrets and is needed by the container
   * throughout the run.
   */
  userContext?: string;
  attachments?: ContextPackAttachment[];
};

export async function uploadContextPack(
  stateKeyPrefix: string,
  contextPack: ContextPack
): Promise<string> {
  const key = `${stateKeyPrefix}/context-pack.json`;
  await putObject(
    key,
    JSON.stringify(contextPack, null, 2),
    "application/json"
  );
  log.info("Context pack uploaded", { stateKeyPrefix, key });
  return key;
}

export async function downloadContextPack(
  stateKeyPrefix: string
): Promise<ContextPack | null> {
  try {
    const key = `${stateKeyPrefix}/context-pack.json`;
    const data = await getObject(key);
    return JSON.parse(data.toString()) as ContextPack;
  } catch (error) {
    log.warn("Context pack not found", { stateKeyPrefix, error });
    return null;
  }
}

/**
 * Scrub secrets from an already-uploaded context pack.
 * Called after the container sends "started" event — the container has already
 * consumed the secrets, so we overwrite the S3 object with secrets stripped.
 * This limits the exposure window for API keys stored in the bucket.
 */
export async function scrubContextPackSecrets(
  stateKeyPrefix: string
): Promise<void> {
  const contextPack = await downloadContextPack(stateKeyPrefix);
  if (!contextPack?.secrets) {
    return;
  }

  const scrubbed: ContextPack = { ...contextPack, secrets: undefined };
  const key = `${stateKeyPrefix}/context-pack.json`;
  await putObject(key, JSON.stringify(scrubbed, null, 2), "application/json");
  log.info("Context pack secrets scrubbed", { stateKeyPrefix });
}

// --- Conversation History (uploaded by container after completion) ---

export async function downloadConversation(
  stateKeyPrefix: string
): Promise<unknown[] | null> {
  try {
    const key = `${stateKeyPrefix}/conversation.json`;
    const data = await getObject(key);
    return JSON.parse(data.toString()) as unknown[];
  } catch (error) {
    log.warn("Conversation not found", { stateKeyPrefix, error });
    return null;
  }
}

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

export async function downloadEventLog(
  stateKeyPrefix: string
): Promise<unknown[] | null> {
  try {
    const key = `${stateKeyPrefix}/logs/conversation.jsonl`;
    const data = await getObject(key);
    const lines = data.toString().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    log.warn("Event log not found", { stateKeyPrefix, error });
    return null;
  }
}

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
 */
export async function generateUploadUrl(
  key: string,
  expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS
): Promise<string> {
  // Intentionally omit ContentType so the pre-signed URL accepts any content
  // type the harness sends (text/plain for logs, application/json for metadata,
  // application/octet-stream for binary state files, etc.).
  const command = new PutObjectCommand({
    Bucket: requireBucket(),
    Key: key,
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
        if (!obj.Key) {
          continue;
        }
        if (obj.Size && obj.Size > MAX_OBJECT_SIZE_BYTES) {
          continue;
        }

        const url = await generateDownloadUrl(obj.Key, expiresIn);
        results.push({ key: obj.Key, url });
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
 * Validate that an S3 key belongs to the expected organization prefix.
 * Prevents path traversal and cross-org access.
 *
 * Rejects keys containing path traversal sequences (`..`, `./`) and verifies
 * the key starts with the organization's prefix. organizationId is assumed
 * to be a DB-generated UUID (no `/` or special characters).
 */
export function validateKeyBelongsToOrg(
  key: string,
  organizationId: string
): boolean {
  // Reject path traversal sequences before checking prefix
  if (key.includes("..") || key.includes("./")) {
    return false;
  }
  return key.startsWith(`${organizationId}/`);
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
    log.warn("[loop-state] Artifact file not found", {
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
          log.warn(
            "[loop-state] Failed to download agent-snapshot file, skipping",
            {
              key,
              err,
            }
          );
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
      log.warn("[loop-state] Prompt snapshot entry cap reached", {
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
    log.info("[loop-state] Downloaded prompt snapshot markdown entries", {
      stateKeyPrefix,
      count: entries.length,
    });
  }

  return entries;
}
