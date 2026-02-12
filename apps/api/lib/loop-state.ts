import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
