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

export const DbHostRequestKind = {
  Init: "init",
  Invoke: "invoke",
  SetUserIdentity: "set-user-identity",
  Close: "close",
} as const;
export type DbHostRequestKind =
  (typeof DbHostRequestKind)[keyof typeof DbHostRequestKind];

export const DbHostResponseKind = {
  Ready: "ready",
  Result: "result",
  Emit: "emit",
  SessionTerminal: "session-terminal",
  Log: "log",
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
};

export type DbHostSetUserIdentityRequest = {
  kind: typeof DbHostRequestKind.SetUserIdentity;
  identity: DbHostUserIdentity;
};

export type DbHostCloseRequest = {
  kind: typeof DbHostRequestKind.Close;
  id: number;
};

export type DbHostRequest =
  | DbHostInitRequest
  | DbHostInvokeRequest
  | DbHostSetUserIdentityRequest
  | DbHostCloseRequest;

/** Serialized error — Error instances don't structured-clone with stack/message. */
export type DbHostError = {
  message: string;
  stack?: string;
  name?: string;
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

export type DbHostResponse =
  | DbHostReadyResponse
  | DbHostResultResponse
  | DbHostEmitResponse
  | DbHostSessionTerminalResponse
  | DbHostLogResponse;

export function serializeDbHostError(error: unknown): DbHostError {
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
  return (
    kind === DbHostResponseKind.Ready ||
    kind === DbHostResponseKind.Result ||
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
    kind === DbHostRequestKind.Close
  );
}
