import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
  SyncJsonValue,
} from "./agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "./agent-session-sync-contract.js";

export type PreparedAgentSessionPayload =
  | {
      kind: "session";
      session: SyncedAgentSession;
      payloadBytes: number;
    }
  | {
      kind: "chunked";
      sessionId: string;
      firstChunk: SyncedAgentSession;
      remainingChunks: SyncedAgentSession[];
      payloadBytes: number;
      firstChunkBytes: number;
      chunkCount: number;
    }
  | {
      kind: "dead-letter";
      sessionId: string;
      payloadBytes: number;
    };

export type AgentSessionPayloadPreparer = {
  (
    sessions: SyncedAgentSession[],
    maxBytes: number
  ): Promise<PreparedAgentSessionPayload[]>;
  dispose?: () => void | Promise<void>;
};

export function estimateSessionPayloadBytes(
  session: SyncedAgentSession
): number {
  return Buffer.byteLength(JSON.stringify(session));
}

export function estimateAgentSessionSyncBatchBytes(
  batch: AgentSessionSyncBatch
): number {
  return Buffer.byteLength(JSON.stringify(batch));
}

export function maxSessionPayloadBytesForBatch(maxBatchBytes: number): number {
  return Math.max(0, maxBatchBytes - AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES);
}

/**
 * Prepare one sync candidate using the same payload semantics as the transport
 * path: strip transcript-sized event content, enforce the byte cap, and split
 * oversized event arrays into chunks when metadata can still fit.
 */
export function prepareAgentSessionPayload(
  session: SyncedAgentSession,
  maxBytes: number
): PreparedAgentSessionPayload {
  const sanitized = sanitizeSessionForSync(session);
  const payloadBytes = estimateSessionPayloadBytes(sanitized);
  if (payloadBytes <= maxBytes) {
    return { kind: "session", session: sanitized, payloadBytes };
  }

  const chunks = chunkOversizedSession(sanitized, maxBytes);
  if (chunks.length === 0) {
    return {
      kind: "dead-letter",
      sessionId: sanitized.externalSessionId,
      payloadBytes,
    };
  }

  const [firstChunk, ...remainingChunks] = chunks;
  return {
    kind: "chunked",
    sessionId: sanitized.externalSessionId,
    firstChunk,
    remainingChunks,
    payloadBytes,
    firstChunkBytes: estimateSessionPayloadBytes(firstChunk),
    chunkCount: chunks.length,
  };
}

/**
 * Trim transcript-sized event content for cloud sync while preserving compact
 * tool metadata needed to distinguish repeated Session Trace rows.
 */
export function sanitizeSessionForSync(
  session: SyncedAgentSession
): SyncedAgentSession {
  return {
    ...session,
    metadata: compactSessionMetadataForSync(session.metadata),
    agents: session.agents.map((agent) => ({
      ...agent,
      task: null,
    })),
    events: session.events.map((event) => ({
      ...event,
      summary: null,
      data: stripDataContent(event.data),
    })),
  };
}

/**
 * Split an oversized session into multiple chunks, each within the byte cap.
 * Every chunk contains the full session metadata, agents, and token usage;
 * only the events array is paginated across chunks.
 *
 * Returns [] when metadata alone exceeds the cap, because no valid chunk can be
 * produced without changing the outbound session contract.
 */
export function chunkOversizedSession(
  session: SyncedAgentSession,
  maxBytes: number
): SyncedAgentSession[] {
  const baseSession: SyncedAgentSession = { ...session, events: [] };
  const baseBytes = estimateSessionPayloadBytes(baseSession);

  if (baseBytes > maxBytes) {
    return [];
  }
  if (session.events.length === 0) {
    return [baseSession];
  }

  const chunks: SyncedAgentSession[] = [];
  let currentEvents: typeof session.events = [];

  for (const event of session.events) {
    const candidateEvents = [...currentEvents, event];
    const candidate = { ...session, events: candidateEvents };
    if (estimateSessionPayloadBytes(candidate) <= maxBytes) {
      currentEvents = candidateEvents;
      continue;
    }
    if (currentEvents.length === 0) {
      return [];
    }
    if (chunks.length + 1 >= MAX_SESSION_SYNC_CHUNKS) {
      return [];
    }
    chunks.push({ ...session, events: currentEvents });
    currentEvents = [event];
    if (
      estimateSessionPayloadBytes({ ...session, events: currentEvents }) >
      maxBytes
    ) {
      return [];
    }
  }

  if (currentEvents.length > 0) {
    if (chunks.length + 1 > MAX_SESSION_SYNC_CHUNKS) {
      return [];
    }
    chunks.push({ ...session, events: currentEvents });
  }

  return chunks;
}

