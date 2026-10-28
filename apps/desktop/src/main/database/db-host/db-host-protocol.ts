/**
 * FEA-2038 — message contract between the main process and the DB host
 * utilityProcess that owns the single SQLite instance.
 *
 * The main process sends `init` once, then `invoke` requests (one per DB call);
 * the child replies with a correlated `result`. The child also pushes
 * unsolicited `emit`/`log` notifications. `getUserIdentity` is synchronous inside
 * the runtime, so the main process forwards the current identity via
 * `set-user-identity` and the child serves it from a local cache.
 *
 * All payloads are structured-clone-safe: invoke args and result values are the
 * same plain objects the in-process runtime already returns (query rows are
 * POJOs, no Date/Map/class instances). A store result crosses as the bytes the
 * store thread `v8.serialize`d (ISS-12022, `db-host-result-codec.ts`).
 */

import {
  type StorageExhaustionReason,
  storageReasonOf,
} from "../../../shared/storage-exhaustion.js";
import {
  DesktopMigrationError,
  type MigrationRefusalKind,
} from "../../lifecycle/migration-refusal.js";
import type { DurableLogLevel } from "../../logging/durable-log-sink.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import { isTelemetryEventPayload } from "../../telemetry/telemetry-event-payload.js";
import type { TelemetryEventPayload } from "../../telemetry/telemetry-protocol.js";
import {
  isMemoryPressureLevel,
  type MemoryPressureLevel,
} from "./db-host-memory-watchdog.js";

export const DbHostRequestKind = {
  Init: "init",
  Invoke: "invoke",
  SetUserIdentity: "set-user-identity",
  Close: "close",
  // ISS-9802: main → child request to ABANDON an in-flight read, named by the
  // renderer cancellation token the originating Invoke carried. Fire-and-forget
  // — it correlates to no reply, and the Invoke it cancels settles as a
  // cancellation on its own path. A child that predates this kind ignores it
  // (`isDbHostRequest` refuses it, and the dispatch switch has a `default`
  // return), which leaves the read running exactly as it does today.
  CancelRead: "cancel-read",
  // ISS-12022: main → child request for the next page of a result that arrived
  // with `encodedByteLength` past its first page. Correlated by the Invoke's
  // `id`; answered by a `ResultPage`, or by a failed `Result` when the child no
  // longer holds that result.
  ResultPagePull: "result-page-pull",
} as const;
export type DbHostRequestKind =
  (typeof DbHostRequestKind)[keyof typeof DbHostRequestKind];

export const DbHostResponseKind = {
  Ready: "ready",
  Result: "result",
  Emit: "emit",
  SessionTerminal: "session-terminal",
  Log: "log",
  // ISS-4823: child → main publication of this worker's memory-pressure level,
  // sampled by the heap watchdog. Main caches it (with a staleness bound) so the
  // main-process DATA_REVISION rebuild's adaptive write-pause gate can consult
  // the db-host pressure arm it declares. See DbHostMemoryPressureResponse.
  MemoryPressure: "memory-pressure",
  // ISS-7109: child → main telemetry raised inside this worker. `Observability`
  // is only ever `init`ed in main, so an event emitted here reaches a null
  // transport and is discarded; main re-emits it on the child's behalf, the same
  // way it already emits the child's unexpected-exit event for it.
  Telemetry: "telemetry",
  // ISS-7882: child → main durable main-log line. The file transport is
  // configured in `startup.ts` alone, i.e. only in main, so a `writePersistentLog`
  // call in this worker was taken by the pre-init buffer and never drained —
  // every warning it produced reached no file at all. Main writes the line to
  // `main.log` on the child's behalf, at the child's level.
  DurableLog: "durable-log",
  // ISS-12022: child → main, one page of a paged `Result`, sent per pull.
  ResultPage: "result-page",
} as const;
export type DbHostResponseKind =
  (typeof DbHostResponseKind)[keyof typeof DbHostResponseKind];

/** Mirrors OpenSqliteAgentDatabaseOptions["getUserIdentity"] return shape. */
export type DbHostUserIdentity = {
  userId: string | null;
  organizationId: string | null;
} | null;

/** Subset of OpenSqliteAgentDatabaseOptions the child needs to open the DB. */
export type DbHostInitOptions = {
  dataDir: string;
  staleMinutes?: number;
  identity?: DbHostUserIdentity;
  /**
   * ISS-12552 (PRD-800 "Rollout"): main's parse policy, which the store
   * adopts before it opens. Optional; absent, the store runs the base policy.
   */
  parsePolicy?: ParsePolicy;
};

