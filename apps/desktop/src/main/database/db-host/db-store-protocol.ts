/**
 * @file db-store-protocol.ts
 * @description ISS-8246 M1 — the message contract between the db-host
 * DISPATCHER (the utilityProcess main thread, `db-host-worker.ts`) and the STORE
 * WORKER (a `node:worker_threads` thread that owns the SQLite runtime).
 *
 * This is the INNER hop. The outer main ↔ dispatcher contract
 * (`db-host-protocol.ts`) is unchanged by this milestone: main still posts
 * `Init`/`Invoke`/`Close` and still receives `Ready`/`Result`/`Emit`/…, so
 * `DbHostClient` needed no edit. What changed is that the dispatcher no longer
 * EXECUTES those ops — it admits them into a lane and forwards them here.
 *
 * ## This module must stay runtime-import-free
 *
 * Every import below is `import type`, which erases at build. That is
 * load-bearing, not tidiness: `db-store-worker.ts` is a thin bootstrap whose
 * whole purpose is to keep the store's module graph BEHIND a try/catch, and a
 * static import that throws runs before any catch exists (it surfaces as a
 * `Worker` error event, not as the serialized `Opened` error the boot path
 * needs). The bootstrap therefore statically imports exactly two things —
 * `node:worker_threads` and this file — so this file may never acquire a runtime
 * dependency. Adding one re-opens the migration-refusal crash loop described in
 * `db-store-worker.ts`.
 *
 * ## Why the kinds are prefixed
 *
 * `store-` prefixes keep the inner kinds distinguishable from the outer ones in
 * a log line or a heap dump, where both contracts' messages are in flight at
 * once and several carry the same payload shape.
 */

import type { DurableLogLevel } from "../../logging/durable-log-sink.js";
import type { TelemetryEventPayload } from "../../telemetry/telemetry-protocol.js";
import type {
  WriteQueueTaskPhase,
  WriteQueueTaskToken,
} from "../write-queue.js";
import type {
  DbHostError,
  DbHostInitOptions,
  DbHostUserIdentity,
} from "./db-host-protocol.js";

export const DbStoreRequestKind = {
  /** Open the SQLite runtime (migrations + boot heals). Answered by `Opened`. */
  Open: "store-open",
  /** Run one already-admitted op. Answered by `Result`. */
  Execute: "store-execute",
  /** Mirror main's current identity into the worker's synchronous seam. */
  SetIdentity: "store-set-identity",
  /** Drain the write queue and the connections. */
  Close: "store-close",
  /**
   * ISS-9802 — abandon the in-flight read carrying this token, at its next
   * `yieldDbHostLoop()` checkpoint. Answered by nothing; the `Execute` it
   * cancels settles as a failed Result on its own correlation.
   */
  CancelRead: "store-cancel-read",
} as const;
export type DbStoreRequestKind =
  (typeof DbStoreRequestKind)[keyof typeof DbStoreRequestKind];

export const DbStoreResponseKind = {
  Opened: "store-opened",
  Result: "store-result",
  Emit: "store-emit",
  SessionTerminal: "store-session-terminal",
  /**
   * ISS-7110 / PLN-1837 §1.5 — a write committed at the single-writer boundary.
   * The dispatcher owns `InsightsResultCache`, so the epoch bump that used to be
   * an in-process callback is now a message, and its ORDER against the write's
   * own `Result` is the contract. See the dispatcher's handler.
   */
  CommittedWrite: "store-committed-write",
  /**
   * ISS-7256 (whitlockk review) — one tokened write-queue task changed phase. The
   * dispatcher mirrors these (`write-dispatch-mirror.ts`) so it can answer
   * `importer.hasUndispatchedWrite` LOCALLY while this thread is inside a
   * synchronous statement and answering nothing. Emitted by the transition
   * itself, not by a timer, which is why it is already delivered when the block
   * begins — see that module.
   */
  WriteTask: "store-write-task",
  Log: "store-log",
  DurableLog: "store-durable-log",
  Telemetry: "store-telemetry",
  /**
   * PLN-1837 §Q3 — the worker's own `process.memoryUsage()`. `heapUsed` is
   * PER-ISOLATE, so once the store moved off the dispatcher the dispatcher's
   * heap arm stopped seeing the allocations that matter. The dispatcher folds
   * this into the sample it feeds the watchdog and the admission gate.
   */
  Heap: "store-heap",
  Closed: "store-closed",
} as const;
export type DbStoreResponseKind =
  (typeof DbStoreResponseKind)[keyof typeof DbStoreResponseKind];

export type DbStoreOpenRequest = {
  kind: typeof DbStoreRequestKind.Open;
  options: DbHostInitOptions;
};

