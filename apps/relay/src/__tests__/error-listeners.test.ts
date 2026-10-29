import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import type { Server, Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachEngineConnectionErrorLogging,
  attachHttpServerErrorLogging,
  attachSocketErrorLogging,
} from "../error-listeners.js";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { log } = await import("@repo/observability/log");
const logError = vi.mocked(log.error);
const logWarn = vi.mocked(log.warn);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attachHttpServerErrorLogging", () => {
  it("swallows and logs a post-bind server error that would otherwise be an uncaught exception", () => {
    const server = new EventEmitter();
    const failure = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    // Baseline: EventEmitter re-throws an "error" with no listener registered.
    // This is the production failure mode the listener exists to prevent, so
    // asserting it here keeps the test below from passing vacuously.
    expect(() => server.emit("error", failure)).toThrow("read ECONNRESET");

    attachHttpServerErrorLogging(server as unknown as HttpServer);

    expect(() => server.emit("error", failure)).not.toThrow();
    expect(logError).toHaveBeenCalledWith("Relay HTTP server error", {
      errorClass: ErrorClass.Connection,
      code: "ECONNRESET",
      error: "read ECONNRESET",
    });
  });

  it("stays registered across repeated errors so the server keeps a listener for its whole lifetime", () => {
    const server = new EventEmitter();
    attachHttpServerErrorLogging(server as unknown as HttpServer);

    server.emit("error", new Error("first"));
    server.emit("error", new Error("second"));

    expect(logError).toHaveBeenCalledTimes(2);
    expect(server.listenerCount("error")).toBe(1);
  });
});

describe("attachSocketErrorLogging", () => {
  it("logs a socket error with its org/user context instead of throwing", () => {
    const socket = Object.assign(new EventEmitter(), { id: "socket-1" });

    expect(() => socket.emit("error", new Error("invalid packet"))).toThrow(
      "invalid packet"
    );

    attachSocketErrorLogging(socket as unknown as Socket, {
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(() =>
      socket.emit("error", new Error("invalid packet"))
    ).not.toThrow();
    expect(logError).toHaveBeenCalledWith("Relay socket error", {
      socketId: "socket-1",
      errorClass: ErrorClass.Protocol,
      organizationId: "org-1",
      userId: "user-1",
      error: "invalid packet",
    });
  });

  it("omits org/user when no context is supplied (the keyless /telemetry namespace)", () => {
    const socket = Object.assign(new EventEmitter(), { id: "socket-2" });
    attachSocketErrorLogging(socket as unknown as Socket);

    socket.emit("error", new Error("bad frame"));

    expect(logError).toHaveBeenCalledWith("Relay socket error", {
      socketId: "socket-2",
      errorClass: ErrorClass.Protocol,
      organizationId: undefined,
      userId: undefined,
      error: "bad frame",
    });
  });

  it("describes a non-Error rejection value without throwing", () => {
    const socket = Object.assign(new EventEmitter(), { id: "socket-3" });
    attachSocketErrorLogging(socket as unknown as Socket);

    socket.emit("error", "middleware rejected");

    expect(logError).toHaveBeenCalledWith(
      "Relay socket error",
      expect.objectContaining({ error: "middleware rejected" })
    );
  });
});

describe("attachEngineConnectionErrorLogging", () => {
  it("logs a handshake failure that occurs before any Socket exists", () => {
    const engine = new EventEmitter();
    attachEngineConnectionErrorLogging({ engine } as unknown as Server);

    engine.emit("connection_error", {
      req: { url: "/socket.io/?EIO=4&sid=secret-session" },
      code: 3,
      message: "Bad request",
      context: { name: "TRANSPORT_MISMATCH" },
    });

    expect(logWarn).toHaveBeenCalledWith("Relay engine connection error", {
      errorClass: ErrorClass.Connection,
      code: 3,
      error: "Bad request",
    });
  });

  it("never forwards the raw request (headers and the sid query) to the log sink", () => {
    const engine = new EventEmitter();
    attachEngineConnectionErrorLogging({ engine } as unknown as Server);

    engine.emit("connection_error", {
      req: {
        url: "/socket.io/?EIO=4&sid=secret-session",
        headers: { cookie: "session=secret" },
      },
      code: 0,
      message: "Transport unknown",
    });

    const [, payload] = logWarn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).not.toHaveProperty("req");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("falls back to a placeholder when the engine reports no message", () => {
    const engine = new EventEmitter();
    attachEngineConnectionErrorLogging({ engine } as unknown as Server);

    engine.emit("connection_error", { code: 1 });

    expect(logWarn).toHaveBeenCalledWith(
      "Relay engine connection error",
      expect.objectContaining({ code: 1, error: "unknown" })
    );
  });
});
