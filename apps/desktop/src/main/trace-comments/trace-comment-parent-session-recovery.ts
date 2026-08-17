import type { TraceCommentTarget } from "@repo/api/src/types/comment";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { AgentSessionSyncTransportPayload } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { TraceCommentParentSessionSyncPostOptions } from "./trace-comment-parent-session-cloud-post.js";
import {
  postTraceCommentParentSessionCloudSync,
  type TraceCommentParentSessionSyncResult,
} from "./trace-comment-parent-session-cloud-post.js";
import { syncTraceCommentParentSessionPayloads } from "./trace-comment-parent-session-cloud-sync.js";

/**
 * FEA-4169: the recovery path that syncs a comment's local parent SESSION to
 * the cloud before retrying a cloud trace-comment op that 404'd on a
 * missing-session. It posts the parent session directly to
 * `/desktop/agent-sessions/sync`, which bypasses the bulk-sync lane's own
 * gates — so it must honor the SAME "may session data egress?" decision the
 * lanes do (server-owned org policy ANDed over device consent), or a
 * policy-off org's session would leak out through this back door.
 *
 * Options extend the narrow post-options (credential/origin/log) with the two
 * live probes this path needs. The runtime's full options object is
 * structurally assignable, so callers pass it unchanged.
 */
export type TraceCommentParentSessionRecoveryOptions =
  TraceCommentParentSessionSyncPostOptions & {
    /**
     * Live "may session data egress at all?" gate (server org policy ANDed over
     * device consent). Omit ⇒ allowed (pre-FEA-4169 behavior), so an unwired or
     * older host never newly suppresses sync.
     */
    isSessionSyncAllowed?: () => boolean;
    /** The live compute-target id, or null when offline/unauthenticated. */
    getComputeTargetId?: () => string | null;
    /**
     * ISS-4578 (P1 #10): live "did the server advertise
     * `agentSessionSyncActivityChunking`?" probe (the same one the bulk sync lane
     * reads). Threaded so this recovery path paginates an oversized activity
     * tiling across chunks exactly as the lane does, instead of always keeping
     * the full tiling in the base. Omit ⇒ false (skew-safe: the tiling rides the
     * base and an oversized one dead-letters for a larger-payload retry, never a
     * silent truncation). Read live so a hello-ack re-negotiation is honored on
     * the next recovery attempt.
     */
    isSyncActivityChunkingSupported?: () => boolean;
  };

/**
 * Dedupe in-flight parent-session recovery syncs by `computeTargetId:sessionId`
 * so a burst of pending comments on the same session collapses to one POST.
 */
const activeTraceCommentParentSessionSyncs = new Map<string, Promise<void>>();

/**
 * Sync the local parent SESSION for a trace-comment target to the cloud, unless
 * the org policy / device consent forbids it. Returns without posting when sync
 * is not allowed (explicit policy-off) so the parent session is never sent; the
 * caller's retry then simply re-fails the 404 rather than smuggling session
 * data past the policy.
 */
export async function syncCloudSessionForTraceComments(
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: TraceCommentParentSessionRecoveryOptions
): Promise<void> {
  if (target.type !== "session") {
    return;
  }
  // FEA-4169: honor the server-owned ORG POLICY (ANDed over device consent) on
  // this recovery path. On a missing-session 404 the retry would otherwise load
  // the local parent SESSION and POST it straight to /desktop/agent-sessions/sync,
  // bypassing the bulk-sync lane's policy gate. (The server also denies this
  // route now, but not sending is the correct client posture and avoids a
  // guaranteed-rejected round trip.)
  if (options.isSessionSyncAllowed && !options.isSessionSyncAllowed()) {
    return;
  }
  if (!syncSource) {
    throw new Error("Desktop session source unavailable.");
  }
  const computeTargetId = options.getComputeTargetId?.();
  if (!computeTargetId) {
    throw new Error("Desktop compute target unavailable.");
  }

  const syncKey = `${computeTargetId}:${target.id}`;
  const active = activeTraceCommentParentSessionSyncs.get(syncKey);
  if (active) {
    await active;
    return;
  }
  const sync = syncCloudSessionForTraceCommentsOnce(
    syncSource,
    target,
    options,
    computeTargetId
  ).finally(() => {
    if (activeTraceCommentParentSessionSyncs.get(syncKey) === sync) {
      activeTraceCommentParentSessionSyncs.delete(syncKey);
    }
  });
  activeTraceCommentParentSessionSyncs.set(syncKey, sync);
  await sync;
}

async function syncCloudSessionForTraceCommentsOnce(
  syncSource: AgentSessionSyncSource,
  target: TraceCommentTarget,
  options: TraceCommentParentSessionRecoveryOptions,
  computeTargetId: string
): Promise<void> {
  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  const sessions = await syncSource.loadSyncedSessions([target.id], cache);
  const session = sessions[0];
  if (!session) {
    throw new Error(
      "Desktop session source did not return the target session."
    );
  }

  await syncTraceCommentParentSessionPayloads(
    session,
    (payload) =>
      postCloudAgentSessionSync(target.id, payload, options, computeTargetId),
    // ISS-4578 (P1 #10): honor the negotiated activity-chunking capability on
    // this recovery path too. Read live; default false when unwired/old server.
    options.isSyncActivityChunkingSupported?.() ?? false
  );
}

function postCloudAgentSessionSync(
  sessionId: string,
  payload: AgentSessionSyncTransportPayload,
  options: TraceCommentParentSessionRecoveryOptions,
  computeTargetId: string
): Promise<TraceCommentParentSessionSyncResult> {
  return postTraceCommentParentSessionCloudSync(
    sessionId,
    payload,
    options,
    computeTargetId
  );
}
