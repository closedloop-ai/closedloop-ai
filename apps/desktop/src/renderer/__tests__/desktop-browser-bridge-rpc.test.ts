import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
} from "../../shared/desktop-browser-bridge-contract.mjs";
import {
  connectDesktopBrowserBridgeClient,
  createDesktopApiClient,
  createDesktopApiManifest,
  DesktopBrowserBridgeError,
  takeBridgeTokenFromUrl,
} from "../desktop-browser-bridge";
import {
  answerLastRequest,
  CLIENT_ID,
  currentSocket,
  type FakeBridgeSocket,
  flushHostRequest,
  invokeFrame,
  invokeRemoteFrame,
  lastCallbackId,
  lastCallbackPayload,
  lastRequestId,
  lastRequestPayload,
  lastResponsePayload,
  openedSockets,
  requestCount,
  sentPayloads,
} from "./desktop-browser-bridge-fake-socket";
import {
  connectFakeClient,
  connectFakeHost,
  connectReadClient,
  connectSubscribingClient,
  isStillPending,
  issueLaunchToken,
  OVER_LIMIT_PAYLOAD_LENGTH,
  resetBridgeDocument,
} from "./desktop-browser-bridge-harness";

vi.mock("socket.io-client", async () => {
  const { io } = await import("./desktop-browser-bridge-fake-socket");
  return { io };
});

// ISS-10696: the wire codec and the refusal arms of the bridge, pinned from
// BOTH ends — a client socket and a host socket in the same registry, with the
// test carrying each frame across by hand. `desktop-browser-bridge.test.ts`
// owns the lifecycle and size-refusal contracts; this file owns what crosses
// the wire and what each side does with a frame it cannot use.

beforeEach(() => {
  resetBridgeDocument(LAUNCH_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("value codec across the wire", () => {
  it("carries undefined, null, bigint, Date, arrays and nested records through both ends intact", async () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const read = vi.fn((..._args: unknown[]) =>
      Promise.resolve({
        big: 7n,
        list: [1n, undefined, null],
        missing: undefined,
        nested: { ok: true },
        nothing: null,
        when,
      })
    );
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      getAllFlags: read,
    });

    reissueLaunchToken();
    const desktopApi = await connectFakeClient(flagsManifest);
    const clientSocket = currentSocket();
    const getAllFlags = desktopApi.getAllFlags as (
      ...args: unknown[]
    ) => Promise<unknown>;

    const sent = new Date("2025-12-31T23:59:59.000Z");
    const settling = getAllFlags(
      sent,
      9n,
      undefined,
      [2n, null],
      {
        deep: undefined,
      },
      null
    );
    const request = lastRequestPayload(clientSocket);
    expect(request.args).toEqual([
      { bridgeType: "date", value: "2025-12-31T23:59:59.000Z" },
      { bridgeType: "bigint", value: "9" },
      { bridgeType: "undefined" },
      [{ bridgeType: "bigint", value: "2" }, null],
      { deep: { bridgeType: "undefined" } },
      null,
    ]);

    relayRequest(clientSocket, hostSocket);
    await flushHostRequest();
    expect(read).toHaveBeenCalledTimes(1);
    const received = read.mock.calls[0];
    expect(received[0]).toBeInstanceOf(Date);
    expect((received[0] as Date).toISOString()).toBe(sent.toISOString());
    expect(received.slice(1)).toEqual([
      9n,
      undefined,
      [2n, null],
      { deep: undefined },
      null,
    ]);

    const response = lastResponsePayload(hostSocket);
    expect(response.result).toEqual({
      big: { bridgeType: "bigint", value: "7" },
      list: [
        { bridgeType: "bigint", value: "1" },
        { bridgeType: "undefined" },
        null,
      ],
      missing: { bridgeType: "undefined" },
      nested: { ok: true },
      nothing: null,
      when: { bridgeType: "date", value: "2026-01-02T03:04:05.000Z" },
    });

    clientSocket.deliver(desktopBrowserBridgeEvent.response, response);
    const decoded = (await settling) as Record<string, unknown>;
    expect(decoded.when).toBeInstanceOf(Date);
    expect((decoded.when as Date).toISOString()).toBe(when.toISOString());
    expect(decoded.big).toBe(7n);
    expect(decoded.list).toEqual([1n, undefined, null]);
    expect(decoded.nothing).toBeNull();
    expect(Object.hasOwn(decoded, "missing")).toBe(true);
    expect(decoded.missing).toBeUndefined();
    expect(decoded.nested).toEqual({ ok: true });
    disconnectHost();
  });

  it("leaves a marker with the wrong value type or an extra key as the record it arrived as", async () => {
    const { read, socket } = await connectReadClient();
    const shapes = {
      notBig: { bridgeType: "bigint", value: 3 },
      notDate: { bridgeType: "date", value: 5 },
      notUndefined: { bridgeType: "undefined", extra: true },
      plain: 4,
      wideBig: { bridgeType: "bigint", extra: 1, value: "3" },
      wideDate: {
        bridgeType: "date",
        extra: 1,
        value: "2026-01-02T03:04:05.000Z",
      },
    };

    const settling = read();
    answerLastRequest(socket, { result: shapes });

    await expect(settling).resolves.toEqual(shapes);
  });

  it("decodes a marker that is the whole result, not only one nested in a record", async () => {
    const { read, socket } = await connectReadClient();

    const settling = read();
    answerLastRequest(socket, {
      result: { bridgeType: "bigint", value: "3" },
    });

    await expect(settling).resolves.toBe(3n);
  });

  it("leaves a remote-function marker carrying an extra key as a plain record", async () => {
    const { read, socket } = await connectReadClient();
    const shape = {
      bridgeType: "remote-function",
      extra: 1,
      remoteFunctionId: "r",
    };

    const settling = read();
    answerLastRequest(socket, { result: shape });

    await expect(settling).resolves.toEqual(shape);
  });
});