export type DbStoreExecuteRequest = {
  kind: typeof DbStoreRequestKind.Execute;
  id: number;
  /** A dotted runtime path, or a `store:`-prefixed store-op name. */
  op: string;
  args: unknown[];
  /**
   * ISS-9802 — the renderer cancellation token this op runs under, when it has
   * one. Absent means uncancellable, which is what every write, every backfill
   * and every pre-ISS-9802 read is: the store thread enters no cancellation
   * scope for them, so nothing can abandon them mid-way.
   */
  cancellationToken?: string;
};

/** ISS-9802 — see {@link DbStoreRequestKind.CancelRead}. */
export type DbStoreCancelReadRequest = {
  kind: typeof DbStoreRequestKind.CancelRead;
  token: string;
};

export type DbStoreSetIdentityRequest = {
  kind: typeof DbStoreRequestKind.SetIdentity;
  identity: DbHostUserIdentity;
};

export type DbStoreCloseRequest = {
  kind: typeof DbStoreRequestKind.Close;
};

export type DbStoreRequest =
  | DbStoreOpenRequest
  | DbStoreExecuteRequest
  | DbStoreSetIdentityRequest
  | DbStoreCloseRequest
  | DbStoreCancelReadRequest;

export type DbStoreOpenedResponse = {
  kind: typeof DbStoreResponseKind.Opened;
  error?: DbHostError;
};

export type DbStoreResultResponse = {
  kind: typeof DbStoreResponseKind.Result;
  id: number;
  ok: boolean;
  value?: unknown;
  /**
   * ISS-12022: the successful value, already `v8.serialize`d and TRANSFERRED,
   * so the dispatcher forwards bytes instead of decoding a copy. When present
   * it replaces `value`; a store that cannot encode posts `value` as before.
   */
  encoded?: ArrayBuffer;
  error?: DbHostError;
};

export type DbStoreEmitResponse = {
  kind: typeof DbStoreResponseKind.Emit;
  sessionId: string;
};

export type DbStoreSessionTerminalResponse = {
  kind: typeof DbStoreResponseKind.SessionTerminal;
  sessionId: string;
  status: string;
};

export type DbStoreCommittedWriteResponse = {
  kind: typeof DbStoreResponseKind.CommittedWrite;
};

export type DbStoreWriteTaskResponse = {
  kind: typeof DbStoreResponseKind.WriteTask;
  /** The task's owner — the importer passes the session id. */
  token: WriteQueueTaskToken;
  phase: WriteQueueTaskPhase;
  /** The task's global enqueue order — `WriteDispatchProbe.taskSeq`. */
  taskSeq: number;
};

export type DbStoreLogResponse = {
  kind: typeof DbStoreResponseKind.Log;
  message: string;
};

export type DbStoreDurableLogResponse = {
  kind: typeof DbStoreResponseKind.DurableLog;
  level: DurableLogLevel;
  line: string;
};

export type DbStoreTelemetryResponse = {
  kind: typeof DbStoreResponseKind.Telemetry;
  event: TelemetryEventPayload;
};

export type DbStoreHeapResponse = {
  kind: typeof DbStoreResponseKind.Heap;
  heapUsed: number;
  rss: number;
};

export type DbStoreClosedResponse = {
  kind: typeof DbStoreResponseKind.Closed;
};

export type DbStoreResponse =
  | DbStoreOpenedResponse
  | DbStoreResultResponse
  | DbStoreEmitResponse
  | DbStoreSessionTerminalResponse
  | DbStoreCommittedWriteResponse
  | DbStoreWriteTaskResponse
  | DbStoreLogResponse
  | DbStoreDurableLogResponse
  | DbStoreTelemetryResponse
  | DbStoreHeapResponse
  | DbStoreClosedResponse;

/**
 * True when `value` is a memory sample the dispatcher may ACT on.
 *
 * The whole impossible set, not the two everyone remembers. Negative and
 * non-finite are the ones that get written; what actually reaches a decision is
 * the rest — a FRACTIONAL byte count, and a MAGNITUDE past the safe-integer
 * range, where arithmetic silently stops being exact and `1e300` still answers
 * `Number.isInteger` with `true`. Each of those is a corrupt sample rather than
 * a small or large one, and this sample gates whether heavy work parks.
 *
 * A rejected sample leaves the previous one in place to age out, which is the
 * same fail-safe `isDbHostResponse` applies to `memory-pressure`.
 */
export function isDbStoreMemorySample(value: {
  heapUsed: unknown;
  rss: unknown;
}): value is { heapUsed: number; rss: number } {
  return (
    isNonNegativeByteCount(value.heapUsed) && isNonNegativeByteCount(value.rss)
  );
}

