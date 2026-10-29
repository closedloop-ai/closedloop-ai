import { parentPort } from "node:worker_threads";
import type { MetadataContentPolicy } from "@repo/lib/agent-sessions/metadata-preview";
import { syncPayloadSizerFor } from "./agent-session-sync-compression.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import {
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "./agent-session-sync-payload.js";

export type PayloadWorkerRequest = {
  requestId: string;
  sessions: SyncedAgentSession[];
  maxBytes: number;
  // FEA-4138: size the cap/chunk decision against gzip bytes when the server
  // negotiated decompression. Optional/additive — omitted degrades to raw JSON.
  compress?: boolean;
  // ISS-4541: paginate an oversized session's activity-segment tiling across
  // chunks when the server merges multi-part tilings additively.
  // Optional/additive — omitted keeps the tiling in the base payload.
  activityChunkingSupported?: boolean;
  // ISS-9859: paginate a session's `prRefs` and `prs` across parts when they
  // are why the replicated split fails and the server merges the marked parts.
  // Optional/additive — omitted keeps both lists whole in every part.
  prRefChunkingSupported?: boolean;
  // ISS-7775: what this machine's data-sync level permits inside `metadata`.
  // Optional/additive so an in-flight request from an older runner still
  // deserializes; an omitted policy resolves to the WITHHOLDING default in
  // `prepareAgentSessionPayload`, never the permissive one.
  contentPolicy?: MetadataContentPolicy;
};

type PayloadWorkerResponse =
  | {
      requestId: string;
      ok: true;
      payloads: PreparedAgentSessionPayload[];
    }
  | {
      requestId: string;
      ok: false;
      error: string;
      // FEA-4014: the error constructor name (e.g. "TypeError") so the runner can
      // reconstruct the matching error type on the main thread. Without this, a
      // worker-side serialization TypeError (circular/bigint from JSON.stringify
      // in prep) would cross the boundary as a plain Error and the service's
      // `isLocalSerializationError` (`instanceof TypeError`) could never fire — so
      // a deterministic local prep bug would wrongly earn the transient retry
      // budget instead of dead-lettering immediately. Optional/additive for
      // version skew: an omitted value degrades to a plain Error.
      errorName?: string;
    };

parentPort?.on("message", (message: PayloadWorkerRequest) => {
  const response = preparePayloadWorkerResponse(message);
  parentPort?.postMessage(response);
});

/**
 * ISS-7775: EXPORTED so the request → producer hop can be driven directly.
 * Production wires the worker preparer (`desktop-sync-lane-composition.ts`), so
 * a test that only exercises the sync service's in-process fallback closure
 * leaves this hop — where `contentPolicy` is read off the message — with no
 * coverage at all, and dropping it there withholds a `full`-tier user's turn
 * text silently. Module scope is side-effect-free off a worker thread:
 * `parentPort` is `null` on the main thread, so the listener above never binds.
 */
export function preparePayloadWorkerResponse(
  message: PayloadWorkerRequest
): PayloadWorkerResponse {
  try {
    const sizer = syncPayloadSizerFor(message.compress === true);
    return {
      requestId: message.requestId,
      ok: true,
      payloads: message.sessions.map((session) =>
        prepareAgentSessionPayload(
          session,
          message.maxBytes,
          sizer,
          undefined,
          message.activityChunkingSupported === true,
          message.contentPolicy,
          message.prRefChunkingSupported === true
        )
      ),
    };
  } catch (error) {
    return {
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}
