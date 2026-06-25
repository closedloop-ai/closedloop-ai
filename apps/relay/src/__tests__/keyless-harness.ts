/**
 * Real-boundary test harness for the keyless telemetry ingress: a real
 * Socket.IO server with the `/telemetry` namespace registered, a real fake
 * OTLP collector (node http), and a real socket.io-client. No mocks — exercises
 * the production code path end to end. Shared by the ingress + security suites.
 * Named without `.test` so vitest does not collect it as a suite.
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as IoServer } from "socket.io";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import {
  type KeylessTelemetryConfig,
  type KeylessTelemetryNamespaceHandle,
  registerKeylessTelemetryNamespace,
} from "../keyless-otlp-ingress";

export type CollectorRecord = {
  path: string;
  contentType: string | undefined;
  body: Buffer;
};

export type CollectorResponse = {
  status: number;
  body?: string;
  /** Never respond (drives the collector timeout path). */
  hang?: boolean;
  /** Abruptly destroy the socket (drives the network-error path). */
  destroy?: boolean;
};

export type Harness = {
  url: string;
  collectorUrl: string;
  records: CollectorRecord[];
  setCollectorResponse: (response: CollectorResponse) => void;
  handle: KeylessTelemetryNamespaceHandle;
  close: () => Promise<void>;
};

function listen(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function makeHarness(
  overrides: Partial<KeylessTelemetryConfig> = {},
  opts: { withCollector?: boolean } = {}
): Promise<Harness> {
  const withCollector = opts.withCollector ?? true;
  const records: CollectorRecord[] = [];
  let response: CollectorResponse = { status: 200 };

  let collectorUrl = "";
  let collectorServer: HttpServer | null = null;
  if (withCollector) {
    collectorServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        records.push({
          path: req.url ?? "",
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        if (response.hang) {
          return;
        }
        if (response.destroy) {
          res.destroy();
          return;
        }
        res.statusCode = response.status;
        res.end(response.body ?? "");
      });
    });
    await listen(collectorServer);
    const collectorAddr = collectorServer.address() as AddressInfo;
    collectorUrl = `http://127.0.0.1:${collectorAddr.port}`;
  }

  const httpServer = createServer();
  const io = new IoServer(httpServer, { transports: ["websocket"] });
  const handle = registerKeylessTelemetryNamespace(io, {
    collectorUrl:
      overrides.collectorUrl === undefined
        ? collectorUrl || null
        : overrides.collectorUrl,
    allowPrivateCollector: true,
    isProduction: false,
    ...overrides,
  });
  await listen(httpServer);
  const addr = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    collectorUrl,
    records,
    setCollectorResponse: (next) => {
      response = next;
    },
    handle,
    close: async () => {
      handle.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (collectorServer) {
        await closeServer(collectorServer);
      }
    },
  };
}

export type KeylessClient = {
  socket: ClientSocket;
  emit: <T>(event: string, payload: unknown) => Promise<T>;
  emitNoAck: (event: string, payload: unknown) => void;
  disconnect: () => void;
};

export function connectClient(url: string): Promise<KeylessClient> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${url}/telemetry`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    socket.on("connect", () => {
      resolve({
        socket,
        emit: <T>(event: string, payload: unknown) =>
          new Promise<T>((res) => socket.emit(event, payload, res)),
        emitNoAck: (event: string, payload: unknown) =>
          socket.emit(event, payload),
        disconnect: () => socket.disconnect(),
      });
    });
    socket.on("connect_error", reject);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
