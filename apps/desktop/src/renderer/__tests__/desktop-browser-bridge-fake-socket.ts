import { desktopBrowserBridgeEvent } from "../../shared/desktop-browser-bridge-contract.mjs";

/**
 * The in-memory stand-in for `socket.io-client` the bridge suites share. It
 * imports nothing from the module under test, so a `vi.mock("socket.io-client")`
 * factory can load it without a cycle through the bridge's own import of the
 * real client.
 */
export type FakeBridgeSocket = {
  deliver: (event: string, payload: unknown) => void;
  disconnect: () => void;
  emit: (event: string, payload: unknown) => unknown;
  off: (event: string, handler: (payload: unknown) => void) => unknown;
  on: (event: string, handler: (payload: unknown) => void) => unknown;
  sent: { event: string; payload: unknown }[];
};

/** The client id the broker stamps on every frame in these suites. */
export const CLIENT_ID = "client-1";

/** Every socket `io()` has opened in this module registry, oldest first. */
export const openedSockets: FakeBridgeSocket[] = [];

export function io(): FakeBridgeSocket {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const socket: FakeBridgeSocket = {
    deliver: (event, payload) => {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        handler(payload);
      }
    },
    disconnect: () => undefined,
    emit: (event: string, payload: unknown) => {
      socket.sent.push({ event, payload });
      return socket;
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      handlers.get(event)?.delete(handler);
      return socket;
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      const existing = handlers.get(event) ?? new Set();
      existing.add(handler);
      handlers.set(event, existing);
      return socket;
    },
    sent: [],
  };
  openedSockets.push(socket);
  return socket;
}

export function currentSocket(): FakeBridgeSocket {
  const socket = openedSockets.at(-1);
  if (!socket) {
    throw new Error("no bridge socket was opened");
  }
  return socket;
}

export function callbackFor(callbackId: string): Record<string, unknown> {
  return { args: [], callbackId, clientId: CLIENT_ID };
}

/** The host answers a request across several awaits; settle all of them. */
export function flushHostRequest(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

/** Every payload the socket emitted under one event, oldest first. */
export function sentPayloads(
  socket: FakeBridgeSocket,
  event: string
): unknown[] {
  return socket.sent
    .filter((entry) => entry.event === event)
    .map((entry) => entry.payload);
}

export function lastResponsePayload(
  socket: FakeBridgeSocket
): Record<string, unknown> {
  return lastPayload(socket, desktopBrowserBridgeEvent.response, "response");
}

export function lastRequestPayload(
  socket: FakeBridgeSocket
): Record<string, unknown> {
  return lastPayload(socket, desktopBrowserBridgeEvent.request, "request");
}

export function lastCallbackPayload(
  socket: FakeBridgeSocket
): Record<string, unknown> {
  return lastPayload(socket, desktopBrowserBridgeEvent.callback, "callback");
}

export function requestCount(socket: FakeBridgeSocket): number {
  return sentPayloads(socket, desktopBrowserBridgeEvent.request).length;
}

export function lastRequestId(socket: FakeBridgeSocket): string {
  return lastRequestPayload(socket).requestId as string;
}

export function lastCallbackId(socket: FakeBridgeSocket): string {
  const args = lastRequestPayload(socket).args as { callbackId: string }[];
  return args[0].callbackId;
}

/** Answer the client's latest request the way the broker relays a host reply. */
export function answerLastRequest(
  socket: FakeBridgeSocket,
  answer: { error?: unknown; result?: unknown }
): void {
  socket.deliver(desktopBrowserBridgeEvent.response, {
    clientId: CLIENT_ID,
    requestId: lastRequestId(socket),
    ...answer,
  });
}

/** A request frame as the broker delivers it to the host. */
export function invokeFrame(
  path: string,
  requestId: string,
  overrides: { args?: unknown[]; clientId?: string } = {}
): Record<string, unknown> {
  return {
    args: [],
    clientId: CLIENT_ID,
    kind: "invoke",
    path: [path],
    requestId,
    ...overrides,
  };
}

export function invokeRemoteFrame(
  remoteFunctionId: string,
  requestId: string,
  clientId = CLIENT_ID
): Record<string, unknown> {
  return {
    args: [],
    clientId,
    kind: "invoke-remote",
    remoteFunctionId,
    requestId,
  };
}

function lastPayload(
  socket: FakeBridgeSocket,
  event: string,
  label: string
): Record<string, unknown> {
  const payload = sentPayloads(socket, event).at(-1);
  if (!payload || typeof payload !== "object") {
    throw new Error(`no bridge ${label} was sent`);
  }
  return payload as Record<string, unknown>;
}