describe("host pushes to a client callback", () => {
  it("encodes the push, and the client decodes it before calling the listener", async () => {
    let push: ((...args: unknown[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      onDbChanged: (listener: (...args: unknown[]) => void) => {
        push = listener;
        return unsubscribe;
      },
    });
    reissueLaunchToken();
    const { socket: clientSocket, subscribe } =
      await connectSubscribingClient();
    const listener = vi.fn();
    const close = subscribe(listener);
    const callbackId = lastCallbackId(clientSocket);

    relayRequest(clientSocket, hostSocket);
    await flushHostRequest();
    expect(push).toBeTypeOf("function");
    // Carry the host's answer back, or the registration's 30s timer stays
    // armed after this file's worker has moved on.
    relayResponse(hostSocket, clientSocket);

    push?.("change", undefined, 3n);
    const pushed = lastCallbackPayload(hostSocket);
    expect(pushed).toEqual({
      args: [
        "change",
        { bridgeType: "undefined" },
        { bridgeType: "bigint", value: "3" },
      ],
      callbackId,
      clientId: CLIENT_ID,
    });

    clientSocket.deliver(desktopBrowserBridgeEvent.callback, pushed);
    expect(listener).toHaveBeenCalledWith("change", undefined, 3n);

    close();
    // The remote unsubscribe is issued once the registration's `.then` runs.
    await flushHostRequest();
    relayRequest(clientSocket, hostSocket);
    await flushHostRequest();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    relayResponse(hostSocket, clientSocket);
    disconnectHost();
  });

  it("drops an over-size push rather than putting the frame on the wire", async () => {
    let push: ((...args: unknown[]) => void) | undefined;
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      onDbChanged: (listener: (...args: unknown[]) => void) => {
        push = listener;
        return () => undefined;
      },
    });
    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("onDbChanged", "request-subscribe", {
        args: [{ bridgeType: "callback", callbackId: "cb-1" }],
      })
    );
    await flushHostRequest();
    const before = hostSocket.sent.length;

    expect(push).toBeTypeOf("function");
    push?.("x".repeat(OVER_LIMIT_PAYLOAD_LENGTH));

    expect(hostSocket.sent.length).toBe(before);
    disconnectHost();
  });

  it("refuses a callback marker whose id is not a string", async () => {
    const { disconnect: disconnectHost, socket: hostSocket } =
      connectFakeHost();

    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("onDbChanged", "request-bad-callback", {
        args: [{ bridgeType: "callback", callbackId: 42 }],
      })
    );
    await flushHostRequest();

    expect(lastResponsePayload(hostSocket)).toEqual({
      clientId: CLIENT_ID,
      error: {
        message: "Desktop browser bridge callback is invalid",
        reason: desktopBrowserBridgeErrorReason.HostError,
      },
      requestId: "request-bad-callback",
    });
    disconnectHost();
  });

  it("passes a record that is not exactly a callback marker through as data", async () => {
    const read = vi.fn((..._args: unknown[]) => Promise.resolve(null));
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      getAllFlags: read,
    });

    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("getAllFlags", "request-plain", {
        args: [
          { bridgeType: "other", callbackId: "cb-1" },
          { bridgeType: "callback", callbackId: "cb-2", extra: 1 },
        ],
      })
    );
    await flushHostRequest();

    expect(read).toHaveBeenCalledWith(
      { bridgeType: "other", callbackId: "cb-1" },
      { bridgeType: "callback", callbackId: "cb-2", extra: 1 }
    );
    disconnectHost();
  });

  it("ignores a push the callback schema rejects", async () => {
    const { socket, subscribe } = await connectSubscribingClient();
    const listener = vi.fn();
    const close = subscribe(listener);

    socket.deliver(desktopBrowserBridgeEvent.callback, {
      callbackId: lastCallbackId(socket),
    });

    expect(listener).not.toHaveBeenCalled();
    // Settle the registration so its 30s timer does not outlive the case.
    answerLastRequest(socket, { result: undefined });
    close();
  });
});

