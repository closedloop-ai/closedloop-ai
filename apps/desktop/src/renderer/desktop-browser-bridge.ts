import { isRecord } from "@repo/lib/harness/type-guards";
import { io, type Socket } from "socket.io-client";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
  desktopBrowserBridgePath,
  desktopBrowserBridgePayloadTooLargeMessage,
  desktopBrowserBridgeRequestTooLargeMessage,
  desktopBrowserBridgeRole,
  desktopBrowserBridgeTokenParam,
} from "../shared/desktop-browser-bridge-contract.mjs";
import {
  type BridgeInvocation,
  type BridgeManifestNode,
  isWithinBridgePayloadLimit,
  parseBridgeCallback,
  parseBridgeHostRequest,
  parseBridgeManifest,
  parseBridgeResponse,
} from "../shared/desktop-browser-bridge-schema.mjs";
import {
  resolveApiValue,
  selectReadOnlyDesktopApi,
} from "./desktop-browser-bridge-projection";
import { applyBrowserClientTranscriptApi } from "./desktop-browser-bridge-transcript";

/**
 * Connect the real Electron renderer as the sole bridge host. Only the
 * explicitly selected read APIs are copied into the wire-facing object.
 */
export function connectDesktopBrowserBridgeHost(
  desktopApi: unknown
): () => void {
  const socket = createBridgeSocket(desktopBrowserBridgeRole.Host);
  const readOnlyApi = selectReadOnlyDesktopApi(desktopApi);
  const remoteFunctions = new Map<string, RemoteFunctionRecord>();

  socket.on("connect", () => {
    // Every record this host still holds is about to be SUPERSEDED, not merely
    // stale: the manifest below is re-broadcast to every connected client, and a
    // client answers it by re-opening each subscription it holds. On a
    // reconnect — the host's socket dropped, the Electron renderer did not — the
    // closure survives the drop while `clientDisconnected` never fires for a tab
    // that stayed open, so without this the real API keeps the pre-drop listener
    // registered, the client's later teardown only reaches the replacement, and
    // the map grows by one live record per subscription per reconnect.
    releaseRemoteFunctions(remoteFunctions);
    socket.emit(
      desktopBrowserBridgeEvent.manifest,
      createDesktopApiManifest(readOnlyApi)
    );
  });
  socket.on(desktopBrowserBridgeEvent.request, (payload: unknown) => {
    handleHostRequest(payload, readOnlyApi, remoteFunctions, socket).catch(
      () => undefined
    );
  });
  socket.on(
    desktopBrowserBridgeEvent.clientDisconnected,
    (payload: unknown) => {
      if (!isRecord(payload) || typeof payload.clientId !== "string") {
        return;
      }
      releaseClientRemoteFunctions(payload.clientId, remoteFunctions);
    }
  );

  return () => {
    releaseRemoteFunctions(remoteFunctions);
    socket.disconnect();
  };
}

/** Wait for the Electron host, then return the browser-safe desktop API. */
export async function connectDesktopBrowserBridgeClient(
  options: BridgeClientOptions = {}
): Promise<unknown> {
  const socket = createBridgeSocket(desktopBrowserBridgeRole.Client);
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const pending = new Map<string, PendingRequest>();
  const subscriptions = new Set<() => void>();

  socket.on(desktopBrowserBridgeEvent.callback, (payload: unknown) => {
    const message = parseBridgeCallback(payload);
    if (message === null) {
      return;
    }
    callbacks.get(message.callbackId)?.(...message.args.map(decodeRpcValue));
  });
  socket.on(desktopBrowserBridgeEvent.response, (payload: unknown) => {
    settlePendingRequest(payload, pending, callbacks, socket);
  });
  socket.on(desktopBrowserBridgeEvent.hostDisconnected, () => {
    rejectPendingRequests(
      pending,
      new DesktopBrowserBridgeError(
        "Desktop browser bridge host disconnected",
        desktopBrowserBridgeErrorReason.HostDisconnected
      )
    );
    callbacks.clear();
  });
  socket.on("disconnect", () => {
    rejectPendingRequests(
      pending,
      new DesktopBrowserBridgeError(
        "Desktop browser bridge disconnected",
        desktopBrowserBridgeErrorReason.SocketDisconnected
      )
    );
    callbacks.clear();
  });
  // ISS-8248: every callback id the tab holds is released when EITHER side goes
  // away, and nothing re-registered them — the tab kept rendering and silently
  // stopped receiving pushes. A manifest is the one signal both paths raise: the
  // broker sends it to a client that (re)joins, and re-broadcasts it when a new
  // host announces itself. Keying the replay on it therefore covers an Electron
  // renderer reload, which no `connect` on THIS socket would ever report.
  socket.on(desktopBrowserBridgeEvent.manifest, () => {
    for (const resubscribe of subscriptions) {
      resubscribe();
    }
  });

  const manifest = await waitForManifest(socket, options.onHostSlow);
  const desktopApi = createDesktopApiClient(
    manifest,
    (request) => sendClientRequest(request, pending, callbacks, socket),
    [],
    (resubscribe) => {
      subscriptions.add(resubscribe);
      return () => subscriptions.delete(resubscribe);
    }
  );
  if (!isRecord(desktopApi)) {
    throw new Error("Desktop browser bridge returned an invalid API manifest");
  }

  applyBrowserClientLocalApi(desktopApi);
  applyBrowserClientTranscriptApi(desktopApi);
  return desktopApi;
}

