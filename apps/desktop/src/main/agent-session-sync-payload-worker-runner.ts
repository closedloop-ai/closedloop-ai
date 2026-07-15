import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import type {
  AgentSessionPayloadPreparer,
  PreparedAgentSessionPayload,
} from "./agent-session-sync-payload.js";

type PendingRequest = {
  resolve: (payloads: PreparedAgentSessionPayload[]) => void;
  reject: (error: Error) => void;
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

export function createAgentSessionPayloadWorkerPreparer(
  createWorker: () => Worker = createDefaultPayloadWorker
): AgentSessionPayloadPreparer {
  let worker: Worker | null = null;
  const pending = new Map<string, PendingRequest>();

  const preparePayloads: AgentSessionPayloadPreparer = (
    sessions: SyncedAgentSession[],
    maxBytes: number
  ) =>
    new Promise<PreparedAgentSessionPayload[]>((resolve, reject) => {
      const requestId = randomUUID();
      pending.set(requestId, { resolve, reject });
      getWorker().postMessage({ requestId, sessions, maxBytes });
    });
  preparePayloads.dispose = async () => {
    rejectAll(new Error("agent-session payload worker disposed"));
    const currentWorker = worker;
    worker = null;
    await currentWorker?.terminate();
  };

  return preparePayloads;

  function getWorker(): Worker {
    if (worker) {
      return worker;
    }

    worker = createWorker();
    worker.unref();
    worker.on("message", handleMessage);
    worker.on("error", (error) => {
      rejectAll(error);
      worker = null;
    });
    worker.on("exit", (code) => {
      worker = null;
      if (code !== 0) {
        rejectAll(new Error(`agent-session payload worker exited ${code}`));
      }
    });
    return worker;
  }

  function handleMessage(message: PayloadWorkerResponse): void {
    const pendingRequest = pending.get(message.requestId);
    if (!pendingRequest) {
      return;
    }
    pending.delete(message.requestId);
    if (message.ok) {
      pendingRequest.resolve(message.payloads);
      return;
    }
    pendingRequest.reject(new Error(message.error));
  }

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }
}

function createDefaultPayloadWorker(): Worker {
  return new Worker(
    new URL("./agent-session-sync-payload-worker.js", import.meta.url)
  );
}