describe("host request refusals", () => {
  let disconnectHost: () => void;
  let hostSocket: FakeBridgeSocket;

  beforeEach(() => {
    const host = connectFakeHost({
      getAllFlags: () => Promise.reject("flags exploded"),
    });
    disconnectHost = host.disconnect;
    hostSocket = host.socket;
  });

  afterEach(() => {
    disconnectHost();
  });

  it("answers nothing to a frame the request schema rejects", async () => {
    hostSocket.deliver(desktopBrowserBridgeEvent.request, {
      args: [],
      clientId: CLIENT_ID,
      kind: "invoke",
      path: ["getSettings"],
    });
    await flushHostRequest();

    expect(
      sentPayloads(hostSocket, desktopBrowserBridgeEvent.response)
    ).toEqual([]);
  });

  it("refuses to invoke a projected value as if it were a method", async () => {
    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("platform", "request-value")
    );
    await flushHostRequest();

    expect(lastResponsePayload(hostSocket).error).toEqual({
      message: "Desktop browser bridge path is not callable",
      reason: desktopBrowserBridgeErrorReason.HostError,
    });
  });

  it("stringifies a rejection that is not an Error", async () => {
    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("getAllFlags", "request-string-rejection")
    );
    await flushHostRequest();

    expect(lastResponsePayload(hostSocket).error).toEqual({
      message: "flags exploded",
      reason: desktopBrowserBridgeErrorReason.HostError,
    });
  });
});