export function createDesktopApiManifest(value: unknown): BridgeManifestNode {
  if (typeof value === "function") {
    return { kind: "method" };
  }
  if (value === undefined) {
    return { kind: "undefined" };
  }
  if (!isRecord(value)) {
    return { kind: "value", value };
  }

  const entries: Record<string, BridgeManifestNode> = {};
  for (const [key, child] of Object.entries(value)) {
    entries[key] = createDesktopApiManifest(child);
  }
  return { entries, kind: "object" };
}

export function createDesktopApiClient(
  manifest: BridgeManifestNode,
  invoke: (request: BridgeInvocation) => Promise<unknown>,
  path: string[] = [],
  registerSubscription: RegisterSubscription = () => () => undefined
): unknown {
  if (manifest.kind === "method") {
    if (browserBridgeSubscriptionMethodPaths.has(path.join("."))) {
      return (...args: unknown[]) => {
        let isClosed = false;
        let remoteUnsubscribe: unknown;
        const open = (): void => {
          remoteUnsubscribe = undefined;
          invoke({ args, kind: "invoke", path })
            .then((result) => {
              remoteUnsubscribe = result;
              if (isClosed && typeof remoteUnsubscribe === "function") {
                return remoteUnsubscribe();
              }
              return undefined;
            })
            .catch(() => undefined);
        };
        open();
        const release = registerSubscription(open);

        return () => {
          isClosed = true;
          release();
          if (typeof remoteUnsubscribe === "function") {
            remoteUnsubscribe();
          }
        };
      };
    }
    return (...args: unknown[]) => invoke({ args, kind: "invoke", path });
  }
  if (manifest.kind === "undefined") {
    return undefined;
  }
  if (manifest.kind === "value") {
    return manifest.value;
  }

  const value: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(manifest.entries)) {
    value[key] = createDesktopApiClient(
      child,
      invoke,
      [...path, key],
      registerSubscription
    );
  }
  return value;
}

/**
 * Methods the browser mirror answers ITSELF rather than relaying.
 *
 * Two reasons, and they are different. `exportOtelTelemetry` and
 * `notifyRendererReady` describe the native renderer, so relaying them would
 * duplicate readiness and telemetry facts. The three auth mutators are a
 * capability gap: `hasDesktopAuthBridge()` probes `getDesktopAuthState` alone
 * and this mirror exposes it, so `DesktopAuthProvider` takes its bridge-PRESENT
 * branch and reaches for mutators a read-only bridge deliberately omits. Absent,
 * they would throw on `undefined`; here they return the same shapes that
 * provider's own bridge-absent fallback returns, so the sidecar's sign-in and
 * sign-out controls report "unavailable" honestly.
 */
export function applyBrowserClientLocalApi(
  desktopApi: Record<string, unknown>
): void {
  desktopApi.exportOtelTelemetry = undefined;
  desktopApi.notifyRendererReady = () => undefined;
  desktopApi.beginDesktopSignIn = () =>
    Promise.resolve({ ok: false, reason: "unavailable" });
  desktopApi.cancelDesktopSignIn = () => Promise.resolve();
  desktopApi.signOutDesktop = () => Promise.resolve();
}