/**
 * The required payload of each response kind, beyond its `kind`.
 *
 * An earlier revision checked `kind` alone for everything but `Heap`, reasoning
 * that both ends of this hop are the same build artifact so there is no version
 * skew to defend against. That was the wrong test. Skew is not the only way a
 * payload goes bad, the type system does not constrain what crosses
 * `postMessage`, and the consequence is not symmetric: a malformed `Result`
 * carrying a live `id` SETTLES the correlated pending op, so arbitrary data
 * flows onward to main as though the store had returned it. A worker payload is
 * a trust boundary (AGENTS.md → Test Practices), and the outer protocol already
 * validates the payloads whose corruption would be acted on, for this reason.
 *
 * Kinds absent from this table carry no payload — `kind` is the whole message.
 */
const RESPONSE_PAYLOAD_CHECKS: ReadonlyMap<
  string,
  (value: Record<string, unknown>) => boolean
> = new Map([
  [
    DbStoreResponseKind.Heap,
    (value) =>
      isDbStoreMemorySample(value as { heapUsed: unknown; rss: unknown }),
  ],
  // `id` must be a usable correlation key before anything is settled by it, and
  // `ok` decides which half of the result is read.
  [
    DbStoreResponseKind.Result,
    (value) =>
      isCorrelationId(value.id) &&
      typeof value.ok === "boolean" &&
      (value.encoded === undefined || value.encoded instanceof ArrayBuffer),
  ],
  [DbStoreResponseKind.Emit, (value) => isNonEmptyString(value.sessionId)],
  // ISS-7256: the dispatcher's mirror is keyed on `token` and ORDERED on
  // `taskSeq`, so a message missing either would corrupt the answer the import
  // bound acts on rather than merely be ignored. `phase` is checked for
  // stringhood only — the mirror maps an unrecognised phase to no state change,
  // which is the same fail-safe a rejected memory sample gets.
  [
    DbStoreResponseKind.WriteTask,
    (value) =>
      isNonEmptyString(value.token) &&
      typeof value.phase === "string" &&
      isCorrelationId(value.taskSeq),
  ],
  [
    DbStoreResponseKind.SessionTerminal,
    (value) =>
      isNonEmptyString(value.sessionId) && typeof value.status === "string",
  ],
  [DbStoreResponseKind.Log, (value) => typeof value.message === "string"],
  // `line` ONLY, matching the outer relay: an unusable `level` is normalised by
  // the writer rather than costing the line, and dropping a durable log line in
  // silence is precisely the defect ISS-7882 was filed for.
  [DbStoreResponseKind.DurableLog, (value) => typeof value.line === "string"],
  [DbStoreResponseKind.Telemetry, (value) => isObject(value.event)],
]);

/** Response kinds that are complete with nothing but their `kind`. */
const PAYLOAD_FREE_RESPONSE_KINDS: ReadonlySet<string> = new Set([
  DbStoreResponseKind.Opened,
  DbStoreResponseKind.Closed,
  DbStoreResponseKind.CommittedWrite,
]);

/**
 * Discriminate an inner response, payload included.
 *
 * A refusal is NOT silent: `db-store-client.ts` logs every message this rejects,
 * because a malformed inner message means the store thread — code we ship in the
 * same bundle — is broken, and that is worth saying out loud. A refused `Result`
 * leaves its op outstanding until the per-class deadline, which is the intended
 * fail-safe: a bounded, loud failure beats settling a caller with a value we
 * cannot trust.
 */
export function isDbStoreResponse(value: unknown): value is DbStoreResponse {
  if (!isObject(value)) {
    return false;
  }
  const kind = value.kind;
  if (typeof kind !== "string") {
    return false;
  }
  const check = RESPONSE_PAYLOAD_CHECKS.get(kind);
  if (check) {
    return check(value);
  }
  return PAYLOAD_FREE_RESPONSE_KINDS.has(kind);
}

/** Discriminate an inner request (the worker's side of the same hop). */
export function isDbStoreRequest(value: unknown): value is DbStoreRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === DbStoreRequestKind.Open ||
    kind === DbStoreRequestKind.Execute ||
    kind === DbStoreRequestKind.SetIdentity ||
    kind === DbStoreRequestKind.Close ||
    kind === DbStoreRequestKind.CancelRead
  );
}

function isNonNegativeByteCount(value: unknown): boolean {
  // `isSafeInteger`, not `isInteger`: the latter answers true for `1e300`, where
  // the value is no longer exactly representable and comparing it against a
  // heap threshold stops meaning anything. It also implies finite, so the
  // separate `isFinite` test it used to carry was redundant.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A correlation key the dispatcher may settle a pending operation by. */
function isCorrelationId(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
