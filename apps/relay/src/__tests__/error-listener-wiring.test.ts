/**
 * error-listener-wiring.test.ts
 *
 * Proves index.ts actually registers the error listeners in production wiring —
 * deleting a call site must red these, not just the unit tests in
 * error-listeners.test.ts.
 *
 *  • HTTP server keeps an "error" listener AFTER the bind promise resolves
 *    (startRelayServer drops its one-shot rejecting listener in onListening)
 *  • io.engine gets a "connection_error" listener
 *  • each /desktop-gateway socket gets an "error" listener on connect
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";
import type { MockHttpServer } from "./http-server-mock.js";

const socketIoMocks = vi.hoisted(() => ({
  namespace: { use: vi.fn(), on: vi.fn() },
  engineOn: vi.fn(),
}));

vi.mock("socket.io", () => ({
  Server: class {
    engine = { on: socketIoMocks.engineOn };
    of(ns?: string) {
      if (ns === "/desktop-gateway") {
        return socketIoMocks.namespace;
      }
      return { use() {}, on() {} };
    }
    close() {
      return Promise.resolve();
    }
  },
}));

const httpMocks = vi.hoisted(() => ({
  servers: [] as unknown[],
}));

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  const factory = createMockHttpServerFactory();
  return {
    createServer: vi.fn(() => {
      const server = factory();
      httpMocks.servers.push(server);
      return server;
    }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { log } = await import("@repo/observability/log");
const logError = vi.mocked(log.error);

const ORIGINAL_ENV = { ...process.env };
const harness = createGatewayHarness(socketIoMocks.namespace);

let stopRelay: () => Promise<void>;

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-eliw";
  process.env.RELAY_PORT = "20733";
  process.env.CLOSEDLOOP_API_URL = "http://127.0.0.1:19893";
  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
});

afterAll(async () => {
  await stopRelay();
  process.env = { ...ORIGINAL_ENV };
});

function getMockHttpServer(): MockHttpServer {
  const server = httpMocks.servers.at(-1) as MockHttpServer | undefined;
  if (!server) {
    throw new Error("relay never created an HTTP server");
  }
  return server;
}

describe("relay HTTP server error listener", () => {
  it("survives a successful bind, so a post-bind error is logged rather than fatal", () => {
    logError.mockClear();
    const server = getMockHttpServer();

    const listenersRun = server.emitServerEvent(
      "error",
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    );

    // On the pre-fix code startRelayServer's onListening called
    // server.off("error", onError), leaving zero listeners here.
    expect(listenersRun).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalledWith(
      "Relay HTTP server error",
      expect.objectContaining({ code: "ECONNRESET" })
    );
  });
});

describe("relay engine connection_error listener", () => {
  it("is registered on io.engine at module load", () => {
    expect(socketIoMocks.engineOn).toHaveBeenCalledWith(
      "connection_error",
      expect.any(Function)
    );
  });
});

describe("relay gateway socket error listener", () => {
  it("is registered for each connecting /desktop-gateway socket", () => {
    const socket: MockRelaySocket =
      harness.createMockRelaySocket("socket-eliw");
    harness.getConnectionHandler()(socket);

    expect(socket.handlers.has("error")).toBe(true);

    logError.mockClear();
    socket.handlers.get("error")?.(new Error("invalid packet"));

    expect(logError).toHaveBeenCalledWith(
      "Relay socket error",
      expect.objectContaining({
        socketId: "socket-eliw",
        error: "invalid packet",
      })
    );
  });
});