async function handleHostRequest(
  payload: unknown,
  readOnlyApi: Record<string, unknown>,
  remoteFunctions: Map<string, RemoteFunctionRecord>,
  socket: Socket
): Promise<void> {
  const request = parseBridgeHostRequest(payload);
  if (request === null) {
    return;
  }

  try {
    let result: unknown;
    if (request.kind === "invoke-remote") {
      const record = remoteFunctions.get(request.remoteFunctionId);
      if (!record || record.clientId !== request.clientId) {
        throw new Error("Desktop browser bridge function is unavailable");
      }
      result = await record.value(
        ...decodeHostArguments(request.args, request.clientId, socket)
      );
      remoteFunctions.delete(request.remoteFunctionId);
    } else {
      const resolved = resolveApiValue(readOnlyApi, request.path);
      if (typeof resolved.value !== "function") {
        throw new Error("Desktop browser bridge path is not callable");
      }
      result = await resolved.value.apply(
        resolved.parent,
        decodeHostArguments(request.args, request.clientId, socket)
      );
    }

    emitHostResponse(socket, {
      clientId: request.clientId,
      requestId: request.requestId,
      result: encodeHostResult(result, request.clientId, remoteFunctions),
    });
  } catch (error) {
    socket.emit(desktopBrowserBridgeEvent.response, {
      clientId: request.clientId,
      error: {
        message: error instanceof Error ? error.message : String(error),
        reason: desktopBrowserBridgeErrorReason.HostError,
      },
      requestId: request.requestId,
    });
  }
}

/**
 * Emit a host response, refusing an over-size one HERE rather than on the wire.
 *
 * The broker also refuses (ISS-8249), but it can only refuse what reaches it,
 * and an over-size frame does not: engine.io's `maxHttpBufferSize` closes the
 * host socket on the way in, which takes down the one relay host and every
 * connected tab with it, and the correlated refusal is never emitted at all. So
 * the request that could not be answered is answered with the refusal instead —
 * a small envelope on a socket that is still up.
 */
function emitHostResponse(socket: Socket, response: HostResponse): void {
  if (isWithinBridgePayloadLimit(response)) {
    socket.emit(desktopBrowserBridgeEvent.response, response);
    return;
  }
  socket.emit(desktopBrowserBridgeEvent.response, {
    clientId: response.clientId,
    error: {
      message: desktopBrowserBridgePayloadTooLargeMessage,
      reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
    },
    requestId: response.requestId,
  });
}

function sendClientRequest(
  request: BridgeInvocation,
  pending: Map<string, PendingRequest>,
  callbacks: Map<string, (...args: unknown[]) => void>,
  socket: Socket
): Promise<unknown> {
  const requestId = globalThis.crypto.randomUUID();
  const callbackIds: string[] = [];
  const payload = {
    ...request,
    args: request.args.map((value) =>
      encodeClientArgument(value, callbacks, callbackIds)
    ),
    requestId,
  };
  const releaseCallbacks = () => {
    for (const callbackId of callbackIds) {
      callbacks.delete(callbackId);
    }
  };

  // ISS-8413, the mirror of `emitHostResponse`: refuse HERE rather than on the
  // wire. The broker refuses too, but only what reaches it — a request past
  // engine.io's cap trips the transport instead, which drops the tab's own
  // socket and reports a disconnect, so the caller is told the bridge died
  // rather than that its payload was too big. Refusing before the emit also
  // arms no timer and creates no pending entry, so there is nothing to sweep
  // back out and no id left behind in the map.
  if (!isWithinBridgePayloadLimit(payload.args)) {
    releaseCallbacks();
    return Promise.reject(
      new DesktopBrowserBridgeError(
        desktopBrowserBridgeRequestTooLargeMessage,
        desktopBrowserBridgeErrorReason.PayloadTooLarge
      )
    );
  }

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pending.delete(requestId);
      releaseCallbacks();
      reject(
        new DesktopBrowserBridgeError(
          "Desktop browser bridge request timed out",
          desktopBrowserBridgeErrorReason.Timeout
        )
      );
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { reject, releaseCallbacks, resolve, timeout });
    socket.emit(desktopBrowserBridgeEvent.request, payload);
  });
}

function settlePendingRequest(
  payload: unknown,
  pending: Map<string, PendingRequest>,
  callbacks: Map<string, (...args: unknown[]) => void>,
  socket: Socket
): void {
  const response = parseBridgeResponse(payload);
  if (response === null) {
    return;
  }
  const request = pending.get(response.requestId);
  if (!request) {
    return;
  }
  globalThis.clearTimeout(request.timeout);
  pending.delete(response.requestId);

  if (response.error) {
    request.releaseCallbacks();
    request.reject(
      new DesktopBrowserBridgeError(
        response.error.message,
        response.error.reason ?? desktopBrowserBridgeErrorReason.Unknown
      )
    );
    return;
  }
  request.resolve(
    decodeClientResult(
      response.result,
      (remoteFunctionId, args) =>
        sendClientRequest(
          { args, kind: "invoke-remote", remoteFunctionId },
          pending,
          callbacks,
          socket
        ),
      request.releaseCallbacks
    )
  );
}