const MAX_SESSION_SYNC_CHUNKS = 100;
const MAX_SYNC_METADATA_DEPTH = 4;
const MAX_SYNC_METADATA_KEYS = 80;
const MAX_SYNC_METADATA_ARRAY_ITEMS = 100;
const MAX_SYNC_METADATA_STRING_CHARS = 1024;
const MAX_SYNC_METADATA_MESSAGES = 100;
const MAX_SYNC_METADATA_MESSAGE_TEXT_CHARS = 160;
const AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES = Math.max(
  agentSessionSyncBatchEnvelopeBytes(AgentSessionSyncMode.Incremental),
  agentSessionSyncBatchEnvelopeBytes(AgentSessionSyncMode.Backfill)
);
const OMITTED_SYNC_METADATA_KEYS = new Set(["tokenSeries"]);

function agentSessionSyncBatchEnvelopeBytes(
  syncMode: AgentSessionSyncMode
): number {
  return estimateAgentSessionSyncBatchBytes({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000000",
    syncMode,
    sessionCount: 999,
    sessions: [],
  });
}

function compactSessionMetadataForSync(
  metadata: SyncedAgentSession["metadata"]
): SyncedAgentSession["metadata"] {
  if (!(metadata && typeof metadata === "object" && !Array.isArray(metadata))) {
    return metadata ?? null;
  }
  const compacted = compactMetadataObject(metadata, 0);
  return compacted && Object.keys(compacted).length > 0 ? compacted : null;
}

function compactMetadataObject(
  metadata: Record<string, SyncJsonValue>,
  depth: number
): Record<string, SyncJsonValue> | null {
  if (depth > MAX_SYNC_METADATA_DEPTH) {
    return null;
  }
  const compacted: Record<string, SyncJsonValue> = {};
  for (const [key, value] of Object.entries(metadata).slice(
    0,
    MAX_SYNC_METADATA_KEYS
  )) {
    if (OMITTED_SYNC_METADATA_KEYS.has(key)) {
      continue;
    }
    const compactValue =
      key === "messages"
        ? compactMetadataMessages(value)
        : compactMetadataValue(value, depth + 1);
    if (compactValue !== undefined) {
      compacted[key] = compactValue;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : null;
}

function compactMetadataMessages(value: SyncJsonValue): SyncJsonValue {
  if (!Array.isArray(value)) {
    return compactMetadataValue(value, 1) ?? null;
  }
  return value.slice(0, MAX_SYNC_METADATA_MESSAGES).map((item) => {
    if (!(item && typeof item === "object" && !Array.isArray(item))) {
      return null;
    }
    const message = item as Record<string, SyncJsonValue>;
    const compacted: Record<string, SyncJsonValue> = {};
    copyStringMetadata(
      message,
      compacted,
      "role",
      MAX_SYNC_METADATA_STRING_CHARS
    );
    copyStringMetadata(
      message,
      compacted,
      "timestamp",
      MAX_SYNC_METADATA_STRING_CHARS
    );
    copyStringMetadata(
      message,
      compacted,
      "model",
      MAX_SYNC_METADATA_STRING_CHARS
    );
    copyStringMetadata(
      message,
      compacted,
      "text",
      MAX_SYNC_METADATA_MESSAGE_TEXT_CHARS
    );
    copyBooleanMetadata(message, compacted, "isThinking");
    copyBooleanMetadata(message, compacted, "isSynthetic");
    return compacted;
  });
}

function compactMetadataValue(
  value: SyncJsonValue,
  depth: number
): SyncJsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, MAX_SYNC_METADATA_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    if (depth > MAX_SYNC_METADATA_DEPTH) {
      return [];
    }
    return value
      .slice(0, MAX_SYNC_METADATA_ARRAY_ITEMS)
      .map((item) => compactMetadataValue(item, depth + 1) ?? null);
  }
  if (typeof value === "object") {
    return compactMetadataObject(value as Record<string, SyncJsonValue>, depth);
  }
  return undefined;
}

function copyStringMetadata(
  source: Record<string, SyncJsonValue>,
  target: Record<string, SyncJsonValue>,
  key: string,
  maxChars: number
): void {
  const value = source[key];
  if (typeof value === "string") {
    target[key] = truncateString(value, maxChars);
  }
}

function copyBooleanMetadata(
  source: Record<string, SyncJsonValue>,
  target: Record<string, SyncJsonValue>,
  key: string
): void {
  const value = source[key];
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

function truncateString(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

const STRIPPED_LEAF_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "output",
  "patch",
  "prompt",
  "reasoning",
  "stderr",
  "stdout",
  "text",
]);

function stripDataContent(
  data: SyncJsonValue | undefined
): SyncJsonValue | undefined {
  if (data === undefined || data === null) {
    return data;
  }
  if (typeof data !== "object") {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => stripDataContent(item) ?? null);
  }
  const obj = data as Record<string, SyncJsonValue>;
  const rest: Record<string, SyncJsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIPPED_LEAF_KEYS.has(k)) {
      continue;
    }
    rest[k] =
      (typeof v === "object" && v !== null ? stripDataContent(v) : v) ?? null;
  }
  return Object.keys(rest).length > 0 ? rest : null;
}