export type DbHostInitRequest = {
  kind: typeof DbHostRequestKind.Init;
  id: number;
  options: DbHostInitOptions;
};

/**
 * Invoke a DB operation. `op` is a dotted path resolved against the runtime
 * object (e.g. "dashboard.getInsights", "sessions.getAll",
 * "importer.importSession") or a registered store-op name
 * (e.g. "packStore.listPacks"). `args` are passed through verbatim.
 */
export type DbHostInvokeRequest = {
  kind: typeof DbHostRequestKind.Invoke;
  id: number;
  op: string;
  args: unknown[];
  /**
   * ISS-6079: opt-in marker for work that must yield the bounded read lane to
   * interactive reads — today, the cloud-sync drain's corpus-scale hydration.
   *
   * Optional and additive on purpose. ABSENT MEANS INTERACTIVE, so a caller
   * that predates this field (or a version-skewed one that cannot send it) is
   * treated exactly as it is today rather than being silently deprioritised.
   * Only an explicit `true` yields.
   */
  background?: boolean;
  /**
   * ISS-9802: the renderer's cancellation token for this read, forwarded to the
   * store thread so a later {@link DbHostCancelReadRequest} can abandon it at a
   * statement boundary.
   *
   * Optional and OMITTED when absent, for the reason `background` above states:
   * an interactive caller's wire shape stays byte-identical, and a child that
   * has never heard of the field ignores it and runs the read to completion —
   * which is precisely today's behaviour, not a degraded one.
   */
  cancellationToken?: string;
};

/**
 * ISS-9802 — abandon the in-flight read carrying {@link token}.
 *
 * Carries no `id`: it is not correlated and never answered. The read it names
 * rejects through its OWN pending entry, so nothing here needs a reply, and a
 * token naming nothing in flight is a no-op on the child rather than an error.
 */
export type DbHostCancelReadRequest = {
  kind: typeof DbHostRequestKind.CancelRead;
  token: string;
};

export type DbHostSetUserIdentityRequest = {
  kind: typeof DbHostRequestKind.SetUserIdentity;
  identity: DbHostUserIdentity;
};

export type DbHostCloseRequest = {
  kind: typeof DbHostRequestKind.Close;
  id: number;
};

/** ISS-12022 — see {@link DbHostRequestKind.ResultPagePull}. */
export type DbHostResultPagePullRequest = {
  kind: typeof DbHostRequestKind.ResultPagePull;
  id: number;
  /**
   * Bytes main already holds; the page asked for starts here. The abandon
   * offset (`DB_HOST_RESULT_ABANDON_OFFSET`) ends the delivery instead.
   */
  offset: number;
};

export type DbHostRequest =
  | DbHostInitRequest
  | DbHostInvokeRequest
  | DbHostSetUserIdentityRequest
  | DbHostCloseRequest
  | DbHostCancelReadRequest
  | DbHostResultPagePullRequest;

/** Serialized error — Error instances don't structured-clone with stack/message. */
export type DbHostError = {
  message: string;
  stack?: string;
  name?: string;
  /**
   * ISS-4714: the migration-refusal kind when the serialized error is a
   * `DesktopMigrationError`. `instanceof` does not survive structured clone
   * across the DB-host process boundary, so the flattened error loses its
   * `kind`; carrying it here lets `rebuildError` on the main side reconstruct a
   * typed `DesktopMigrationError` and keep the DB-ahead classification working in
   * production. Optional and additive — absent for every non-refusal error and
   * for a version-skewed child that never sets it.
   */
  refusalKind?: MigrationRefusalKind;
  /**
   * ISS-6337: the bounded disk-full verdict, when the child classified this
   * error as one. Carried for the same reason as `refusalKind` above — the
   * driver's result code sits on a `cause` link that structured clone flattens
   * away — and so that the main side never has to re-derive the verdict from
   * message text, which can quote a pack-install child's captured output (see
   * `../storage-exhaustion.ts`). Optional and additive: absent for every other
   * error, and a child that never sets it simply yields no verdict.
   */
  storageExhaustionReason?: StorageExhaustionReason;
};

export type DbHostReadyResponse = {
  kind: typeof DbHostResponseKind.Ready;
  id: number;
  error?: DbHostError;
};

export type DbHostResultResponse = {
  kind: typeof DbHostResponseKind.Result;
  id: number;
  ok: boolean;
  value?: unknown;
  /**
   * ISS-12022: the successful value as the store thread `v8.serialize`d it.
   * When present it replaces `value`, which a child-local answer still uses.
   */
  encoded?: ArrayBuffer;
  /**
   * The whole encoding's length, set only when `encoded` is its FIRST page;
   * main pulls the rest with `ResultPagePull`.
   */
  encodedByteLength?: number;
  error?: DbHostError;
};

