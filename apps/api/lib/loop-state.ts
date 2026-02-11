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

const LOOP_STATE_PREFIX = (orgId: string, loopId: string) =>
  `${orgId}/loops/${loopId}`;

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
  /**
   * Sensitive credentials delivered via S3 instead of ECS env vars.
   * Keeps secrets out of ecs:DescribeTasks API responses.
   */
  secrets?: {
    anthropicApiKey: string;
    githubToken?: string;
  };
};

export async function uploadContextPack(
  organizationId: string,
  loopId: string,
  contextPack: ContextPack
): Promise<string> {
  const key = `${LOOP_STATE_PREFIX(organizationId, loopId)}/context-pack.json`;
  await uploadArtifact(
    key,
    JSON.stringify(contextPack, null, 2),
    "application/json"
  );
  log.info("Context pack uploaded", { loopId, key });
  return key;
}

export async function downloadContextPack(
  organizationId: string,
  loopId: string
): Promise<ContextPack | null> {
  try {
    const key = `${LOOP_STATE_PREFIX(organizationId, loopId)}/context-pack.json`;
    const data = await downloadArtifact(key);
    return JSON.parse(data.toString()) as ContextPack;
  } catch (error) {
    log.warn("Context pack not found", { loopId, error });
    return null;
  }
}

// --- Conversation History (uploaded by container after completion) ---

export async function downloadConversation(
  organizationId: string,
  loopId: string
): Promise<unknown[] | null> {
  try {
    const key = `${LOOP_STATE_PREFIX(organizationId, loopId)}/conversation.json`;
    const data = await downloadArtifact(key);
    return JSON.parse(data.toString()) as unknown[];
  } catch (error) {
    log.warn("Conversation not found", { loopId, error });
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
  organizationId: string,
  loopId: string
): Promise<LoopMetadata | null> {
  try {
    const key = `${LOOP_STATE_PREFIX(organizationId, loopId)}/metadata.json`;
    const data = await downloadArtifact(key);
    return JSON.parse(data.toString()) as LoopMetadata;
  } catch (error) {
    log.warn("Metadata not found", { loopId, error });
    return null;
  }
}

// --- Event Logs (JSONL format, uploaded by container) ---

export async function downloadEventLog(
  organizationId: string,
  loopId: string
): Promise<unknown[] | null> {
  try {
    const key = `${LOOP_STATE_PREFIX(organizationId, loopId)}/logs/conversation.jsonl`;
    const data = await downloadArtifact(key);
    const lines = data.toString().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    log.warn("Event log not found", { loopId, error });
    return null;
  }
}

// --- Full state download (for Resume) ---

export function getStateKeyPrefix(
  organizationId: string,
  loopId: string
): string {
  return LOOP_STATE_PREFIX(organizationId, loopId);
}
