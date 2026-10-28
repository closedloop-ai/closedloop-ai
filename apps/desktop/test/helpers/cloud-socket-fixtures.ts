import { EventEmitter } from "node:events";
import type { DesktopAuthFailureEventInput } from "../../src/main/cloud/auth-failure-telemetry.js";
import type { CloudSocketStatus } from "../../src/main/cloud/cloud-protocol.js";
import type { CloudSocketOptions } from "../../src/main/cloud/cloud-socket.js";
import { CloudSocketService } from "../../src/main/cloud/cloud-socket.js";
import { nodeTestTimers } from "../support/node-test-fake-timers.js";

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

export type PairingHarness = {
  service: CloudSocketService;
  socket: FakeSocket;
  statuses: CloudSocketStatus[];
};

/**
 * A real `CloudSocketService` bound to a fake socket, driven through the REAL
 * connect handler so the handshake it emits is the production one.
 *
 * Shared rather than per-suite: several suites need a service whose production
 * listeners are bound and whose handshake is already in flight, and a second
 * copy would let them drift onto different notions of a connected socket.
 */
export function connectPairingSocket(
  reportAuthFailure: (input: DesktopAuthFailureEventInput) => void,
  overrides?: Partial<CloudSocketOptions>,
  { emitConnect = true }: { emitConnect?: boolean } = {}
): PairingHarness {
  // The connect handler arms the hello-ack supervisor's timer; fake it so no
  // real timer outlives the test.
  nodeTestTimers.enable(["setTimeout"]);
  const statuses: CloudSocketStatus[] = [];
  const service = new CloudSocketService(
    createStubOptions({
      getApiKey: () => PAIRING_SOCKET_API_KEY,
      onStatusChange: (status) => statuses.push(status),
      reportAuthFailure,
      ...overrides,
    })
  );
  const socket = new FakeSocket();
  const internals = service as unknown as Record<string, unknown>;
  internals.socket = socket;
  internals.stopped = false;
  (
    Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => unknown
    >
  ).registerSocketHandlers.call(service, socket);
  if (emitConnect) {
    socket.emit("connect");
  }
  return { service, socket, statuses };
}

export const PAIRING_SOCKET_API_KEY = "sk_live_pairing_secret_do_not_ship";

/**
 * Put a handshake back in flight after a disconnect cleared it.
 *
 * The disconnect handler sets `awaitingHelloAck` false, so a suite driving a
 * STREAK of refused handshakes has to re-arm between them or only the first
 * close is classified as a hello rejection at all. Shared because two suites
 * now count such a streak (ISS-6126's nack back-off and ISS-11843's mute-close
 * back-off) and a second copy would let them drift.
 */
export function rearmHandshake(service: CloudSocketService): void {
  (service as unknown as Record<string, unknown>).awaitingHelloAck = true;
}
