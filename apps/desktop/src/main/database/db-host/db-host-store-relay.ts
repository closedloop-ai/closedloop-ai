/**
 * @file db-host-store-relay.ts
 * @description PLN-1837 §1.4 — how a store-thread notification becomes a
 * main-process one.
 *
 * `process.parentPort` is `undefined` inside a worker (ISS-8246 probe 8), so
 * nothing the store raises can reach main by itself. Every worker-origin signal
 * makes two hops: the store posts an inner response, `db-store-client.ts`
 * dispatches it to one of the handlers built here, and this module re-addresses
 * it to the outer `DbHostResponse` main already understands.
 *
 * ## Why it is not inline in `db-host-worker.ts`
 *
 * That module registers a `process.parentPort` listener at load, so no test can
 * import it — and the thing most worth testing about this milestone is exactly
 * this mapping. Two of the relayed kinds fail SILENTLY when unhandled, and both
 * have already shipped that bug one boundary out: `telemetry-relay-sink.ts`
 * (ISS-7109 — "the emit ran, returned, and sent nothing") and `persistent-log.ts`
 * (ISS-7882 — lines dropped past `PreInitLogBuffer`'s 500-line cap). A relay
 * whose only proof of correctness is that someone read the worker is the same
 * unverified claim those tickets were about. Built here, the store → dispatcher
 * → main path can be driven end to end against a captured `post`.
 *
 * `SessionTerminal` is in the table below because it was MISSING from the first
 * draft of this design and caught in review. A relay that covers only the
 * obvious kinds leaves core runtime signals dark.
 */

import { type DbHostResponse, DbHostResponseKind } from "./db-host-protocol.js";
import type { DbStoreClientDeps } from "./db-store-client.js";

/**
 * The relay half of {@link DbStoreClientDeps} — every dep whose only job is to
 * re-address a store-thread message to main. The spawn seam and the timers are
 * deliberately excluded: they are wiring, not relay, and a test supplies them.
 */
export type DbHostStoreRelay = Pick<
  DbStoreClientDeps,
  | "onCommittedWrite"
  | "onDeath"
  | "onDurableLog"
  | "onEmit"
  | "onLog"
  | "onSessionTerminal"
  | "onTelemetry"
  | "onWriteTask"
>;

export type DbHostStoreRelayDeps = {
  /** Post to main. In the dispatcher this is `process.parentPort.postMessage`. */
  post: (message: DbHostResponse) => void;
  /**
   * ISS-7110 — apply the store's committed-write epoch bump. Must be
   * SYNCHRONOUS; see `db-store-client.ts` for why the ordering, not merely the
   * delivery, is the contract.
   */
  onCommittedWrite: () => void;
  /**
   * ISS-7256 — record the transition in the dispatcher's write-dispatch mirror.
   * Like `onCommittedWrite` this is CONSUMED by the dispatcher rather than
   * re-addressed to main: main asks for it through the ordinary `importer`
   * op path, which the dispatcher then answers locally.
   */
  onWriteTask: DbHostStoreRelay["onWriteTask"];
  /** PLN-1837 §1.3 — the store thread is gone; exit so the supervisor re-forks. */
  onDeath: (reason: string) => void;
};

/**
 * Build the relay handlers the dispatcher hands to its store client.
 *
 * Every worker-origin kind is represented. The three that are NOT here —
 * `Opened`, `Result` and `Closed` — are correlated replies the store client
 * settles itself, and `Heap` is consumed by the client rather than relayed,
 * because main's contract carries a pressure LEVEL and not raw byte counts
 * (ISS-4823).
 */
export function createDbHostStoreRelay(
  deps: DbHostStoreRelayDeps
): DbHostStoreRelay {
  return {
    onEmit: (sessionId) =>
      deps.post({ kind: DbHostResponseKind.Emit, sessionId }),
    onSessionTerminal: (notice) =>
      deps.post({
        kind: DbHostResponseKind.SessionTerminal,
        sessionId: notice.sessionId,
        status: notice.status,
      }),
    onCommittedWrite: deps.onCommittedWrite,
    onWriteTask: deps.onWriteTask,
    onLog: (message) => deps.post({ kind: DbHostResponseKind.Log, message }),
    onDurableLog: (level, line) =>
      deps.post({ kind: DbHostResponseKind.DurableLog, level, line }),
    onTelemetry: (event) =>
      deps.post({ kind: DbHostResponseKind.Telemetry, event }),
    onDeath: deps.onDeath,
  };
}
