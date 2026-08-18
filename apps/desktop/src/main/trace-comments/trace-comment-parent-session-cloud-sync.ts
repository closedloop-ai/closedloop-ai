import { randomUUID } from "node:crypto";
import {
  AgentSessionSyncMode,
  type DesktopAgentSessionsSyncResponse,
} from "@repo/api/src/types/agent-session";
import { SESSION_PAYLOAD_BYTE_CAP } from "../agent-sync/agent-session-sync-backoff-policy.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type AgentSessionSyncTransportPayload,
  type SyncedAgentSession,
} from "../agent-sync/agent-session-sync-contract.js";
import {
  maxSessionPayloadBytesForBatch,
  prepareAgentSessionPayload,
} from "../agent-sync/agent-session-sync-payload.js";

export type TraceCommentParentSessionSyncResult =
  DesktopAgentSessionsSyncResponse;

export type PostTraceCommentParentSessionPayload = (
  payload: AgentSessionSyncTransportPayload
) => Promise<TraceCommentParentSessionSyncResult>;

/**
 * Sends one targeted parent-session payload through the same batch/chunk
 * preparation rules as background cloud sync so the referenced parent session
 * exists in the cloud before the trace-comment caller proceeds. FEA-2718 retired
 * the event-fragment transport, so oversized sessions split into whole-session
 * chunks (or dead-letter) — never per-event fragments.
 *
 * ISS-4578 (P1 #10): `activityChunkingSupported` threads the server's negotiated
 * `agentSessionSyncActivityChunking` capability so this recovery path respects
 * the SAME chunking/version-skew decision the bulk sync lane does. Optional +
 * additive — omitted/false keeps the tiling in the base payload (skew-safe: an
 * unwired caller or an old server degrades to the whole-session dead-letter,
 * never a silent truncation).
 */
export async function syncTraceCommentParentSessionPayloads(
  session: SyncedAgentSession,
  postPayload: PostTraceCommentParentSessionPayload,
  activityChunkingSupported = false
): Promise<void> {
  const payloads = prepareTraceCommentParentSessionPayloads(
    session,
    activityChunkingSupported
  );
  for (const payload of payloads) {
    await postPayload(payload);
  }
}

function prepareTraceCommentParentSessionPayloads(
  session: SyncedAgentSession,
  activityChunkingSupported: boolean
): AgentSessionSyncTransportPayload[] {
  const prepared = prepareAgentSessionPayload(
    session,
    maxSessionPayloadBytesForBatch(SESSION_PAYLOAD_BYTE_CAP),
    undefined,
    undefined,
    activityChunkingSupported
  );
  if (prepared.kind === "session") {
    return [toSingleSessionSyncBatch(prepared.session)];
  }
  if (prepared.kind === "chunked") {
    return [prepared.firstChunk, ...prepared.remainingChunks].map(
      toSingleSessionSyncBatch
    );
  }
  throw new Error("Desktop session payload is too large for cloud sync.");
}

function toSingleSessionSyncBatch(
  session: SyncedAgentSession
): AgentSessionSyncTransportPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
}