describe("remote functions held by the host", () => {
  it("runs a remote function only for the client it was issued to, once", async () => {
    const unsubscribe = vi.fn();
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      onDbChanged: () => unsubscribe,
    });
    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("onDbChanged", "request-subscribe")
    );
    await flushHostRequest();
    const { remoteFunctionId } = lastResponsePayload(hostSocket).result as {
      remoteFunctionId: string;
    };

    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeRemoteFrame(remoteFunctionId, "request-other-client", "client-2")
    );
    await flushHostRequest();
    expect(lastResponsePayload(hostSocket).error).toEqual({
      message: "Desktop browser bridge function is unavailable",
      reason: desktopBrowserBridgeErrorReason.HostError,
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeRemoteFrame(remoteFunctionId, "request-owner")
    );
    await flushHostRequest();
    expect(lastResponsePayload(hostSocket)).toEqual({
      clientId: CLIENT_ID,
      requestId: "request-owner",
      result: { bridgeType: "undefined" },
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // Consumed on use: the same id is refused a second time.
    hostSocket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeRemoteFrame(remoteFunctionId, "request-again")
    );
    await flushHostRequest();
    expect(lastResponsePayload(hostSocket).requestId).toBe("request-again");
    expect(lastResponsePayload(hostSocket).error).toBeDefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    disconnectHost();
  });

  it("releases one client's functions when the broker reports it gone, and no other's", async () => {
    const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
    const { disconnect: disconnectHost, socket: hostSocket } = connectFakeHost({
      onDbChanged: (clientLabel: string) => {
        const unsubscribe = vi.fn();
        unsubscribes.set(clientLabel, unsubscribe);
        return unsubscribe;
      },
    });
    for (const clientId of [CLIENT_ID, "client-2"]) {
      hostSocket.deliver(
        desktopBrowserBridgeEvent.request,
        invokeFrame("onDbChanged", `subscribe-${clientId}`, {
          args: [clientId],
          clientId,
        })
      );
      await flushHostRequest();
    }

    hostSocket.deliver(desktopBrowserBridgeEvent.clientDisconnected, CLIENT_ID);
    hostSocket.deliver(desktopBrowserBridgeEvent.clientDisconnected, {
      clientId: 7,
    });
    expect(unsubscribes.get(CLIENT_ID)).not.toHaveBeenCalled();
    expect(unsubscribes.get("client-2")).not.toHaveBeenCalled();

    hostSocket.deliver(desktopBrowserBridgeEvent.clientDisconnected, {
      clientId: CLIENT_ID,
    });
    expect(unsubscribes.get(CLIENT_ID)).toHaveBeenCalledTimes(1);
    expect(unsubscribes.get("client-2")).not.toHaveBeenCalled();
    disconnectHost();
  });
});

describe("client handling of a host result", () => {
  it("turns a remote-function result into a caller that invokes it remotely", async () => {
    const { socket, subscribe } = await connectSubscribingClient();
    const unsubscribe = subscribe(() => undefined);
    answerLastRequest(socket, {
      result: { bridgeType: "remote-function", remoteFunctionId: "remote-1" },
    });
    await flushHostRequest();
    const before = requestCount(socket);

    unsubscribe();

    expect(requestCount(socket)).toBe(before + 1);
    expect(lastRequestPayload(socket)).toEqual({
      args: [],
      kind: "invoke-remote",
      remoteFunctionId: "remote-1",
      requestId: expect.any(String),
    });
    // Settle the invoke-remote, or its real 30s timer rejects a promise the
    // subscription closure dropped, after this file's worker has moved on.
    answerLastRequest(socket, { result: undefined });
  });

  // pins current behavior (ISS-10699); looks odd because the throw escapes the socket
  // handler and the read that was answered is left pending forever — its
  // timer was already cleared and its entry removed before the decode ran.
  it("throws out of the response handler on a remote-function marker with a bad id", async () => {
    const { read, socket } = await connectReadClient();
    // The RAW promise is raced below: a `.catch` derivative would resolve as
    // pending even after a rejection, and this test exists to show there is none.
    const settling = read();
    settling.catch(() => undefined);

    expect(() =>
      answerLastRequest(socket, {
        result: { bridgeType: "remote-function", remoteFunctionId: 1 },
      })
    ).toThrow("Desktop browser bridge function result is invalid");
    await flushHostRequest();
    expect(await isStillPending(settling)).toBe(true);
  });

  it("ignores a response it cannot parse or cannot correlate", async () => {
    const { read, socket } = await connectReadClient();
    const settling = read();
    const requestId = lastRequestId(socket);

    socket.deliver(desktopBrowserBridgeEvent.response, { requestId });
    socket.deliver(desktopBrowserBridgeEvent.response, {
      clientId: CLIENT_ID,
      requestId: "someone-elses",
      result: 1,
    });
    expect(await isStillPending(settling)).toBe(true);

    socket.deliver(desktopBrowserBridgeEvent.response, {
      clientId: CLIENT_ID,
      requestId,
      result: 2,
    });
    await expect(settling).resolves.toBe(2);
  });

  it("lands an error from an older peer that sends no reason on UNKNOWN", async () => {
    const { read, socket } = await connectReadClient();
    const settling = read().catch((error: unknown) => error);

    answerLastRequest(socket, { error: { message: "no reason given" } });

    const error = await settling;
    expect(error).toBeInstanceOf(DesktopBrowserBridgeError);
    expect((error as DesktopBrowserBridgeError).reason).toBe(
      desktopBrowserBridgeErrorReason.Unknown
    );
    expect((error as DesktopBrowserBridgeError).message).toBe(
      "no reason given"
    );
  });
});

