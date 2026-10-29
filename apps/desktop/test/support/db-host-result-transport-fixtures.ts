/**
 * @file db-host-result-transport-fixtures.ts
 * @description ISS-12022 — shared harness for the db-host result transport
 * suites: a session-detail-shaped result, the store thread's post over a real
 * `MessageChannel`, the dispatcher's real store client, and main's side of the
 * outer hop.
 */
import { MessageChannel } from "node:worker_threads";
import {
  type DbHostResponse,
  DbHostResponseKind,
} from "../../src/main/database/db-host/db-host-protocol.js";
import {
  type DbHostPending,
  settleDbHostResult,
} from "../../src/main/database/db-host/db-host-result-assembly.js";
import { postEncodedStoreResult } from "../../src/main/database/db-host/db-host-result-codec.js";
import {
  createDbStoreClient,
  type DbStoreWorkerHandle,
} from "../../src/main/database/db-host/db-store-client.js";
import type { DbStoreResponse } from "../../src/main/database/db-host/db-store-protocol.js";

/** A session-detail-shaped result past three pages once encoded. */
export function largeResult(): Record<string, unknown> {
  return {
    session: {
      id: "sess-1",
      startedAt: new Date("2026-10-05T12:00:00.000Z"),
      endedAt: null,
      costUsd: Number.NaN,
      tokens: 12_345_678_901n,
    },
    events: Array.from({ length: 4000 }, (_, index) => ({
      id: `evt-${index}`,
      at: new Date(Date.UTC(2026, 9, 5, 12, 0, index)),
      kind: index % 3 === 0 ? "tool_use" : "message",
      text: `line ${index} ${"x".repeat(200)}`,
      usage: { input: index, output: index * 2, cached: index % 7 === 0 },
      parentId: index === 0 ? undefined : `evt-${index - 1}`,
    })),
    branches: new Map([["main", { prs: [1, 2] }]]),
  };
}

/** Store → dispatcher over a real port, so the transfer list is honoured. */
export async function postFromStore(
  value: unknown
): Promise<{ received: unknown; storeBytesAfterPost: number }> {
  const { port1, port2 } = new MessageChannel();
  const inner = new Promise<unknown>((resolve) => {
    port2.once("message", resolve);
  });
  let posted: ArrayBuffer | undefined;
  postEncodedStoreResult(
    (message, transfer) => {
      posted = message.encoded;
      port1.postMessage(message, transfer);
    },
    1,
    value
  );
  const received = await inner;
  port1.close();
  return { received, storeBytesAfterPost: posted?.byteLength ?? -1 };
}

/** The dispatcher's real store client settling one inner reply. */
export function settleOnDispatcher(reply: DbStoreResponse): Promise<unknown> {
  const worker = fakeWorker();
  const client = createDbStoreClient({
    ...noopRelay(),
    createWorker: () => worker.handle,
  });
  const executed = client.execute("sessions.detail", []);
  worker.emit(reply);
  return executed;
}

/** The relay callbacks `createDbStoreClient` requires, all inert. */
export function noopRelay() {
  return {
    onEmit: () => {},
    onSessionTerminal: () => {},
    onSchedulerChanged: () => {},
    onCommittedWrite: () => {},
    onWriteTask: () => {},
    onLog: () => {},
    onDurableLog: () => {},
    onTelemetry: () => {},
    onScheduledReviewRun: () => new Promise<never>(() => {}),
    onDeath: () => {},
  };
}

/** A store thread that answers only what the test emits. */
export function fakeWorker(): {
  handle: DbStoreWorkerHandle;
  emit: (message: DbStoreResponse) => void;
} {
  let onMessage: ((value: unknown) => void) | undefined;
  const handle = {
    on(event: string, listener: (value: never) => void) {
      if (event === "message") {
        onMessage = listener as (value: unknown) => void;
      }
      return handle;
    },
    postMessage() {},
    terminate: () => Promise.resolve(0),
  } as DbStoreWorkerHandle;
  return { handle, emit: (message) => onMessage?.(message) };
}

/** Main's side of the outer hop: settles replies and queues its pulls. */
export function mainSide() {
  const pending = new Map<number, DbHostPending>();
  const pulls: [number, number][] = [];
  const received: DbHostResponse[] = [];
  return {
    received,
    await(id: number): Promise<unknown> {
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    receive(message: DbHostResponse): void {
      received.push(message);
      if (
        message.kind === DbHostResponseKind.Result ||
        message.kind === DbHostResponseKind.ResultPage
      ) {
        settleDbHostResult(message, pending, (id, offset) =>
          pulls.push([id, offset])
        );
      }
    },
    /** Main's pulls cross the boundary asynchronously; serve them in order. */
    servePulls(delivery: { pull: (id: number, offset: number) => void }): void {
      for (let next = pulls.shift(); next; next = pulls.shift()) {
        delivery.pull(next[0], next[1]);
      }
    },
  };
}
