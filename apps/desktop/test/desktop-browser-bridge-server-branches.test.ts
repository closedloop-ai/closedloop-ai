/**
 * ISS-11105 — broker paths `desktop-browser-bridge-server.test.ts` does not
 * drive: origin validation at start, an unknown role, a request with no host,
 * a late-joining client, malformed host responses, host callbacks, and a
 * `null` request envelope.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { describe, expect, it } from "vitest";
import { startDesktopBrowserBridgeServer } from "../scripts/desktop-browser-bridge-server.mjs";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
  desktopBrowserBridgePath,
  desktopBrowserBridgeRole,
} from "../src/shared/desktop-browser-bridge-contract.mjs";

const TEST_TIMEOUT_MS = 5000;
const OVER_LIMIT_ARG_LENGTH = 2 * 1024 * 1024 + 1024;
const CLIENT_TOKEN = "c".repeat(43);
const HOST_TOKEN = "h".repeat(43);
const MANIFEST = {
  entries: { getSettings: { kind: "method" } },
  kind: "object",
};

const REQUIRES_LOOPBACK = /requires a loopback Vite origin/;
const ROLE_IS_INVALID = /Desktop browser bridge role is invalid/;

describe("startDesktopBrowserBridgeServer origin validation", () => {
  it.each([
    ["an https loopback origin", "https://127.0.0.1:5173"],
    ["a non-loopback host", "http://example.test:5173"],
    ["a string that is not a URL", "not a url"],
  ])("refuses %s", (_label, allowedOrigin) => {
    expect(() =>
      startDesktopBrowserBridgeServer({
        allowedOrigin,
        clientToken: CLIENT_TOKEN,
        hostToken: HOST_TOKEN,
        httpServer: createServer(),
      })
    ).toThrow(REQUIRES_LOOPBACK);
  });

  it("accepts a localhost origin and admits a client presenting it", async () => {
    const fixture = await startFixture("localhost");
    try {
      const client = await connectSocket(fixture, {
        role: desktopBrowserBridgeRole.Client,
        token: CLIENT_TOKEN,
      });
      expect(client.connected).toBe(true);
      client.disconnect();
    } finally {
      await fixture.close();
    }
  });
});

describe("desktop browser bridge handshake", () => {
  it("refuses a role that is neither host nor client", async () => {
    const fixture = await startFixture();
    try {
      await expect(
        connectSocket(fixture, { role: "admin", token: CLIENT_TOKEN })
      ).rejects.toThrow(ROLE_IS_INVALID);
    } finally {
      await fixture.close();
    }
  });
});

describe("desktop browser bridge client requests", () => {
  it("answers a request with HostUnavailable when no host is connected", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      const client = await connectSocket(fixture, {
        role: desktopBrowserBridgeRole.Client,
        token: CLIENT_TOKEN,
      });
      sockets.push(client);

      const response = waitForEvent(client, desktopBrowserBridgeEvent.response);
      client.emit(desktopBrowserBridgeEvent.request, {
        args: [],
        kind: "invoke",
        path: ["getSettings"],
        requestId: "request-no-host",
      });

      expect(await response).toEqual({
        clientId: client.id,
        error: {
          message: "Desktop browser bridge host is unavailable",
          reason: desktopBrowserBridgeErrorReason.HostUnavailable,
        },
        requestId: "request-no-host",
      });
    } finally {
      disconnectAll(sockets);
      await fixture.close();
    }
  });

  it("drops a null request envelope without answering and keeps serving", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      const client = await connectSocket(fixture, {
        role: desktopBrowserBridgeRole.Client,
        token: CLIENT_TOKEN,
      });
      sockets.push(client);

      const next = waitForEvent(client, desktopBrowserBridgeEvent.response);
      client.emit(desktopBrowserBridgeEvent.request, null);
      client.emit(desktopBrowserBridgeEvent.request, {
        args: [],
        kind: "invoke",
        path: [],
        requestId: "request-after-null",
      });

      expect((await next).requestId).toBe("request-after-null");
    } finally {
      disconnectAll(sockets);
      await fixture.close();
    }
  });

  it("replays the cached manifest to a client that joins after the host sent it", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      const host = await connectSocket(fixture, {
        role: desktopBrowserBridgeRole.Host,
        token: HOST_TOKEN,
      });
      const early = await connectSocket(fixture, {
        role: desktopBrowserBridgeRole.Client,
        token: CLIENT_TOKEN,
      });
      sockets.push(host, early);
      const relayed = waitForEvent(early, desktopBrowserBridgeEvent.manifest);
      host.emit(desktopBrowserBridgeEvent.manifest, MANIFEST);
      await relayed;

      let replayed: Promise<Record<string, unknown>> | undefined;
      const late = await connectSocket(
        fixture,
        { role: desktopBrowserBridgeRole.Client, token: CLIENT_TOKEN },
        (socket) => {
          replayed = waitForEvent(socket, desktopBrowserBridgeEvent.manifest);
        }
      );
      sockets.push(late);

      expect(await replayed).toEqual(MANIFEST);
    } finally {
      disconnectAll(sockets);
      await fixture.close();
    }
  });
});

describe("desktop browser bridge host relays", () => {
  it("drops a response that fails the schema and relays the next valid one", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      const { client, host } = await connectPair(fixture, sockets);

      const received = waitForEvent(client, desktopBrowserBridgeEvent.response);
      host.emit(desktopBrowserBridgeEvent.response, {
        clientId: client.id,
        requestId: "",
      });
      host.emit(desktopBrowserBridgeEvent.response, {
        clientId: client.id,
        requestId: "request-valid",
        result: 1,
      });

      expect(await received).toEqual({
        clientId: client.id,
        requestId: "request-valid",
        result: 1,
      });
    } finally {
      disconnectAll(sockets);
      await fixture.close();
    }
  });

  it("drops malformed and over-limit callbacks and relays a valid one", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      const { client, host } = await connectPair(fixture, sockets);

      const received = waitForEvent(client, desktopBrowserBridgeEvent.callback);
      host.emit(desktopBrowserBridgeEvent.callback, {
        args: [],
        clientId: client.id,
      });
      host.emit(desktopBrowserBridgeEvent.callback, {
        args: ["x".repeat(OVER_LIMIT_ARG_LENGTH)],
        callbackId: "callback-over-limit",
        clientId: client.id,
      });
      host.emit(desktopBrowserBridgeEvent.callback, {
        args: [{ theme: "dark" }],
        callbackId: "callback-valid",
        clientId: client.id,
      });

      expect(await received).toEqual({
        args: [{ theme: "dark" }],
        callbackId: "callback-valid",
        clientId: client.id,
      });
    } finally {
      disconnectAll(sockets);
      await fixture.close();
    }
  });
});

type Fixture = { close: () => Promise<void>; origin: string };

async function startFixture(
  hostname: "127.0.0.1" | "localhost" = "127.0.0.1"
): Promise<Fixture> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  const origin = `http://${hostname}:${address.port}`;
  const bridge = startDesktopBrowserBridgeServer({
    allowedOrigin: origin,
    clientToken: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    httpServer,
  });
  return { close: () => bridge.close(), origin };
}

async function connectPair(
  fixture: Fixture,
  sockets: Socket[]
): Promise<{ client: Socket; host: Socket }> {
  const host = await connectSocket(fixture, {
    role: desktopBrowserBridgeRole.Host,
    token: HOST_TOKEN,
  });
  sockets.push(host);
  const client = await connectSocket(fixture, {
    role: desktopBrowserBridgeRole.Client,
    token: CLIENT_TOKEN,
  });
  sockets.push(client);
  return { client, host };
}

function connectSocket(
  fixture: Fixture,
  auth: { role: string; token: string },
  beforeConnect?: (socket: Socket) => void
): Promise<Socket> {
  const socket = io(fixture.origin.replace("localhost", "127.0.0.1"), {
    auth,
    autoConnect: false,
    extraHeaders: { Origin: fixture.origin },
    forceNew: true,
    path: desktopBrowserBridgePath,
    reconnection: false,
    transports: ["websocket"],
  });
  beforeConnect?.(socket);
  const connected = new Promise<Socket>((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
  socket.connect();
  return connected;
}

function waitForEvent(
  socket: Socket,
  event: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, TEST_TIMEOUT_MS);
    socket.once(event, (payload: Record<string, unknown> = {}) => {
      globalThis.clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function disconnectAll(sockets: readonly Socket[]): void {
  for (const socket of sockets) {
    socket.disconnect();
  }
}
