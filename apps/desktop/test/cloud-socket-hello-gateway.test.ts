/**
 * ISS-12032 — the gatewayId a hello declared, and the re-hello that repairs a
 * compute target whose hello declared none.
 *
 * Driven through the real `CloudSocketService` handlers so the hello frames
 * asserted are the production ones.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HELLO_GATEWAY_REFRESH_INTERVAL_MS } from "../src/main/cloud/cloud-socket-hello-gateway.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  connectPairingSocket,
  type FakeSocket,
} from "./helpers/cloud-socket-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const IDLE = { activeCommands: 0, queueDepth: 0 };
const BUSY = { activeCommands: 1, queueDepth: 0 };

afterEach(() => {
  nodeTestTimers.reset();
  gatewayLog.clear();
});

describe("CloudSocketService hello gatewayId", () => {
  it("reports the gatewayId the hello declared", () => {
    const { service, socket } = connectPairingSocket(noop, {
      getGatewayId: () => "gateway-a",
    });

    expect(helloGatewayIds(socket)).toEqual(["gateway-a"]);
    expect(service.getHelloGatewayId()).toBe("gateway-a");
  });

  it("reports the hello's id, not one that resolved after it was sent", () => {
    let gatewayId: string | null = null;
    const { service, socket } = connectPairingSocket(noop, {
      getGatewayId: () => gatewayId,
    });
    gatewayId = "gateway-late";

    expect(helloGatewayIds(socket)).toEqual([undefined]);
    expect(service.getHelloGatewayId()).toBeUndefined();
  });

  it("re-sends the hello once a gatewayId resolves after an acknowledged hello that declared none", () => {
    let gatewayId: string | null = null;
    const { service, socket } = connectPairingSocket(noop, {
      getGatewayId: () => gatewayId,
      getCommandWorkStats: () => IDLE,
    });
    ackHello(socket);

    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS);
    expect(helloGatewayIds(socket)).toEqual([undefined]);

    gatewayId = "gateway-b";
    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS);

    expect(helloGatewayIds(socket)).toEqual([undefined, "gateway-b"]);
    expect(service.getHelloGatewayId()).toBe("gateway-b");
  });

  it("holds the re-hello while command work is in flight, then sends it once idle", () => {
    let gatewayId: string | null = null;
    let idle = false;
    const { socket } = connectPairingSocket(noop, {
      getGatewayId: () => gatewayId,
      getCommandWorkStats: () => (idle ? IDLE : BUSY),
    });
    ackHello(socket);
    gatewayId = "gateway-b";

    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS * 2);
    expect(helloGatewayIds(socket)).toEqual([undefined]);

    idle = true;
    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS);
    expect(helloGatewayIds(socket)).toEqual([undefined, "gateway-b"]);
  });

  it("does not re-send a hello that already declared a gatewayId", () => {
    const { socket } = connectPairingSocket(noop, {
      getGatewayId: () => "gateway-a",
    });
    ackHello(socket);

    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS * 3);

    expect(helloGatewayIds(socket)).toEqual(["gateway-a"]);
  });

  it("cancels the pending re-hello on stop", () => {
    let gatewayId: string | null = null;
    const { service, socket } = connectPairingSocket(noop, {
      getGatewayId: () => gatewayId,
    });
    ackHello(socket);
    service.stop();

    gatewayId = "gateway-b";
    nodeTestTimers.tick(HELLO_GATEWAY_REFRESH_INTERVAL_MS);

    expect(helloGatewayIds(socket)).toEqual([undefined]);
    expect(service.getHelloGatewayId()).toBeUndefined();
  });
});

function noop(): void {
  // reportAuthFailure is not under test here.
}

function ackHello(socket: FakeSocket): void {
  socket.emit("desktop.hello.ack", { computeTargetId: "target-1" });
}

function helloGatewayIds(socket: FakeSocket): Array<string | undefined> {
  return socket.emittedEvents
    .filter((event) => event.name === "desktop.hello")
    .map((event) => (event.payload as { gatewayId?: string }).gatewayId);
}
