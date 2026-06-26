import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  type DesktopAnalyticsAck,
  DesktopAnalyticsAckReason,
} from "../src/main/cloud-protocol.js";
import {
  type CloudSocketOptions,
  CloudSocketService,
  parseDesktopAnalyticsAck,
} from "../src/main/cloud-socket.js";

function createStubOptions(
  overrides?: Partial<CloudSocketOptions>
): CloudSocketOptions {
  return {
    getRelayOrigin: () => "https://relay.example.com",
    getApiKey: () => "test-key",
    getAllowedDirectories: () => ["/tmp"],
    getMaxInFlightCommands: () => 5,
    machineName: "test-machine",
    pluginVersion: "1.0.0-test",
    desktopClientVersion: "0.15.3-test",
    gatewayProtocolVersion: "0.1.0",
    supportedOperations: ["test_op"],
    ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  connected = true;
  nextAck: DesktopAnalyticsAck | "timeout" = { accepted: true };
  readonly emittedEvents: Array<{
    name: string;
    payload: Record<string, unknown>;
  }> = [];

  emit(name: string, ...args: unknown[]): boolean {
    this.emittedEvents.push({
      name,
      payload: (args[0] ?? {}) as Record<string, unknown>,
    });
    const ack = args[1];
    if (
      name === DESKTOP_ANALYTICS_SOCKET_EVENT &&
      typeof ack === "function" &&
      this.nextAck !== "timeout"
    ) {
      ack(this.nextAck);
    }
    return true;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }
}

describe("desktop.analytics socket relay", () => {
  test("queues while not hello-acked and drains after the socket is ready", async () => {
    const service = new CloudSocketService(createStubOptions());

    service.emitAnalytics({
      event: "command_initiated",
      properties: { command_id: "oldest" },
      occurredAt: new Date().toISOString(),
    });

    const fakeSocket = makeReady(service);
    drainAnalyticsQueue(service);
    await service.flushAnalytics({ timeoutMs: 20 });

    assert.equal(fakeSocket.emittedEvents.length, 1);
    assert.equal(
      fakeSocket.emittedEvents[0].name,
      DESKTOP_ANALYTICS_SOCKET_EVENT
    );
    assert.equal(
      fakeSocket.emittedEvents[0].payload.event,
      "command_initiated"
    );
  });

  test("bounded queue drops the oldest analytics event", async () => {
    const service = new CloudSocketService(createStubOptions());
    for (let index = 0; index < 201; index += 1) {
      service.emitAnalytics({
        event: "command_started",
        properties: { command_id: `cmd-${index}` },
        occurredAt: new Date().toISOString(),
      });
    }

    const fakeSocket = makeReady(service);
    drainAnalyticsQueue(service);
    await service.flushAnalytics({ timeoutMs: 20 });

    assert.equal(fakeSocket.emittedEvents.length, 200);
    assert.equal(
      fakeSocket.emittedEvents[0].payload.properties instanceof Object,
      true
    );
    assert.deepEqual(fakeSocket.emittedEvents[0].payload.properties, {
      command_id: "cmd-1",
    });
  });

  for (const reason of Object.values(DesktopAnalyticsAckReason)) {
    test(`${reason} ack drops analytics without blocking command traffic`, async () => {
      const service = new CloudSocketService(createStubOptions());
      const fakeSocket = makeReady(service);
      fakeSocket.nextAck = {
        accepted: false,
        reason,
      };

      service.emitAnalytics({
        event: "desktop_connection_established",
        properties: { version: "0.15.3-test" },
        occurredAt: new Date().toISOString(),
      });
      service.sendCommandAck({ commandId: "cmd-1", accepted: true });
      await service.flushAnalytics({ timeoutMs: 20 });

      assert.equal(analyticsEmits(fakeSocket).length, 1);
      assert.equal(
        fakeSocket.emittedEvents.some(
          (event) => event.name === "desktop.command.ack"
        ),
        true
      );

      if (reason === DesktopAnalyticsAckReason.FeatureDisabled) {
        service.emitAnalytics({
          event: "command_completed",
          properties: { command_id: "cmd-1" },
          occurredAt: new Date().toISOString(),
        });
        await service.flushAnalytics({ timeoutMs: 20 });
        assert.equal(analyticsEmits(fakeSocket).length, 1);
      }
    });
  }

  test("missing old-server ack times out as best-effort analytics loss", async () => {
    const service = new CloudSocketService(createStubOptions());
    const fakeSocket = makeReady(service);
    fakeSocket.nextAck = "timeout";

    service.emitAnalytics({
      event: "command_failed",
      properties: { command_id: "cmd-1", error_class: "timeout" },
      occurredAt: new Date().toISOString(),
    });
    service.sendCommandAck({ commandId: "cmd-1", accepted: true });

    assert.equal(
      fakeSocket.emittedEvents.some(
        (event) => event.name === "desktop.command.ack"
      ),
      true
    );
    await delay(1600);
    await service.flushAnalytics({ timeoutMs: 20 });
  });

  test("analytics ack parser falls back to validation_failed for unknown shapes", () => {
    assert.deepEqual(parseDesktopAnalyticsAck({ accepted: true }), {
      accepted: true,
    });
    assert.deepEqual(
      parseDesktopAnalyticsAck({ accepted: false, reason: "rate_limited" }),
      { accepted: false, reason: DesktopAnalyticsAckReason.RateLimited }
    );
    assert.deepEqual(
      parseDesktopAnalyticsAck({ accepted: false, reason: "feature_disabled" }),
      { accepted: false, reason: DesktopAnalyticsAckReason.FeatureDisabled }
    );
    assert.deepEqual(
      parseDesktopAnalyticsAck({
        accepted: false,
        reason: "validation_failed",
      }),
      { accepted: false, reason: DesktopAnalyticsAckReason.ValidationFailed }
    );
    assert.deepEqual(parseDesktopAnalyticsAck({ accepted: false }), {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });
});

function makeReady(service: CloudSocketService): FakeSocket {
  const fakeSocket = new FakeSocket();
  const state = service as unknown as Record<string, unknown>;
  state.socket = fakeSocket;
  state.targetId = "target-1";
  state.awaitingHelloAck = false;
  state.stopped = false;
  return fakeSocket;
}

function drainAnalyticsQueue(service: CloudSocketService): void {
  const proto = Object.getPrototypeOf(service) as Record<string, () => void>;
  proto.drainAnalyticsQueue.call(service);
}

function analyticsEmits(
  fakeSocket: FakeSocket
): Array<{ name: string; payload: Record<string, unknown> }> {
  return fakeSocket.emittedEvents.filter(
    (event) => event.name === DESKTOP_ANALYTICS_SOCKET_EVENT
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
