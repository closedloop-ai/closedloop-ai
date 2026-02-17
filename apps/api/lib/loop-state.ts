import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
  secrets?: {
    anthropicApiKey: string;
    githubToken?: string;
  };
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
  try {
    const contextPack = await downloadContextPack(stateKeyPrefix);
    if (!contextPack?.secrets) {
      return;
    }

    const scrubbed: ContextPack = { ...contextPack, secrets: undefined };
    const key = `${stateKeyPrefix}/context-pack.json`;
    await putObject(key, JSON.stringify(scrubbed, null, 2), "application/json");
    log.info("Context pack secrets scrubbed", { stateKeyPrefix });
  } catch (error) {
    // Best-effort — don't fail the event pipeline if scrubbing fails
    log.warn("Failed to scrub context pack secrets", {
      stateKeyPrefix,
      error,
    });
  }
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
  contentType = "application/octet-stream",
  expiresIn = DEFAULT_PRESIGN_EXPIRY_SECONDS
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: requireBucket(),
    Key: key,
    ContentType: contentType,
  });
  return await getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * List all objects under a prefix and generate pre-signed GET URLs for each.
 * Used for parent state download during resume — the container needs to fetch
 * an entire directory tree without direct S3 ListObjects access.
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
        ContinuationToken: continuationToken,
      })
    );

    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (!obj.Key) {
          continue;
        }
        // Skip objects > 50MB (mirrors harness upload limit)
        if (obj.Size && obj.Size > 50 * 1024 * 1024) {
          continue;
        }

        const url = await generateDownloadUrl(obj.Key, expiresIn);
        results.push({ key: obj.Key, url });
      }
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
 */
export function validateKeyBelongsToOrg(
  key: string,
  organizationId: string
): boolean {
  return key.startsWith(`${organizationId}/`);
}
