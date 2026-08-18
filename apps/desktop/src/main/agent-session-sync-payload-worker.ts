import { parentPort } from "node:worker_threads";
import { syncPayloadSizerFor } from "./agent-sync/agent-session-sync-compression.js";
import type { SyncedAgentSession } from "./agent-sync/agent-session-sync-contract.js";
import {
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "./agent-sync/agent-session-sync-payload.js";

type PayloadWorkerRequest = {
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

function preparePayloadWorkerResponse(
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
          message.activityChunkingSupported === true
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
