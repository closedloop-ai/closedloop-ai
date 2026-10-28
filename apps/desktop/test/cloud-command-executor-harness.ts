/**
 * @file cloud-command-executor-harness.ts
 * @description The real-gateway harness the `CloudCommandExecutor` suites
 * share: a loopback `http.Server` standing in for the gateway, an executor
 * factory bound to its port, command/cancel builders, and the waiters.
 *
 * Extracted from `cloud-command-executor.test.ts` (ISS-8883) so a sibling
 * suite can drive the same real transport — no `fetch` mock — without copying
 * the harness, and so the grandfathered suite shrinks instead of growing.
 *
 * The gateway is module state: `startGateway` binds it, `closeGateway` tears it
 * down, and a suite's own `afterEach` calls the latter after disposing its
 * executor.
 */
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CloudCommandExecutor,
  type CloudCommandExecutorOptions,
} from "../src/main/cloud/cloud-command-executor.js";
import type {
  DesktopCancelEvent,
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud/cloud-protocol.js";

export type StreamEvent = Omit<
  DesktopCommandStreamEvent,
  "protocolVersion" | "messageId" | "timestamp"
>;

export type GatewayHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body: string
) => Promise<void>;

let gatewayServer: http.Server | null = null;
let gatewayPort = 0;

export function createExecutor(options: {
  maxInFlightCommands: number;
  onAck?: (
    event: Omit<
      DesktopCommandAckEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >
  ) => void;
  onEvent: (event: StreamEvent) => void;
  onQueueStatsChange?: (stats: {
    activeCommands: number;
    queueDepth: number;
  }) => void;
  prepareCommandForExecution?: CloudCommandExecutorOptions["prepareCommandForExecution"];
  gatewayResponseTimeoutMs?: number;
  maxBufferedEventsPerCommand?: number;
  cancelForceSettleGraceMs?: number;
}): CloudCommandExecutor {
  return new CloudCommandExecutor({
    getGatewayPort: () => gatewayPort,
    getGatewayAuthToken: () => "test-gateway-token",
    maxInFlightCommands: options.maxInFlightCommands,
    sendCommandAck: options.onAck ?? (() => {}),
    sendCommandEvent: options.onEvent,
    onQueueStatsChange: options.onQueueStatsChange,
    ...(options.gatewayResponseTimeoutMs === undefined
      ? {}
      : { gatewayResponseTimeoutMs: options.gatewayResponseTimeoutMs }),
    ...(options.maxBufferedEventsPerCommand === undefined
      ? {}
      : { maxBufferedEventsPerCommand: options.maxBufferedEventsPerCommand }),
    ...(options.cancelForceSettleGraceMs === undefined
      ? {}
      : { cancelForceSettleGraceMs: options.cancelForceSettleGraceMs }),
    ...(options.prepareCommandForExecution
      ? { prepareCommandForExecution: options.prepareCommandForExecution }
      : {}),
  });
}

export function buildCommand(
  commandId: string,
  query: Record<string, string>,
  options?: {
    repoPath?: string;
    timeoutMs?: number | null;
    path?: string;
  }
): DesktopCommandEvent {
  return {
    protocolVersion: "1",
    messageId: `${commandId}-message`,
    timestamp: new Date().toISOString(),
    commandId,
    operationId: "git_action",
    method: "POST",
    path: options?.path ?? "/api/gateway/git",
    query,
    body: {
      action: "status",
      repoPath: options?.repoPath ?? "/repo/default",
    },
    timeoutMs: options?.timeoutMs ?? undefined,
  };
}

export function buildCancel(
  commandId: string,
  reason: string
): DesktopCancelEvent {
  return {
    protocolVersion: "1",
    messageId: `${commandId}-cancel`,
    timestamp: new Date().toISOString(),
    commandId,
    reason,
  };
}

export function countDone(events: StreamEvent[], commandId: string): number {
  return events.filter(
    (event) => event.commandId === commandId && event.eventType === "done"
  ).length;
}

export async function startGateway(handler: GatewayHandler): Promise<void> {
  gatewayServer = http.createServer((request, response) => {
    readBody(request)
      .then((body) => handler(request, response, body))
      .catch((error) => {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : "unknown test server failure",
          })
        );
      });
  });

  await new Promise<void>((resolve, reject) => {
    gatewayServer?.listen(0, "127.0.0.1", () => resolve());
    gatewayServer?.once("error", reject);
  });

  const address = gatewayServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test gateway server");
  }
  gatewayPort = address.port;
}

/** Close the gateway bound by {@link startGateway}; a no-op when none is up. */
export async function closeGateway(): Promise<void> {
  if (!gatewayServer) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    gatewayServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  gatewayServer = null;
  gatewayPort = 0;
}

export async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await sleep(15);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
