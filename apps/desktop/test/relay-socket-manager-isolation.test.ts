import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { KEYLESS_TELEMETRY_NAMESPACE } from "@repo/shared-platform/keyless-telemetry";
import { Server as SocketIoServer } from "socket.io";
import { io } from "socket.io-client";
import { afterAll, describe, test } from "vitest";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  type DesktopPopHeaders,
} from "../src/main/auth/desktop-pop.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { createRelayTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";

/**
 * ISS-6494. Socket.IO caches one Manager per ORIGIN, so two namespaces on the
 * relay origin share a single Engine.IO transport unless a call opts out with
 * `forceNew`/`multiplex: false`. `extraHeaders` is transport-level: it is fixed
 * by whichever `io()` call built the Manager and cannot be retrofitted onto an
 * already-open transport. When telemetry won that race the gateway's PoP
 * headers were silently dropped and relay validation saw an anonymous client.
 *
 * These assertions run against a REAL socket.io server and a REAL
 * socket.io-client, driven through both production entry points, because the
 * property under test is a behaviour of the client's Manager cache. A fake
 * `io()` returning a fresh object per call cannot multiplex, so it would report
 * success no matter what the production options say.
 */

const ANY_NAMESPACE = /.*/;
/** Neutral third-party namespaces on the relay origin — never a production one. */
const PROBE_A_NAMESPACE = "/iss-6494-probe-a";
const PROBE_B_NAMESPACE = "/iss-6494-probe-b";
// Four sequential waits happen per run, so the per-wait budget is sized to fit
// inside the whole-test one. Otherwise a slow runner trips the outer timeout
// first and reports a bare timeout instead of naming the namespace that stalled.
const CONNECT_TIMEOUT_MS = 10_000;
const WAITS_PER_RUN = 4;
const TEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS * WAITS_PER_RUN + 15_000;
const POP_HEADERS: DesktopPopHeaders = {
  [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-iss-6494",
  [DESKTOP_POP_TIMESTAMP_HEADER]: "1750000000",
  [DESKTOP_POP_SIGNATURE_HEADER]: "signature-iss-6494",
};

type RecordedHandshake = {
  namespace: string;
  /**
   * Stable label for the Engine.IO transport this namespace arrived on. Every
   * namespace multiplexed onto one transport reports the SAME value, so an
   * inequality is direct evidence of two distinct underlying connections.
   */
  connectionId: string;
  headers: Record<string, string | string[] | undefined>;
};

type NamespaceMatcher = (namespace: string) => boolean;

type PendingWaiter = {
  matches: NamespaceMatcher;
  resolve: (handshake: RecordedHandshake) => void;
};

type RelayFixture = {
  origin: string;
  /** Resolves with the first recorded handshake whose namespace matches. */
  waitFor: (
    matches: NamespaceMatcher,
    label: string
  ) => Promise<RecordedHandshake>;
  close: () => Promise<void>;
};

describe("relay socket manager isolation (ISS-6494)", () => {
  afterAll(() => {
    gatewayLog.clear();
  });

  test("telemetry connecting first leaves the gateway its own transport and its PoP headers", {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const relay = await startRelayFixture();
    const transport = createRelayTelemetryTransport({
      getRelayOrigin: () => relay.origin,
      ackTimeoutMs: 50,
      shutdownDrainMs: 0,
    });
    const gateway = new CloudSocketService({
      getRelayOrigin: () => relay.origin,
      getApiKey: () => "sk_live_iss6494",
      // A Desktop-managed key is what makes relay validation demand PoP headers.
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: () => POP_HEADERS,
      getAllowedDirectories: () => [],
      getMaxInFlightCommands: () => 1,
      machineName: "iss-6494-machine",
      pluginVersion: "0.0.0-test",
      desktopClientVersion: "0.0.0-test",
      gatewayProtocolVersion: "1",
      getEnabledOperations: () => [],
    });
    // Assigned inside the ordered sequence below: `io()` builds (or reuses)
    // the per-origin Manager at CALL time, so constructing a probe early
    // would seed the cache before telemetry ever ran.
    let probeA: ReturnType<typeof io> | null = null;
    let probeB: ReturnType<typeof io> | null = null;

    try {
      // The losing order from the ticket: telemetry starts before the gateway
      // and would otherwise own the origin's Manager. Awaiting each connection
      // in turn keeps the sequence deterministic instead of racing them.
      transport.start({
        appInstallationId: "install-iss-6494",
        serviceVersion: "0.0.0-test",
        deploymentEnvironmentName: "test",
      });
      const telemetry = await relay.waitFor(
        (namespace) => namespace === KEYLESS_TELEMETRY_NAMESPACE,
        KEYLESS_TELEMETRY_NAMESPACE
      );

      probeA = io(`${relay.origin}${PROBE_A_NAMESPACE}`, {
        transports: ["websocket"],
      });
      const firstProbe = await relay.waitFor(
        (namespace) => namespace === PROBE_A_NAMESPACE,
        PROBE_A_NAMESPACE
      );
      probeB = io(`${relay.origin}${PROBE_B_NAMESPACE}`, {
        transports: ["websocket"],
      });
      const secondProbe = await relay.waitFor(
        (namespace) => namespace === PROBE_B_NAMESPACE,
        PROBE_B_NAMESPACE
      );

      // Positive control. Two DEFAULT `io()` calls to this exact origin must
      // land on one transport; if they do not, this origin never had the
      // shared-Manager condition and every isolation assertion below would
      // pass vacuously.
      assert.equal(
        secondProbe.connectionId,
        firstProbe.connectionId,
        "positive control failed: default io() options did not multiplex two namespaces on one origin, so this fixture cannot demonstrate isolation"
      );

      // Telemetry must not have populated the per-origin Manager cache the
      // probes then shared.
      assert.notEqual(
        telemetry.connectionId,
        firstProbe.connectionId,
        "telemetry socket was multiplexed onto the shared per-origin Manager"
      );

      // A foreign Manager is now cached for this origin. That is exactly the
      // state the gateway used to inherit, losing its transport-level headers.
      await gateway.start();
      const gatewayHandshake = await relay.waitFor(
        (namespace) =>
          namespace !== KEYLESS_TELEMETRY_NAMESPACE &&
          namespace !== PROBE_A_NAMESPACE &&
          namespace !== PROBE_B_NAMESPACE,
        "the gateway namespace"
      );

      assert.notEqual(
        gatewayHandshake.connectionId,
        firstProbe.connectionId,
        "gateway reused the cached per-origin Manager instead of opening its own transport"
      );
      assert.notEqual(
        gatewayHandshake.connectionId,
        telemetry.connectionId,
        "gateway shares an Engine.IO transport with telemetry"
      );

      // The consequence users actually feel: relay validation sees the PoP
      // headers rather than an anonymous handshake.
      assert.equal(
        headerValue(gatewayHandshake, DESKTOP_POP_SIGNATURE_HEADER),
        POP_HEADERS[DESKTOP_POP_SIGNATURE_HEADER]
      );
      assert.equal(
        headerValue(gatewayHandshake, DESKTOP_POP_GATEWAY_ID_HEADER),
        POP_HEADERS[DESKTOP_POP_GATEWAY_ID_HEADER]
      );
      assert.equal(
        headerValue(gatewayHandshake, DESKTOP_POP_TIMESTAMP_HEADER),
        POP_HEADERS[DESKTOP_POP_TIMESTAMP_HEADER]
      );

      // ...and the isolation is not bought by leaking those credentials onto
      // the anonymous telemetry transport instead.
      assert.equal(
        headerValue(telemetry, DESKTOP_POP_SIGNATURE_HEADER),
        undefined
      );
      assert.equal(
        headerValue(firstProbe, DESKTOP_POP_SIGNATURE_HEADER),
        undefined
      );
    } finally {
      probeA?.disconnect();
      probeB?.disconnect();
      gateway.stop();
      await transport.stop();
      await relay.close();
    }
  });
});

function headerValue(
  handshake: RecordedHandshake,
  header: string
): string | string[] | undefined {
  // Node lowercases inbound header names on the request object.
  return handshake.headers[header.toLowerCase()];
}

async function startRelayFixture(): Promise<RelayFixture> {
  const httpServer = createServer();
  const socketServer = new SocketIoServer(httpServer, {
    transports: ["websocket"],
  });
  const recorded: RecordedHandshake[] = [];
  const waiters: PendingWaiter[] = [];
  // Keyed on the Engine.IO socket OBJECT: multiplexed namespaces are handed the
  // very same instance, so identity is the ground truth for "one transport".
  // (Its `id` would say the same thing but is typed private.)
  const connectionIds = new WeakMap<object, string>();
  let connectionCount = 0;

  socketServer.of(ANY_NAMESPACE).on("connection", (socket) => {
    const connection: object = socket.conn;
    let connectionId = connectionIds.get(connection);
    if (connectionId === undefined) {
      connectionCount += 1;
      connectionId = `engine-connection-${connectionCount}`;
      connectionIds.set(connection, connectionId);
    }
    const handshake: RecordedHandshake = {
      namespace: socket.nsp.name,
      connectionId,
      headers: socket.handshake.headers,
    };
    recorded.push(handshake);
    const index = waiters.findIndex((waiter) =>
      waiter.matches(handshake.namespace)
    );
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(handshake);
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    waitFor: (matches, label) => {
      const existing = recorded.find((handshake) =>
        matches(handshake.namespace)
      );
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<RecordedHandshake>((resolve, reject) => {
        const waiter: PendingWaiter = {
          matches,
          resolve: (handshake) => {
            clearTimeout(timer);
            resolve(handshake);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(
            new Error(
              `no connection on ${label} within ${CONNECT_TIMEOUT_MS}ms (saw: ${recorded
                .map((handshake) => handshake.namespace)
                .join(", ")})`
            )
          );
        }, CONNECT_TIMEOUT_MS);
        waiters.push(waiter);
      });
    },
    close: () => socketServer.close(),
  };
}
