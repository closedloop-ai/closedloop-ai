/**
 * Shared gateway harness for relay Socket.IO suites that mock socket.io and
 * exercise the /desktop-gateway namespace connection handler.
 *
 * Each suite keeps its own vi.hoisted() + vi.mock("socket.io", ...) and passes
 * its mocked namespace into createGatewayHarness so the hoisted mock stays
 * scoped to the importing file.
 *
 * Named without ".test" so vitest does not collect it as a suite.
 */

import { vi } from "vitest";

export type MockRelaySocket = {
  id: string;
  data: {
    auth: {
      organizationId: string;
      userId: string;
    };
    pendingBuffer?: Array<{ event: string; args: unknown[] }>;
  };
  conn: { transport: { name: string } };
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Map<string, (...args: unknown[]) => Promise<void> | void>;
};

/** Minimal type covering what the harness reads from the mocked namespace. */
export type GatewayHarnessNamespace = {
  use: unknown;
  on: { mock: { calls: unknown[][] } };
};

export function createGatewayHarness(namespace: GatewayHarnessNamespace): {
  createMockRelaySocket(id: string): MockRelaySocket;
  getConnectionHandler(): (socket: MockRelaySocket) => void;
  registerSocketTarget(
    socket: MockRelaySocket,
    targetId: string
  ): Promise<void>;
  disconnectSocketTarget(socket: MockRelaySocket): Promise<void>;
  registeredTestSockets: Set<MockRelaySocket>;
  cleanupRegisteredSockets(): Promise<void>;
} {
  const registeredTestSockets = new Set<MockRelaySocket>();

  function createMockRelaySocket(id: string): MockRelaySocket {
    const handlers = new Map<
      string,
      (...args: unknown[]) => Promise<void> | void
    >();
    return {
      id,
      data: {
        auth: {
          organizationId: "org-1",
          userId: "user-1",
        },
      },
      conn: { transport: { name: "websocket" } },
      connected: true,
      on: vi.fn(
        (
          event: string,
          handler: (...args: unknown[]) => Promise<void> | void
        ) => {
          handlers.set(event, handler);
        }
      ),
      emit: vi.fn(),
      disconnect: vi.fn(),
      handlers,
    };
  }

  function getConnectionHandler(): (socket: MockRelaySocket) => void {
    const call = namespace.on.mock.calls.find(
      ([event]) => event === "connection"
    );
    if (!call) {
      throw new Error("Expected relay connection handler to be registered");
    }
    return call[1] as (socket: MockRelaySocket) => void;
  }

  async function registerSocketTarget(
    socket: MockRelaySocket,
    targetId: string
  ): Promise<void> {
    getConnectionHandler()(socket);
    const helloHandler = socket.handlers.get("desktop.hello");
    if (!helloHandler) {
      throw new Error("Expected desktop.hello handler to be registered");
    }
    await helloHandler({ targetId, pluginVersion: "test" });
    registeredTestSockets.add(socket);
  }

  async function disconnectSocketTarget(
    socket: MockRelaySocket
  ): Promise<void> {
    const disconnectHandler = socket.handlers.get("disconnect");
    if (!disconnectHandler) {
      return;
    }
    socket.connected = false;
    await disconnectHandler("test_cleanup");
  }

  async function cleanupRegisteredSockets(): Promise<void> {
    for (const socket of registeredTestSockets) {
      await disconnectSocketTarget(socket);
    }
    registeredTestSockets.clear();
  }

  return {
    createMockRelaySocket,
    getConnectionHandler,
    registerSocketTarget,
    disconnectSocketTarget,
    registeredTestSockets,
    cleanupRegisteredSockets,
  };
}
