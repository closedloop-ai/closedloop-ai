/**
 * gateway-hello-nack-delivery.test.ts
 *
 * ISS-6126: the API answers a refused `desktop.hello` with
 * `{ emit: [desktop.hello.nack], disconnect: true }`. The relay used to return
 * on `result.disconnect` before its emit loop, so on the default CloudRelay
 * path the only frame that says WHY the cloud rejected the machine was dropped
 * and the desktop saw a bare `io server disconnect`.
 *
 * Kept in a focused sibling suite rather than grown into gateway-event-handlers
 * so each file keeps its own hoisted socket.io mock (see gateway-harness.ts).
 */

import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createGatewayHarness } from "./gateway-harness.js";

const socketIoMocks = vi.hoisted(() => ({
  namespace: { use: vi.fn(), on: vi.fn() },
}));

vi.mock("socket.io", () => ({
  Server: class {
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

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  return { createServer: vi.fn(createMockHttpServerFactory()) };
});

const ORIGINAL_ENV = { ...process.env };
const TEST_API_URL = "http://127.0.0.1:19881";

const harness = createGatewayHarness(socketIoMocks.namespace);

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-hello-nack";
  process.env.RELAY_PORT = "20503";
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  await import("../index");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  await harness.cleanupRegisteredSockets();
  vi.unstubAllGlobals();
});

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    url: `${TEST_API_URL}/internal/relay/socket-event`,
    headers: { get: () => "application/json" },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const NACK_PAYLOAD = { reason: DesktopHelloNackReason.InternalError };

describe("ISS-6126: a refused desktop.hello delivers its nack before closing", () => {
  it("emits desktop.hello.nack, then disconnects", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-nack-delivery");
    harness.getConnectionHandler()(socket);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeOkResponse({
          emit: [{ event: "desktop.hello.nack", payload: NACK_PAYLOAD }],
          disconnect: true,
        })
      )
    );

    await socket.handlers.get("desktop.hello")?.({ targetId: "t-nack" });

    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      NACK_PAYLOAD
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    // Ordering is the whole fix: a nack written after the close is as invisible
    // to the desktop as one that was never written.
    expect(socket.emit.mock.invocationCallOrder[0]).toBeLessThan(
      socket.disconnect.mock.invocationCallOrder[0]
    );
  });

  it("still disconnects, and emits nothing, when the API sends no nack", async () => {
    // Version skew: an older API (or the gateway-conflict / unparseable-hello
    // paths) refuses with no reason at all. That must stay a plain close.
    const socket = harness.createMockRelaySocket("sock-hello-nack-absent");
    harness.getConnectionHandler()(socket);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [], disconnect: true }))
    );

    await socket.handlers.get("desktop.hello")?.({ targetId: "t-no-nack" });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("does not disconnect an accepted hello that carries response events", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-accepted");
    harness.getConnectionHandler()(socket);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeOkResponse({
          emit: [{ event: "desktop.hello.ack", payload: { ok: true } }],
          targetId: "t-accepted",
          gatewaySessionId: "gw-t-accepted",
        })
      )
    );

    await socket.handlers.get("desktop.hello")?.({ targetId: "t-accepted" });
    harness.registeredTestSockets.add(socket);

    expect(socket.emit).toHaveBeenCalledWith("desktop.hello.ack", {
      ok: true,
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});
