import { EventEmitter } from "node:events";
import type { CloudSocketOptions } from "../../src/main/cloud/cloud-socket.js";

/**
 * Shared fixtures for the `CloudSocketService` suites.
 *
 * Both `cloud-socket-presence.test.ts` and `cloud-socket-hello-nack.test.ts`
 * drive the real service against an injected fake socket; keeping one copy of
 * the stub options and the fake socket stops the two suites from drifting into
 * disagreeing pictures of the same service.
 */

/**
 * Stand-in for a Socket.IO socket. `emit` records outbound frames AND dispatches
 * to registered listeners, so a test can drive the real production handlers
 * installed by `registerSocketHandlers`.
 */
export class FakeSocket extends EventEmitter {
  connected = true;
  connectCalls = 0;
  readonly io = { opts: {} as Record<string, unknown> };
  readonly emittedEvents: Array<{ name: string; payload: unknown }> = [];

  emit(name: string, ...args: unknown[]): boolean {
    this.emittedEvents.push({ name, payload: args[0] });
    return super.emit(name, ...args);
  }

  connect(): this {
    this.connectCalls += 1;
    this.connected = true;
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  removeAllListeners(event?: string): this {
    super.removeAllListeners(event);
    return this;
  }
}

export function createStubOptions(
  overrides?: Partial<CloudSocketOptions>
): CloudSocketOptions {
  return {
    getRelayOrigin: () => "https://relay.example.com",
    getApiKey: () => "test-key",
    getAllowedDirectories: () => ["/tmp"],
    getMaxInFlightCommands: () => 5,
    getEnabledOperations: () => ["test_op"],
    machineName: "test-machine",
    pluginVersion: "1.0.0-test",
    desktopClientVersion: "0.13.9-test",
    gatewayProtocolVersion: "0.1.0",
    ...overrides,
  };
}
