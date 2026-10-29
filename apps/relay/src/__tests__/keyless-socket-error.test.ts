/**
 * keyless-socket-error.test.ts
 *
 * The `/telemetry` namespace had no socket-level "error" listener, so a
 * malformed inbound packet on an UNAUTHENTICATED socket surfaced as an
 * unhandled emitter error. Covers that the listener is wired, and that it is
 * wired only AFTER the connection-budget fence — a socket rejected at capacity
 * must still get no handlers at all.
 */

import { KEYLESS_TELEMETRY_NAMESPACE } from "@closedloop-ai/shared-platform/keyless-telemetry";
import type { Server, Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerKeylessTelemetryNamespace } from "../keyless-otlp-ingress.js";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { log } = await import("@repo/observability/log");
const logError = vi.mocked(log.error);

type CapturedSocket = {
  id: string;
  handshake: { address: string; headers: Record<string, string> };
  handlers: Map<string, (...args: unknown[]) => void>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function makeSocket(id: string): CapturedSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    id,
    handshake: { address: "127.0.0.1", headers: {} },
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    disconnect: vi.fn(),
  };
}

const openHandles: Array<{ close: () => void }> = [];

function register(maxConnections?: number): {
  connect: (socket: CapturedSocket) => void;
  namespaces: string[];
} {
  let connectionHandler: ((socket: Socket) => void) | undefined;
  const namespaces: string[] = [];
  const io = {
    of: (ns: string) => {
      namespaces.push(ns);
      return {
        on: (event: string, handler: (socket: Socket) => void) => {
          if (event === "connection") {
            connectionHandler = handler;
          }
        },
      };
    },
  } as unknown as Server;

  openHandles.push(
    registerKeylessTelemetryNamespace(io, {
      collectorUrl: "http://127.0.0.1:19899",
      allowPrivateCollector: true,
      isProduction: false,
      maxConnections,
      sweepIntervalMs: 60_000,
    })
  );

  if (!connectionHandler) {
    throw new Error("no /telemetry connection handler registered");
  }
  const handler = connectionHandler;
  return {
    connect: (socket: CapturedSocket) => handler(socket as unknown as Socket),
    namespaces,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const handle of openHandles.splice(0)) {
    handle.close();
  }
});

describe("keyless /telemetry socket error listener", () => {
  it("logs a socket error instead of leaving it unhandled", () => {
    const { connect, namespaces } = register();
    const socket = makeSocket("keyless-1");

    connect(socket);

    expect(namespaces).toEqual([KEYLESS_TELEMETRY_NAMESPACE]);
    expect(socket.handlers.has("error")).toBe(true);

    socket.handlers.get("error")?.(new Error("invalid packet"));

    expect(logError).toHaveBeenCalledWith(
      "Relay socket error",
      expect.objectContaining({
        socketId: "keyless-1",
        error: "invalid packet",
      })
    );
  });

  it("wires nothing — not even the error listener — on a socket rejected at connection capacity", () => {
    const { connect } = register(1);
    connect(makeSocket("keyless-accepted"));

    const rejected = makeSocket("keyless-rejected");
    connect(rejected);

    expect(rejected.disconnect).toHaveBeenCalledWith();
    expect(rejected.handlers.size).toBe(0);
  });
});
