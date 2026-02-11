import { randomUUID } from "node:crypto";
import { downloadArtifact, uploadArtifact } from "@repo/aws";
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
  await uploadArtifact(
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
    const data = await downloadArtifact(key);
    return JSON.parse(data.toString()) as ContextPack;
  } catch (error) {
    log.warn("Context pack not found", { stateKeyPrefix, error });
    return null;
  }
}

// --- Conversation History (uploaded by container after completion) ---

export async function downloadConversation(
  stateKeyPrefix: string
): Promise<unknown[] | null> {
  try {
    const key = `${stateKeyPrefix}/conversation.json`;
    const data = await downloadArtifact(key);
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
    const data = await downloadArtifact(key);
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
    const data = await downloadArtifact(key);
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