/**
 * ISS-8248: the host-ready window no longer REJECTS. The launcher hands out the
 * URL before Electron has connected, and on a cold tree the gap exceeds any
 * fixed window; rejecting tore the manifest listener down, so a host that
 * arrived a second later could never mount the tab without a manual reload. The
 * wait is now open-ended and the elapsed window only reports that the host is
 * still coming, so the page can say so instead of claiming to be connecting.
 */
function waitForManifest(
  socket: Socket,
  onHostSlow?: () => void
): Promise<BridgeManifestNode> {
  return new Promise((resolve, reject) => {
    const slowTimer = globalThis.setTimeout(() => {
      onHostSlow?.();
    }, HOST_READY_TIMEOUT_MS);
    const onManifest = (value: unknown): void => {
      const manifest = parseBridgeManifest(value);
      if (manifest === null) {
        return;
      }
      cleanup();
      resolve(manifest);
    };
    const onConnectError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      globalThis.clearTimeout(slowTimer);
      socket.off("connect_error", onConnectError);
      socket.off(desktopBrowserBridgeEvent.manifest, onManifest);
    };

    socket.on("connect_error", onConnectError);
    socket.on(desktopBrowserBridgeEvent.manifest, onManifest);
  });
}

function createBridgeSocket(role: "client" | "host"): Socket {
  return io(globalThis.location.origin, {
    auth: { role, token: readBridgeToken(role) },
    path: desktopBrowserBridgePath,
    transports: ["websocket"],
  });
}

function readBridgeToken(role: "client" | "host"): string {
  if (
    import.meta.env.DEV !== true ||
    import.meta.env.VITE_DESKTOP_BROWSER_BRIDGE_ENABLED !== "1"
  ) {
    throw new Error("Desktop browser bridge is not enabled for this build");
  }
  const token = takeBridgeTokenFromUrl(role);
  if (token.length === 0) {
    throw new Error("Desktop browser bridge launch token is missing");
  }
  return token;
}

/**
 * Take this document's launch token off its own URL and keep it for the tab.
 *
 * The token is a per-launch credential the LAUNCHER printed, never a value the
 * dev server will hand out: a process that can only fetch the served assets
 * finds no token in them and therefore cannot connect. It moves into
 * `sessionStorage` (per tab, same origin, not readable over HTTP) and comes off
 * the address bar immediately, so a reload still works while the credential
 * stops riding in a copyable URL.
 */
export function takeBridgeTokenFromUrl(role: "client" | "host"): string {
  const storageKey = `${BRIDGE_TOKEN_STORAGE_PREFIX}${role}`;
  const url = new URL(globalThis.location.href);
  const fromUrl = url.searchParams.get(desktopBrowserBridgeTokenParam) ?? "";
  const storage = resolveSessionStorage();
  if (fromUrl.length === 0) {
    return storage?.getItem(storageKey) ?? "";
  }
  if (!storage) {
    // Without a place to keep it, stripping the URL would break the next
    // reload, so the token stays where the launcher put it.
    return fromUrl;
  }

  storage.setItem(storageKey, fromUrl);
  url.searchParams.delete(desktopBrowserBridgeTokenParam);
  globalThis.history.replaceState(null, "", url.href);
  return fromUrl;
}

function resolveSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function encodeClientArgument(
  value: unknown,
  callbacks: Map<string, (...args: unknown[]) => void>,
  callbackIds: string[]
): unknown {
  if (typeof value === "function") {
    const callbackId = globalThis.crypto.randomUUID();
    callbacks.set(callbackId, value as (...args: unknown[]) => void);
    callbackIds.push(callbackId);
    return { bridgeType: "callback", callbackId };
  }
  return encodeRpcValue(value);
}

function decodeHostArguments(
  values: unknown[],
  clientId: string,
  socket: Socket
): unknown[] {
  return values.map((value) => {
    if (
      isRecord(value) &&
      Object.keys(value).length === 2 &&
      value.bridgeType === "callback"
    ) {
      if (typeof value.callbackId !== "string") {
        throw new Error("Desktop browser bridge callback is invalid");
      }
      return (...args: unknown[]) => {
        const payload = {
          args: args.map(encodeRpcValue),
          callbackId: value.callbackId,
          clientId,
        };
        // Same transport cap as a response, and a push has no request to
        // correlate a refusal to — so the choice is dropping this one push or
        // losing the socket, and with it every tab's subscriptions. The broker
        // already drops an over-size callback; dropping it here keeps the frame
        // off the wire, where it would close the connection first.
        if (!isWithinBridgePayloadLimit(payload)) {
          return;
        }
        socket.emit(desktopBrowserBridgeEvent.callback, payload);
      };
    }
    return decodeRpcValue(value);
  });
}