/** ISS-12022 — one page of a paged `Result`, starting at `offset`. */
export type DbHostResultPageResponse = {
  kind: typeof DbHostResponseKind.ResultPage;
  id: number;
  offset: number;
  encoded: ArrayBuffer;
};

/** Child → main: a session mutated; main forwards desktop:db:changed. */
export type DbHostEmitResponse = {
  kind: typeof DbHostResponseKind.Emit;
  sessionId: string;
};

/**
 * Child → main: a live SessionEnd hook drove a session to a terminal status.
 * Main fires the desktop completion Notification (gated on the flag).
 */
export type DbHostSessionTerminalResponse = {
  kind: typeof DbHostResponseKind.SessionTerminal;
  sessionId: string;
  status: string;
};

/** Child → main: forward a log line to the main-process logger. */
export type DbHostLogResponse = {
  kind: typeof DbHostResponseKind.Log;
  message: string;
};

/**
 * ISS-4823 — child → main memory-pressure publication. Carries only the bounded
 * level enum, never the raw byte counters: main's sole consumer is a boolean
 * "should the rebuild take the full cooperative pause?" gate, and the byte
 * figures stay in the worker's own log where the thresholds that produced them
 * live. Reported on every watchdog sample while `"high"` and once on the falling
 * edge to `"ok"`, so main can treat an unrefreshed `"high"` as stale.
 */
export type DbHostMemoryPressureResponse = {
  kind: typeof DbHostResponseKind.MemoryPressure;
  level: MemoryPressureLevel;
};

/**
 * ISS-7109 — child → main telemetry relay. `event` is the verbatim
 * {@link TelemetryEventPayload} the child's emit path produced; main hands it to
 * the real transport untouched, so the child never has to know the wire format,
 * the endpoint, or the auth.
 *
 * The payload is validated in {@link isDbHostResponse} down to exactly the three
 * fields the transport requires, and NO further: over-validating here would turn
 * a version-skewed child's extra diagnostics into the very silent drop this
 * message exists to end. Unknown fields ride along and are adjudicated once, by
 * the server-side schema, which already answers `telemetry.validation_failed`
 * out loud.
 */
export type DbHostTelemetryResponse = {
  kind: typeof DbHostResponseKind.Telemetry;
  event: TelemetryEventPayload;
};

/**
 * ISS-7882 — child → main durable log relay. `line` is ALREADY FORMATTED: it is
 * what the child's file transport would have written, so main appends it and
 * neither side has to know the other's line format.
 *
 * `level` is the PRODUCER's contract, not a runtime guarantee: this crosses a
 * process boundary, so {@link isDbHostResponse} checks only `line` and
 * `writeRelayedDurableLog` normalises whatever `level` actually arrives.
 */
export type DbHostDurableLogResponse = {
  kind: typeof DbHostResponseKind.DurableLog;
  level: DurableLogLevel;
  line: string;
};

export type DbHostResponse =
  | DbHostReadyResponse
  | DbHostResultResponse
  | DbHostEmitResponse
  | DbHostSessionTerminalResponse
  | DbHostLogResponse
  | DbHostMemoryPressureResponse
  | DbHostTelemetryResponse
  | DbHostDurableLogResponse
  | DbHostResultPageResponse;

export function serializeDbHostError(error: unknown): DbHostError {
  if (error instanceof DesktopMigrationError) {
    // ISS-4714: carry the refusal `kind` so the main side can rebuild a typed
    // `DesktopMigrationError` (structured clone strips the prototype/`kind`).
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
      refusalKind: error.kind,
    };
  }
  // ISS-6337: classify HERE, in the child, where the driver's result code still
  // exists — it is on a `cause` link the clone below flattens away. Omitted
  // (never `null`) when this is not an exhaustion error, so the field stays
  // absent for the overwhelming majority of errors.
  const storageExhaustionReason = storageReasonOf(error);
  const carried = storageExhaustionReason ? { storageExhaustionReason } : {};
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
      ...carried,
    };
  }
  return { message: String(error), ...carried };
}