describe("manifest shapes", () => {
  it("describes projected values and an absent value alongside methods", () => {
    const manifest = createDesktopApiManifest({
      db: { getSessions: () => undefined },
      macOSMajorVersion: undefined,
      platform: "darwin",
    });

    expect(manifest).toEqual({
      entries: {
        db: {
          entries: { getSessions: { kind: "method" } },
          kind: "object",
        },
        macOSMajorVersion: { kind: "undefined" },
        platform: { kind: "value", value: "darwin" },
      },
      kind: "object",
    });
  });

  it("materializes values and absent keys on the client without a round trip", () => {
    const invoke = vi.fn(() => Promise.resolve(undefined));
    const desktopApi = createDesktopApiClient(
      {
        entries: {
          macOSMajorVersion: { kind: "undefined" },
          platform: { kind: "value", value: "darwin" },
        },
        kind: "object",
      },
      invoke
    ) as Record<string, unknown>;

    expect(desktopApi.platform).toBe("darwin");
    expect(Object.hasOwn(desktopApi, "macOSMajorVersion")).toBe(true);
    expect(desktopApi.macOSMajorVersion).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a root manifest that is not an object", async () => {
    const connecting = connectDesktopBrowserBridgeClient();
    const socket = currentSocket();
    socket.deliver("connect", undefined);
    socket.deliver(desktopBrowserBridgeEvent.manifest, { kind: "method" });

    await expect(connecting).rejects.toThrow(
      "Desktop browser bridge returned an invalid API manifest"
    );
  });
});

describe("launch token", () => {
  it("refuses to connect when the document carries no token", async () => {
    globalThis.history.replaceState(null, "", "/design-system/browser.html");

    await expect(connectDesktopBrowserBridgeClient()).rejects.toThrow(
      "Desktop browser bridge launch token is missing"
    );
    expect(openedSockets).toEqual([]);
  });

  it("refuses to connect on a build that did not enable the bridge", async () => {
    vi.stubEnv("VITE_DESKTOP_BROWSER_BRIDGE_ENABLED", "0");

    await expect(connectDesktopBrowserBridgeClient()).rejects.toThrow(
      "Desktop browser bridge is not enabled for this build"
    );
    expect(openedSockets).toEqual([]);
  });

  describe("without session storage", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage"
    );

    afterEach(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, "sessionStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "sessionStorage");
      }
    });

    it("leaves the token on the URL when there is nowhere to keep it", () => {
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get: () => {
          throw new Error("storage disabled");
        },
      });

      expect(takeBridgeTokenFromUrl("client")).toBe(LAUNCH_TOKEN);
      expect(globalThis.location.search).toBe(
        `?closedloopBridgeToken=${LAUNCH_TOKEN}`
      );
      globalThis.history.replaceState(null, "", "/design-system/browser.html");
      expect(takeBridgeTokenFromUrl("client")).toBe("");
    });
  });
});

/**
 * Put the launch token back on the URL. Each role takes it off on connect and
 * keeps it under its own key, so a client opened after a host in the same
 * document has to be handed the token again — as the launcher does.
 */
function reissueLaunchToken(): void {
  issueLaunchToken(LAUNCH_TOKEN);
}

/** Carry the client's last request frame to the host as the broker would. */
function relayRequest(
  clientSocket: FakeBridgeSocket,
  hostSocket: FakeBridgeSocket
): void {
  hostSocket.deliver(desktopBrowserBridgeEvent.request, {
    ...lastRequestPayload(clientSocket),
    clientId: CLIENT_ID,
  });
}

/** Carry the host's last response frame back to the client as the broker would. */
function relayResponse(
  hostSocket: FakeBridgeSocket,
  clientSocket: FakeBridgeSocket
): void {
  clientSocket.deliver(
    desktopBrowserBridgeEvent.response,
    lastResponsePayload(hostSocket)
  );
}

const LAUNCH_TOKEN = "bridge-token";
const flagsManifest = {
  entries: { getAllFlags: { kind: "method" } },
  kind: "object",
} as const;
