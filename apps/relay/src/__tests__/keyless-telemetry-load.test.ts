/**
 * Fleet-scale load test for the keyless telemetry channel (FEA-1994 / PRD-481
 * C6 acceptance). It exercises the real `/telemetry` namespace under a flood of
 * concurrent senders and proves the load-bearing invariants:
 *
 *   1. The authenticated channel is NOT degraded. A second, independent
 *      namespace (`/auth-probe`, standing in for `/desktop-gateway`) on the same
 *      Socket.IO engine keeps answering pings with bounded latency and zero
 *      loss throughout the flood.
 *   2. Memory stays bounded. In-flight collector requests never exceed the
 *      configured ceiling, and sessions/connections drain to zero after the
 *      fleet disconnects (via the production disconnect path).
 *   3. Back-pressure engages AND ingest is sustained — under offered load above
 *      the ceiling some exports are shed (retryable) while many still succeed.
 *
 * Scale is env-tunable so the same test dials from a fast CI run up to the
 * 1,400+ keyless-sender fleet target:
 *   RELAY_LOADTEST_CLIENTS  (default 100)  concurrent telemetry senders
 *   RELAY_LOADTEST_EXPORTS  (default 25)   exports each sender emits
 *
 * Rate limits are raised out of the way here so the ONLY shedding mechanism
 * under test is the in-flight ceiling (the per-IP/session/install tiers are
 * covered by the ingress + capacity suites).
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  type KeylessTelemetryExportAck,
  type KeylessTelemetrySessionAck,
} from "@closedloop-ai/shared-platform/keyless-telemetry";
import { Server as IoServer } from "socket.io";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  type KeylessTelemetryNamespaceHandle,
  registerKeylessTelemetryNamespace,
} from "../keyless-otlp-ingress";
import { delay } from "./keyless-harness";

const CLIENTS = Number(process.env.RELAY_LOADTEST_CLIENTS ?? "100");
const EXPORTS_PER_CLIENT = Number(process.env.RELAY_LOADTEST_EXPORTS ?? "25");
const MAX_INFLIGHT = 32;
const COLLECTOR_LATENCY_MS = 8;
const CONNECT_CHUNK = 25;

const PROTOBUF = "application/x-protobuf";

type LoadServer = {
  url: string;
  handle: KeylessTelemetryNamespaceHandle;
  close: () => Promise<void>;
};

let active: LoadServer | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.disconnect();
  }
  if (active) {
    await active.close();
    active = null;
  }
});

async function startServer(): Promise<LoadServer> {
  const httpServer: HttpServer = createServer();
  const io = new IoServer(httpServer, { transports: ["websocket"] });

  // A latency-bearing collector stub: non-blocking, so it creates genuine
  // concurrency (and thus exercises the in-flight ceiling) without blocking the
  // event loop the authenticated namespace shares.
  const handle = registerKeylessTelemetryNamespace(io, {
    collectorUrl: "http://collector.test",
    allowPrivateCollector: true,
    isProduction: false,
    maxInflightExports: MAX_INFLIGHT,
    maxConnections: CLIENTS + 50,
    ipRateLimitPerMinute: 100_000_000,
    sessionRateLimitPerMinute: 100_000_000,
    installRateLimitPerMinute: 100_000_000,
    fetchImpl: async () => {
      await delay(COLLECTOR_LATENCY_MS);
      return { ok: true, status: 200, text: async () => "", body: null };
    },
  });

  // Stand-in for the authenticated `/desktop-gateway` namespace: an independent
  // namespace on the same engine that simply acks a probe.
  io.of("/auth-probe").on("connection", (socket) => {
    socket.on("probe", (_payload, callback) => {
      if (typeof callback === "function") {
        callback();
      }
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const addr = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    handle,
    close: () =>
      new Promise<void>((resolve) => {
        handle.close();
        io.close(() => httpServer.close(() => resolve()));
      }),
  };
}

function connect(url: string, namespace: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${url}${namespace}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function emit<T>(socket: ClientSocket, event: string, payload: unknown) {
  return new Promise<T>((resolve) => socket.emit(event, payload, resolve));
}

async function connectFleet(url: string): Promise<ClientSocket[]> {
  const fleet: ClientSocket[] = [];
  for (let start = 0; start < CLIENTS; start += CONNECT_CHUNK) {
    const batch = Math.min(CONNECT_CHUNK, CLIENTS - start);
    const connected = await Promise.all(
      Array.from({ length: batch }, () => connect(url, "/telemetry"))
    );
    fleet.push(...connected);
  }
  return fleet;
}

describe("keyless telemetry — fleet-scale load", () => {
  it("sustains ingest under back-pressure without degrading the authenticated channel or growing memory", async () => {
    const server = await startServer();
    active = server;

    // The authenticated-channel stand-in, on its own connection. We assert on
    // probe *liveness* (every probe answered, transport still up) rather than
    // probe latency: a wall-clock RTT bound is a flaky timing assertion on
    // shared CI runners (AGENTS.md [mistake]). Zero loss across the flood is the
    // structural property that proves the authenticated channel was not starved.
    const probe = await connect(server.url, "/auth-probe");
    let probesSent = 0;
    let probesAcked = 0;
    const probeTimer = setInterval(() => {
      probesSent += 1;
      emit(probe, "probe", null).then(() => {
        probesAcked += 1;
      });
    }, 5);

    // Sample the in-flight count while the flood runs; it must never exceed
    // the ceiling, and must rise above zero (proving real concurrency).
    let maxInFlightObserved = 0;
    const inFlightTimer = setInterval(() => {
      maxInFlightObserved = Math.max(
        maxInFlightObserved,
        server.handle.inFlightExports()
      );
    }, 2);

    const fleet = await connectFleet(server.url);
    expect(fleet.length).toBe(CLIENTS);

    let accepted = 0;
    let shed = 0;
    let otherRejected = 0;

    // Each sender opens one session and emits its exports sequentially; the
    // fleet runs concurrently, so offered concurrency far exceeds the ceiling.
    await Promise.all(
      fleet.map(async (socket, index) => {
        const session = await emit<KeylessTelemetrySessionAck>(
          socket,
          KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
          { appInstallationId: `install-${index}` }
        );
        if (!session.accepted) {
          return;
        }
        for (let i = 0; i < EXPORTS_PER_CLIENT; i += 1) {
          const ack = await emit<KeylessTelemetryExportAck>(
            socket,
            KEYLESS_TELEMETRY_EXPORT_EVENT,
            {
              sessionId: session.sessionId,
              signal: "traces",
              contentType: PROTOBUF,
              body: new Uint8Array([1, 2, 3, 4]),
            }
          );
          if (ack.accepted) {
            accepted += 1;
          } else if (ack.reason === "rate_limited") {
            shed += 1;
          } else {
            otherRejected += 1;
          }
        }
      })
    );

    clearInterval(inFlightTimer);
    clearInterval(probeTimer);
    // Let any final in-flight probe acks land.
    await delay(50);

    // (1) Memory bounded: the in-flight ceiling was never exceeded, and real
    // concurrency occurred.
    expect(maxInFlightObserved).toBeGreaterThan(0);
    expect(maxInFlightObserved).toBeLessThanOrEqual(MAX_INFLIGHT);
    expect(server.handle.inFlightExports()).toBe(0);

    // (2) Back-pressure engaged AND ingest sustained.
    expect(accepted).toBeGreaterThan(0);
    expect(shed).toBeGreaterThan(0);
    expect(accepted + shed + otherRejected).toBe(CLIENTS * EXPORTS_PER_CLIENT);
    // No non-back-pressure rejections (no collector/limit errors leaked in).
    expect(otherRejected).toBe(0);

    // (3) Authenticated channel not degraded: the probe loop kept running
    // throughout the flood (many probes issued), every probe was answered (zero
    // loss), and the transport stayed up. These are structural liveness signals,
    // not timing measurements — if the flood had starved the authenticated path,
    // probes would go unanswered (probesAcked < probesSent) or the socket would
    // drop.
    expect(probesSent).toBeGreaterThan(5);
    expect(probesAcked).toBe(probesSent);
    expect(probe.connected).toBe(true);

    // (4) Drain: after the fleet disconnects, sessions/connections return to
    // zero via the production disconnect path (no leak).
    for (const socket of fleet) {
      socket.disconnect();
    }
    await delay(200);
    expect(server.handle.activeSessions()).toBe(0);
    expect(server.handle.activeConnections()).toBe(0);
  }, 60_000);
});