export function isDbHostResponse(value: unknown): value is DbHostResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  // ISS-4823: `memory-pressure` is the one response whose PAYLOAD is validated
  // here, not just its kind. The parent caches the level and answers
  // `isUnderMemoryPressure()` from that cache, so a message with a missing or
  // unknown level would evict a valid `"high"` entry and silently disable the
  // rebuild's back-pressure gate. Rejecting it at the boundary leaves the last
  // good sample in place to age out normally. A level this build does not know
  // is treated the same as a missing one — version-skew degrades to the existing
  // no-evidence-of-pressure default rather than to a fabricated state.
  if (kind === DbHostResponseKind.MemoryPressure) {
    return isMemoryPressureLevel((value as { level?: unknown }).level);
  }
  // ISS-7109: the second payload-validated response, for the opposite reason to
  // the one above. Nothing is cached, so a malformed event evicts nothing — but
  // main hands this straight to the transport on the child's behalf, so an event
  // missing the fields the transport routes by would become an unattributable
  // rejection at the far end. Rejecting it here keeps the failure on this side
  // of the boundary, where `handleMessage` logs it locally.
  if (kind === DbHostResponseKind.Telemetry) {
    return isTelemetryEventPayload((value as { event?: unknown }).event);
  }
  // ISS-7882: `line` ONLY, and the asymmetry with the two kinds above is the
  // point. Refusing a message here drops it in silence — `handleMessage` routes a
  // refusal to `reportRefusedChildTelemetry`, which returns early for every kind
  // but `telemetry`. For a telemetry event that silence is the lesser evil; for a
  // DURABLE LOG LINE it is precisely the defect this relay exists to end, so the
  // only field checked is the one main cannot write without. An unusable `level`
  // is degraded and stated by `writeRelayedDurableLog` instead of costing the line.
  if (kind === DbHostResponseKind.DurableLog) {
    return typeof (value as { line?: unknown }).line === "string";
  }
  return (
    kind === DbHostResponseKind.Ready ||
    kind === DbHostResponseKind.Result ||
    kind === DbHostResponseKind.ResultPage ||
    kind === DbHostResponseKind.Emit ||
    kind === DbHostResponseKind.SessionTerminal ||
    kind === DbHostResponseKind.Log
  );
}

export function isDbHostRequest(value: unknown): value is DbHostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === DbHostRequestKind.Init ||
    kind === DbHostRequestKind.Invoke ||
    kind === DbHostRequestKind.SetUserIdentity ||
    kind === DbHostRequestKind.Close ||
    kind === DbHostRequestKind.CancelRead ||
    kind === DbHostRequestKind.ResultPagePull
  );
}

/**
 * ISS-4620 — the typed rejection a {@link DbHostRequest} produces when it cannot
 * cross the process boundary because `child.postMessage` (structured clone) threw
 * — most often because a caller reached a non-cloneable value (a function, class
 * instance, `Error`, or — the ISS-4620 crash — the DB-host method proxy itself)
 * into an invoke's `args`. Rejecting the request's own pending promise with THIS
 * typed error (instead of letting `postMessage` throw out of the `new Promise`
 * executor as an unhandled rejection) is what turns the former fatal
 * "unexpected error" dialog into a handled failure the caller's existing
 * `.catch`/degrade path already recovers from.
 */
export const DB_HOST_DATA_CLONE_ERROR_NAME = "DbHostDataCloneError" as const;

export class DbHostDataCloneError extends Error {
  /** The dotted op path (or request kind) whose payload failed to clone. */
  readonly op: string;

  constructor(op: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `db-host request "${op}" could not be sent: its payload is not structured-clone-safe (${causeMessage})`
    );
    this.name = DB_HOST_DATA_CLONE_ERROR_NAME;
    this.op = op;
  }
}

/** True when `value` is the ISS-4620 clone-failure rejection (name-based so it
 * survives serialization/version skew across the desktop bundle). */
export function isDbHostDataCloneError(value: unknown): boolean {
  return value instanceof Error && value.name === DB_HOST_DATA_CLONE_ERROR_NAME;
}

/**
 * True when `request`'s `id` was allocated from `DbHostClient.nextId` into the
 * `pending` map — i.e. Init, Invoke, Close, or a ResultPagePull, which carries
 * the id of the Invoke whose result it is assembling. Those are the only kinds a
 * main-side correlated lookup (`this.pending.get(id)`) may consult;
 * SetUserIdentity has no `id`.
 */
export function isPendingCorrelatedRequest(
  request: DbHostRequest
): request is
  | DbHostInitRequest
  | DbHostInvokeRequest
  | DbHostCloseRequest
  | DbHostResultPagePullRequest {
  return (
    request.kind === DbHostRequestKind.Init ||
    request.kind === DbHostRequestKind.Invoke ||
    request.kind === DbHostRequestKind.Close ||
    request.kind === DbHostRequestKind.ResultPagePull
  );
}