function encodeHostResult(
  value: unknown,
  clientId: string,
  remoteFunctions: Map<string, RemoteFunctionRecord>
): unknown {
  if (typeof value === "function") {
    const remoteFunctionId = globalThis.crypto.randomUUID();
    remoteFunctions.set(remoteFunctionId, {
      clientId,
      value: value as (...args: unknown[]) => unknown,
    });
    return { bridgeType: "remote-function", remoteFunctionId };
  }
  return encodeRpcValue(value);
}

function decodeClientResult(
  value: unknown,
  invokeRemote: (remoteFunctionId: string, args: unknown[]) => Promise<unknown>,
  releaseCallbacks: () => void
): unknown {
  if (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.bridgeType === "remote-function"
  ) {
    if (typeof value.remoteFunctionId !== "string") {
      throw new Error("Desktop browser bridge function result is invalid");
    }
    const remoteFunctionId = value.remoteFunctionId;
    return (...args: unknown[]) => {
      releaseCallbacks();
      return invokeRemote(remoteFunctionId, args);
    };
  }
  releaseCallbacks();
  return decodeRpcValue(value);
}

function encodeRpcValue(value: unknown): unknown {
  if (value === undefined) {
    return { bridgeType: "undefined" };
  }
  if (typeof value === "bigint") {
    return { bridgeType: "bigint", value: value.toString() };
  }
  if (value instanceof Date) {
    return { bridgeType: "date", value: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRpcValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeRpcValue(child)])
    );
  }
  return value;
}

function decodeRpcValue(value: unknown): unknown {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    value.bridgeType === "undefined"
  ) {
    return undefined;
  }
  if (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.bridgeType === "bigint" &&
    typeof value.value === "string"
  ) {
    return BigInt(value.value);
  }
  if (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.bridgeType === "date" &&
    typeof value.value === "string"
  ) {
    return new Date(value.value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeRpcValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeRpcValue(child)])
    );
  }
  return value;
}

function releaseClientRemoteFunctions(
  clientId: string,
  remoteFunctions: Map<string, RemoteFunctionRecord>
): void {
  for (const [id, record] of remoteFunctions.entries()) {
    if (record.clientId !== clientId) {
      continue;
    }
    invokeCleanup(record.value);
    remoteFunctions.delete(id);
  }
}

/** Run and forget every remote function this host holds, for any client. */
function releaseRemoteFunctions(
  remoteFunctions: Map<string, RemoteFunctionRecord>
): void {
  for (const record of remoteFunctions.values()) {
    invokeCleanup(record.value);
  }
  remoteFunctions.clear();
}

function invokeCleanup(value: (...args: unknown[]) => unknown): void {
  try {
    value();
  } catch {
    // Subscription cleanup is best-effort during bridge teardown.
  }
}

function rejectPendingRequests(
  pending: Map<string, PendingRequest>,
  error: Error
): void {
  for (const request of pending.values()) {
    globalThis.clearTimeout(request.timeout);
    request.releaseCallbacks();
    request.reject(error);
  }
  pending.clear();
}

const browserBridgeSubscriptionMethodPaths = new Set<string>([
  "onDbChanged",
  "onDesktopAuthStateChanged",
  "onFlagsChanged",
  "onSyncConsentRecordChanged",
]);
const BRIDGE_TOKEN_STORAGE_PREFIX = "closedloop-desktop-browser-bridge:";
const HOST_READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  reject: (error: Error) => void;
  releaseCallbacks: () => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};
type RemoteFunctionRecord = {
  clientId: string;
  value: (...args: unknown[]) => unknown;
};
type HostResponse = {
  clientId: string;
  requestId: string;
  result: unknown;
};
type RegisterSubscription = (resubscribe: () => void) => () => void;
type BridgeClientOptions = {
  /** The host has not arrived within {@link HOST_READY_TIMEOUT_MS}. */
  onHostSlow?: () => void;
};

/**
 * A bridge failure that says WHICH failure it was. A size refusal, a dead host
 * and an elapsed request window all used to reach the caller as a bare `Error`
 * — and, before ISS-8249, the first of those arrived wearing the third's
 * message. An older peer that sends no reason lands on `UNKNOWN`.
 */
export class DesktopBrowserBridgeError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "DesktopBrowserBridgeError";
    this.reason = reason;
  }
}
