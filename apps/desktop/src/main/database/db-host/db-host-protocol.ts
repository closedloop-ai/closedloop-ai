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
 * POJOs, no Date/Map/class instances), so nothing needs custom (de)serialization.
 */

import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../../shared/scheduled-review-contract.js";
import {
  DesktopMigrationError,
  type MigrationRefusalKind,
} from "../../lifecycle/migration-refusal.js";
import {
  isMemoryPressureLevel,
  type MemoryPressureLevel,
} from "./db-host-memory-watchdog.js";

export const DbHostRequestKind = {
  Init: "init",
  Invoke: "invoke",
  SetUserIdentity: "set-user-identity",
  Close: "close",
  // FEA-4143: main → child REPLY to a ScheduledReviewRun request the child
  // raised. Correlated by `id` to the originating child request.
  ScheduledReviewResult: "scheduled-review-result",
} as const;
export type DbHostRequestKind =
  (typeof DbHostRequestKind)[keyof typeof DbHostRequestKind];

export const DbHostResponseKind = {
  Ready: "ready",
  Result: "result",
  Emit: "emit",
  SessionTerminal: "session-terminal",
  Log: "log",
  // FEA-3814 (PRD-553 M2): the crewd scheduler (in this child) changed its tasks
  // or runs; main forwards desktop:scheduled-tasks:changed to the renderer.
  SchedulerChanged: "scheduler-changed",
  // FEA-4143: child → main REQUEST to run a scheduled review pass through the
  // main-process AuditService (the daemon in this child has neither the access
  // token nor the shell PATH, and must never run the cascade against the live
  // checkout). Main replies with a correlated ScheduledReviewResult request.
  ScheduledReviewRun: "scheduled-review-run",
  // ISS-4823: child → main publication of this worker's memory-pressure level,
  // sampled by the heap watchdog. Main caches it (with a staleness bound) so the
  // main-process DATA_REVISION rebuild's adaptive write-pause gate can consult
  // the db-host pressure arm it declares. See DbHostMemoryPressureResponse.
  MemoryPressure: "memory-pressure",
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
};

export type DbHostSetUserIdentityRequest = {
  kind: typeof DbHostRequestKind.SetUserIdentity;
  identity: DbHostUserIdentity;
};

export type DbHostCloseRequest = {
  kind: typeof DbHostRequestKind.Close;
  id: number;
};

/**
 * FEA-4143 — main → child reply to a {@link DbHostScheduledReviewRunResponse}.
 * Carries the structured result (or a serialized error) back to the child's
 * dispatch, correlated by the originating request `id` AND `generation`.
 *
 * `generation` (Tzqf1): the reverse-RPC `id` restarts at 1 with every forked
 * worker, but this reply travels through whatever child `DbHostClient.child`
 * owns at delivery time. If the DB-host worker crashes mid-audit and a
 * replacement forks, a late reply for old-worker-id=1 would otherwise resolve an
 * UNRELATED id=1 pending review in the replacement child. Main echoes the
 * originating worker's `generation` verbatim (it is opaque to main); the child
 * drops any reply whose generation ≠ its own, so a stale result can never
 * cross-talk into the replacement worker.
 */
export type DbHostScheduledReviewResultRequest = {
  kind: typeof DbHostRequestKind.ScheduledReviewResult;
  id: number;
  /** The originating worker's generation, echoed back verbatim (opaque to main). */
  generation: string;
  ok: boolean;
  value?: ScheduledReviewResult;
  error?: DbHostError;
};

export type DbHostRequest =
  | DbHostInitRequest
  | DbHostInvokeRequest
  | DbHostSetUserIdentityRequest
  | DbHostCloseRequest
  | DbHostScheduledReviewResultRequest;

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
  error?: DbHostError;
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
 * Child → main: the crewd scheduler ticked / started / stopped and its tasks or
 * runs may have changed. Payload-free — main forwards a bare
 * desktop:scheduled-tasks:changed and the renderer refetches list + runs
 * (FEA-3814 / PRD-553 M2).
 */
export type DbHostSchedulerChangedResponse = {
  kind: typeof DbHostResponseKind.SchedulerChanged;
};

/**
 * FEA-4143 — child → main request to run a scheduled review pass through the
 * main-process AuditService. `id` correlates the reply
 * ({@link DbHostScheduledReviewResultRequest}). `request` is the already-validated
 * night-crew config for the fired task.
 */
export type DbHostScheduledReviewRunResponse = {
  kind: typeof DbHostResponseKind.ScheduledReviewRun;
  id: number;
  /**
   * Tzqf1 — the forking worker's generation token, minted once per worker
   * instance. Main echoes it back on the reply so a stale result from a crashed
   * worker cannot be delivered into an unrelated same-`id` request in the
   * replacement worker (whose `id` counter also restarts at 1).
   */
  generation: string;
  request: ScheduledReviewRequest;
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

export type DbHostResponse =
  | DbHostReadyResponse
  | DbHostResultResponse
  | DbHostEmitResponse
  | DbHostSessionTerminalResponse
  | DbHostLogResponse
  | DbHostSchedulerChangedResponse
  | DbHostScheduledReviewRunResponse
  | DbHostMemoryPressureResponse;

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
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }
  return { message: String(error) };
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
  return (
    kind === DbHostResponseKind.Ready ||
    kind === DbHostResponseKind.Result ||
    kind === DbHostResponseKind.Emit ||
    kind === DbHostResponseKind.SessionTerminal ||
    kind === DbHostResponseKind.Log ||
    kind === DbHostResponseKind.SchedulerChanged ||
    kind === DbHostResponseKind.ScheduledReviewRun
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
    kind === DbHostRequestKind.ScheduledReviewResult
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
