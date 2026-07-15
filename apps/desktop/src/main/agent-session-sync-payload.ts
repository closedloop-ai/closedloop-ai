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
  if (chunks.length > 0) {
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

  return {
    kind: "dead-letter",
    sessionId: sanitized.externalSessionId,
    payloadBytes,
  };
}

/**
 * Reduce a session to the fields the cloud persists before sync. FEA-2718
 * dropped conversation turn text (`summary`/`data`) from the cloud lane: each
 * synced event is rebuilt from the retained columnar metadata only, so the
 * desktop never ships turn/tool text over the wire (the cloud transcript archive
 * — FEA-2717 — is the sole source of turn/tool detail). The desktop-local trace
 * still reads `summary`/`data` from its own SQLite, so only the sync copy is
 * slimmed.
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
      externalEventId: event.externalEventId,
      agentExternalId: event.agentExternalId,
      eventType: event.eventType,
      toolName: event.toolName,
      createdAt: event.createdAt,
    })),
  };
}

/**
 * Split an oversized session into multiple chunks, each within the byte cap.
 * Every chunk replicates the full session metadata, agents, and token usage;
 * the two large per-event streams — `events` and (FEA-2730) `tokenEvents` — are
 * paginated across chunks, with each chunk carrying a disjoint slice of exactly
 * one stream and the other emptied. Both streams are upserted idempotently
 * cloud-side, so distributing their rows across chunks is safe. When the
 * session carries no tokenEvents, event chunks keep their original
 * `{ ...session, events: slice }` shape (no empty tokenEvents key), preserving
 * the pre-FEA-2730 chunking contract.
 *
 * Returns [] when metadata alone exceeds the cap (or the chunk budget is
 * exhausted), because no valid chunk can be produced without changing the
 * outbound session contract.
 */
export function chunkOversizedSession(
  session: SyncedAgentSession,
  maxBytes: number
): SyncedAgentSession[] {
  const tokenEvents = session.tokenEvents ?? [];
  const hasTokenEvents = tokenEvents.length > 0;

  const buildEventChunk = (
    slice: SyncedAgentSession["events"]
  ): SyncedAgentSession =>
    hasTokenEvents
      ? { ...session, events: slice, tokenEvents: [] }
      : { ...session, events: slice };
  const buildTokenEventChunk = (
    slice: NonNullable<SyncedAgentSession["tokenEvents"]>
  ): SyncedAgentSession => ({ ...session, events: [], tokenEvents: slice });

  const baseSession = buildEventChunk([]);
  if (estimateSessionPayloadBytes(baseSession) > maxBytes) {
    return [];
  }
  if (session.events.length === 0 && !hasTokenEvents) {
    return [baseSession];
  }

  const chunks: SyncedAgentSession[] = [];
  if (
    !appendPaginatedChunks(chunks, session.events, maxBytes, buildEventChunk)
  ) {
    return [];
  }
  // Token events are keep-all/append-only and idempotent cloud-side, and they
  // share the events' MAX_SESSION_SYNC_CHUNKS budget. If they can't all be
  // paginated within it, DEGRADE: keep the event chunks already built and drop
  // the overflow token events, rather than returning [] — which would
  // dead-letter the whole session and discard events/agents/metadata that
  // synced fine before FEA-2730. appendPaginatedChunks appends greedily, so any
  // token-event chunks that DID fit are retained; the remainder resyncs on a
  // later pass. (Events overflowing their own budget above still dead-letter,
  // exactly as pre-FEA-2730.)
  if (hasTokenEvents) {
    appendPaginatedChunks(chunks, tokenEvents, maxBytes, buildTokenEventChunk);
  }

  return chunks.length > 0 ? chunks : [baseSession];
}

/**
 * Greedily pack `items` into byte-bounded chunks (each built via `buildChunk`),
 * appending finished chunks to `chunks`. Returns false — signaling the caller
 * to dead-letter — when a single item plus the replicated metadata exceeds
 * `maxBytes`, or when the chunk budget (MAX_SESSION_SYNC_CHUNKS) is exhausted.
 */
function appendPaginatedChunks<T>(
  chunks: SyncedAgentSession[],
  items: readonly T[],
  maxBytes: number,
  buildChunk: (slice: T[]) => SyncedAgentSession
): boolean {
  let current: T[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (estimateSessionPayloadBytes(buildChunk(candidate)) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      return false;
    }
    if (chunks.length + 1 >= MAX_SESSION_SYNC_CHUNKS) {
      return false;
    }
    chunks.push(buildChunk(current));
    current = [item];
    if (estimateSessionPayloadBytes(buildChunk(current)) > maxBytes) {
      return false;
    }
  }
  if (current.length > 0) {
    if (chunks.length + 1 > MAX_SESSION_SYNC_CHUNKS) {
      return false;
    }
    chunks.push(buildChunk(current));
  }
  return true;
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
    // FEA-2718 residual (owner-tracked follow-up, not closed by PLN-1294): this
    // truncated (MAX_SYNC_METADATA_MESSAGE_TEXT_CHARS) message preview is the one
    // place conversation text still crosses to the cloud DB — it persists in
    // `agent_sessions.metadata` and renders in `SessionDetail.timeline[].detail`.
    // The bulky per-event `data`/`summary` turn text (the feature's target) is
    // gone; fully satisfying acceptance criterion 1 ("no conversation text
    // anywhere") means re-sourcing timeline detail from the FEA-2717 transcript
    // archive instead of DB metadata, which is transcript-lane work explicitly
    // out of PLN-1294's scope. Left intact so the timeline keeps its previews.
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
