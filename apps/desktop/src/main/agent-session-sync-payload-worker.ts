import { parentPort } from "node:worker_threads";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import {
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "./agent-session-sync-payload.js";

type PayloadWorkerRequest = {
  requestId: string;
  sessions: SyncedAgentSession[];
  maxBytes: number;
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
    };

parentPort?.on("message", (message: PayloadWorkerRequest) => {
  const response = preparePayloadWorkerResponse(message);
  parentPort?.postMessage(response);
});

function preparePayloadWorkerResponse(
  message: PayloadWorkerRequest
): PayloadWorkerResponse {
  try {
    return {
      requestId: message.requestId,
      ok: true,
      payloads: message.sessions.map((session) =>
        prepareAgentSessionPayload(session, message.maxBytes)
      ),
    };
  } catch (error) {
    return {
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
