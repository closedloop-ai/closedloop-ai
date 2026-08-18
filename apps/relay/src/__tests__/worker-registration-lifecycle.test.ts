/**
 * worker-registration-lifecycle.test.ts
 *
 * Covers the worker registration state-machine in index.ts:
 *
 *  • cleanupOldWorker — same socket re-hello'ing under a different targetId;
 *    early returns (no old target, same target) and full cleanup (clears timers)
 *  • cleanupExistingWorker — socket B taking over target T from socket A
 *  • registerWorker — pending-buffer replay and isFirstRegistration vs takeover
 *  • desktop.hello — API disconnect response; socket disconnects during await;
 *    non-object payload; no targetId in response
 *  • disconnect handler — is/is-not the current owner
 *  • Heartbeat — ownerToken refresh and heartbeat_freshness metric
 */

import { ConnectionState } from "@repo/observability/telemetry/metrics";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InMemoryTargetRegistry } from "../target-registry.js";
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const mockEmitProtocolMetric = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/observability/telemetry/metrics")
    >();
  return { ...actual, emitProtocolMetric: mockEmitProtocolMetric };
});

const socketIoMocks = vi.hoisted(() => ({
  namespace: { use: vi.fn(), on: vi.fn() },
}));

vi.mock("socket.io", () => ({
  Server: class {
    of(ns?: string) {
      if (ns === "/desktop-gateway") {
        return socketIoMocks.namespace;
      }
      return { use() {}, on() {} };
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  return { createServer: vi.fn(createMockHttpServerFactory()) };
});

// ─── env & module setup ──────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };
const TEST_API_URL = "http://127.0.0.1:19878";

const harness = createGatewayHarness(socketIoMocks.namespace);

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-wrl";
  process.env.RELAY_PORT = "20501";
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "60000";
  await import("../index");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanupRegisteredSockets();
  vi.unstubAllGlobals();
  // Restores the InMemoryTargetRegistry.prototype spies here rather than at the
  // end of each test body: a failing assertion aborts the body, and a leaked
  // prototype spy would then silently change registry behaviour for every
  // later case in the file.
  vi.restoreAllMocks();
  mockEmitProtocolMetric.mockReset();
});

// ─── fetch-mock helpers ───────────────────────────────────────────────────────

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    url: `${TEST_API_URL}/internal/relay/socket-event`,
    headers: { get: () => "application/json" },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Stubs fetch so hello resolves with the targetId in the request payload
 * and all other events (presence, disconnect) resolve with an empty response.
 */
function stubSmartFetch(extraResponses: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        event: string;
        payload?: { targetId?: string };
        targetId?: string;
      };
      const targetId =
        body.payload?.targetId ?? body.targetId ?? "unknown-target";
      const base = { emit: [], targetId, gatewaySessionId: `gw-${targetId}` };
      const override = extraResponses[body.event];
      return Promise.resolve(
        makeOkResponse(override === undefined ? base : { ...base, ...override })
      );
    })
  );
}

async function registerSocket(
  socket: MockRelaySocket,
  targetId: string
): Promise<void> {
  stubSmartFetch();
  await harness.registerSocketTarget(socket, targetId);
}

// ─── cleanupOldWorker ────────────────────────────────────────────────────────

describe("cleanupOldWorker — same socket re-hello'ing under different targetId", () => {
  it("completes cleanly when socket has no previous target (first hello)", async () => {
    // Socket with no prior registration → cleanupOldWorker returns early at L880
    const socket = harness.createMockRelaySocket("sock-no-old-target");
    mockEmitProtocolMetric.mockClear();
    await registerSocket(socket, "target-no-old");

    const onlineCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) => (c[0] as { metric: string }).metric === "connection_state_count"
    );
    expect(onlineCalls).toHaveLength(1);
    expect(onlineCalls[0][0]).toMatchObject({
      state: ConnectionState.Online,
      computeTargetId: "target-no-old",
    });
  });

  it("completes cleanly when socket re-hello's for the same target (oldTargetId === newTargetId)", async () => {
    const socket = harness.createMockRelaySocket("sock-same-target-rehello");
    await registerSocket(socket, "target-same-t");
    mockEmitProtocolMetric.mockClear();

    // Same target re-hello → cleanupOldWorker returns early
    await harness.registerSocketTarget(socket, "target-same-t");

    // No spurious Disconnected emitted
    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(0);
  });

  it("clears the old heartbeatTimer when re-hello'ing for a different target", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-regs-T1-then-T2");

    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-rehello-T1");

    // Re-hello for T2 via same socket → cleanupOldWorker clears T1's heartbeatTimer
    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-rehello-T2",
      pluginVersion: "v1",
    });

    mockEmitProtocolMetric.mockClear();

    // Advance past one heartbeat interval — only T2 should fire, not T1
    await vi.advanceTimersByTimeAsync(30_000);

    const presenceCalls = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, init]) =>
        (JSON.parse(String((init as RequestInit).body)) as { event: string })
          .event === "desktop.presence"
    );
    expect(presenceCalls).toHaveLength(1);
    const presenceBody = JSON.parse(
      String((presenceCalls[0][1] as RequestInit).body)
    ) as { targetId: string };
    expect(presenceBody.targetId).toBe("target-rehello-T2");
  });

  it("clears the degradedTimer when re-hello'ing for a different target with pending degraded state", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-degraded-then-rehello");

    // Register for T1 — heartbeat will fail to set the degradedTimer
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          event: string;
        };
        if (body.event === "desktop.hello") {
          return Promise.resolve(
            makeOkResponse({
              emit: [],
              targetId: "target-degraded-T1",
              gatewaySessionId: "gw-d1",
            })
          );
        }
        if (body.event === "desktop.presence") {
          return Promise.reject(new Error("Heartbeat failed"));
        }
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId: "target-degraded-T1",
            gatewaySessionId: "gw-d1",
          })
        );
      })
    );
    await harness.registerSocketTarget(socket, "target-degraded-T1");

    // Trigger heartbeat failure to set degradedTimer on T1's worker
    await vi.advanceTimersByTimeAsync(30_000);

    // Now re-hello for T2 — cleanupOldWorker should clear the degradedTimer (L892)
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          event: string;
          payload?: { targetId?: string };
        };
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId: body.payload?.targetId ?? "target-degraded-T2",
            gatewaySessionId: "gw-d2",
          })
        );
      })
    );
    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-degraded-T2",
      pluginVersion: "v1",
    });

    mockEmitProtocolMetric.mockClear();

    // Advance past degraded threshold — degraded timer for T1 must NOT fire (was cleared)
    await vi.advanceTimersByTimeAsync(60_000);

    const degradedCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Degraded
    );
    expect(degradedCalls).toHaveLength(0);
  });
});

// ─── cleanupExistingWorker ────────────────────────────────────────────────────

describe("cleanupExistingWorker — socket B taking over target T from socket A", () => {
  it("does not emit Disconnected when no existing worker exists for the target", async () => {
    const socket = harness.createMockRelaySocket("sock-first-for-target");
    mockEmitProtocolMetric.mockClear();
    await registerSocket(socket, "target-fresh-reg");

    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(0);
  });

  it("emits Disconnected for the old socket when a new socket takes over the target", async () => {
    vi.useFakeTimers();
    const socketA = harness.createMockRelaySocket("sock-takeover-A");
    await registerSocket(socketA, "target-takeover");
    mockEmitProtocolMetric.mockClear();

    const socketB = harness.createMockRelaySocket("sock-takeover-B");
    stubSmartFetch();
    await harness.registerSocketTarget(socketB, "target-takeover");

    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(1);
    expect(disconnCalls[0][0]).toMatchObject({
      computeTargetId: "target-takeover",
    });
  });

  it("emits reconnect_frequency metric when a new socket takes over", async () => {
    vi.useFakeTimers();
    const socketA = harness.createMockRelaySocket("sock-reconnect-A");
    await registerSocket(socketA, "target-reconnect-freq");

    const socketB = harness.createMockRelaySocket("sock-reconnect-B");
    stubSmartFetch();
    await harness.registerSocketTarget(socketB, "target-reconnect-freq");

    const reconnectCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) => (c[0] as { metric: string }).metric === "reconnect_frequency"
    );
    expect(reconnectCalls).toHaveLength(1);
  });

  it("clears the existing worker degradedTimer on takeover (L912)", async () => {
    vi.useFakeTimers();
    const socketA = harness.createMockRelaySocket("sock-degrade-takeover-A");

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          event: string;
        };
        if (body.event === "desktop.hello") {
          return Promise.resolve(
            makeOkResponse({
              emit: [],
              targetId: "target-degrade-takeover",
              gatewaySessionId: "gw-dt",
            })
          );
        }
        if (body.event === "desktop.presence") {
          return Promise.reject(new Error("Heartbeat failed"));
        }
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId: "target-degrade-takeover",
            gatewaySessionId: "gw-dt",
          })
        );
      })
    );
    await harness.registerSocketTarget(socketA, "target-degrade-takeover");

    // Trigger heartbeat failure so degradedTimer is set on A's worker
    await vi.advanceTimersByTimeAsync(30_000);

    // Socket B takes over — cleanupExistingWorker clears A's degradedTimer
    const socketB = harness.createMockRelaySocket("sock-degrade-takeover-B");
    stubSmartFetch();
    await harness.registerSocketTarget(socketB, "target-degrade-takeover");

    mockEmitProtocolMetric.mockClear();

    // Advance past degraded threshold — A's degraded timer must NOT fire (cleared)
    await vi.advanceTimersByTimeAsync(60_000);

    const degradedCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Degraded
    );
    // Only B's degraded state can fire if B's heartbeat also fails, but B's fetch
    // resolves successfully, so no Degraded should be emitted
    expect(degradedCalls).toHaveLength(0);
  });
});

// ─── desktop.hello lifecycle ──────────────────────────────────────────────────

describe("desktop.hello lifecycle", () => {
  it("calls socket.disconnect and drains buffer when API returns disconnect:true", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-disconnect");
    harness.getConnectionHandler()(socket);

    const ackFn = vi.fn();
    // Buffer one analytics event before hello
    socket.handlers.get("desktop.analytics")?.(
      {
        event: "command_started",
        properties: {},
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      ackFn
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [], disconnect: true }))
    );

    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-hello-disc",
    });

    expect(socket.disconnect).toHaveBeenCalledOnce();
    // drainPendingBuffer was called → ack received ValidationFailed
    expect(ackFn).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: false })
    );
  });

  it("does not register worker when socket.connected is false after hello await", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-disconn-during");
    harness.getConnectionHandler()(socket);
    mockEmitProtocolMetric.mockClear();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        // Simulate socket disconnecting while the hello awaits
        socket.connected = false;
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId: "target-disconn-during",
            gatewaySessionId: "gw-dd",
          })
        );
      })
    );

    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-disconn-during",
    });

    // registerWorker must NOT have run → no Online metric
    const onlineCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Online
    );
    expect(onlineCalls).toHaveLength(0);
  });

  it("registers worker with undefined pluginVersion when payload is not an object", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-non-obj-payload");
    harness.getConnectionHandler()(socket);

    const forwardedRequests: Array<{
      event: string;
      gatewaySessionId?: string;
      payload?: Record<string, unknown>;
      targetId?: string;
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          event: string;
          gatewaySessionId?: string;
          payload?: Record<string, unknown>;
          targetId?: string;
        };
        forwardedRequests.push(request);

        const response =
          request.event === "desktop.hello"
            ? {
                emit: [],
                targetId: "target-non-obj",
                gatewaySessionId: "gw-no",
              }
            : { emit: [] };
        return Promise.resolve(makeOkResponse(response));
      })
    );

    // Non-object payload → pluginVersion branch evaluates to undefined
    await socket.handlers.get("desktop.hello")?.("not-an-object");
    harness.registeredTestSockets.add(socket);

    socket.handlers.get("desktop.telemetry")?.({
      event: "non_object_hello_probe",
    });

    await vi.waitFor(() =>
      expect(
        forwardedRequests.some(({ event }) => event === "desktop.telemetry")
      ).toBe(true)
    );

    const telemetryRequest = forwardedRequests.find(
      ({ event }) => event === "desktop.telemetry"
    );
    expect(telemetryRequest).toMatchObject({
      gatewaySessionId: "gw-no",
      payload: { event: "non_object_hello_probe" },
      targetId: "target-non-obj",
    });
    expect(telemetryRequest?.payload).not.toHaveProperty("pluginVersion");
  });

  it("drains buffer when hello API returns no targetId", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-no-target-id");
    harness.getConnectionHandler()(socket);

    const ackFn = vi.fn();
    socket.handlers.get("desktop.analytics")?.(
      {
        event: "command_started",
        properties: {},
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      ackFn
    );

    // API responds with no targetId → drainPendingBuffer
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [] }))
    );
    await socket.handlers.get("desktop.hello")?.({ targetId: "irrelevant" });

    expect(ackFn).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: false })
    );
  });
});

// ─── disconnect handler ───────────────────────────────────────────────────────

describe("disconnect handler — is/is-not the current owner", () => {
  it("emits Disconnected and forwards disconnect to API when socket is the current owner", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-owner-disconnect");
    await registerSocket(socket, "target-owner-disc");
    mockEmitProtocolMetric.mockClear();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    socket.connected = false;
    await harness.disconnectSocketTarget(socket);

    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(1);

    // API should be notified via disconnect event forward
    const disconnectForwards = fetchMock.mock.calls.filter(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        event: string;
      };
      return body.event === "disconnect";
    });
    expect(disconnectForwards).toHaveLength(1);
  });

  it("does not emit Disconnected or notify API when socket is not the current owner", async () => {
    vi.useFakeTimers();
    const socketA = harness.createMockRelaySocket("sock-non-owner-A");
    await registerSocket(socketA, "target-non-owner");

    // Socket B takes over → A is no longer the owner
    const socketB = harness.createMockRelaySocket("sock-non-owner-B");
    stubSmartFetch();
    await harness.registerSocketTarget(socketB, "target-non-owner");

    mockEmitProtocolMetric.mockClear();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    // Socket A disconnects as non-owner
    socketA.connected = false;
    const disconnectHandlerA = socketA.handlers.get("disconnect");
    await disconnectHandlerA?.("transport close");

    // No Disconnected metric for target-non-owner from A's disconnect
    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(0);

    // No "disconnect" API forward from A
    const disconnectForwards = fetchMock.mock.calls.filter(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        event: string;
      };
      return body.event === "disconnect";
    });
    expect(disconnectForwards).toHaveLength(0);
  });
});

// ─── heartbeat lifecycle ──────────────────────────────────────────────────────

describe("heartbeat lifecycle — ownerToken refresh and heartbeat_freshness metric", () => {
  it("calls targetRegistry.refreshTtl on first successful heartbeat", async () => {
    vi.useFakeTimers();
    const refreshTtlSpy = vi
      .spyOn(InMemoryTargetRegistry.prototype, "refreshTtl")
      .mockResolvedValue();

    const socket = harness.createMockRelaySocket("sock-hb-refresh-ttl");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-refresh-ttl");

    // First heartbeat fires at 30000ms
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    expect(refreshTtlSpy).toHaveBeenCalledOnce();
    expect(refreshTtlSpy.mock.calls[0][0]).toBe("target-hb-refresh-ttl");
    expect(typeof refreshTtlSpy.mock.calls[0][1]).toBe("string"); // ownerToken is a string
  });

  /*
   * ISS-5811: the entry is written once at hello with a 5-minute TTL, and the
   * old refresh script refused to touch a missing key -- so a lost entry
   * (heartbeats stalled past the TTL, Redis failover, a failed register at
   * hello) made a CONNECTED desktop invisible to every other relay instance
   * until it reconnected. Observed as never-started launches failing in ~0.4s
   * with target_not_connected while the target sat online. The heartbeat now
   * heals: a refresh miss re-creates the entry from the metadata hello kept.
   */
  it("re-creates a missing registry entry when the refresh reports a miss", async () => {
    vi.useFakeTimers();
    const refreshTtlSpy = vi
      .spyOn(InMemoryTargetRegistry.prototype, "refreshTtl")
      .mockResolvedValue(false);
    const reclaimSpy = vi
      .spyOn(InMemoryTargetRegistry.prototype, "reclaim")
      .mockResolvedValue(true);

    const socket = harness.createMockRelaySocket("sock-hb-heal");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-heal");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaimSpy).toHaveBeenCalledOnce();
    const [healedTarget, healedMeta] = reclaimSpy.mock.calls[0];
    expect(healedTarget).toBe("target-hb-heal");
    // The healed entry must be the SAME identity hello registered -- same
    // ownerToken the refresh was attempted with -- or the heal would install
    // an entry the next refresh cannot verify and the cycle would repeat.
    expect(healedMeta.ownerToken).toBe(refreshTtlSpy.mock.calls[0][1]);
    expect(healedMeta.socketId).toBe("sock-hb-heal");
  });

  it("leaves the registry alone while the refresh succeeds", async () => {
    vi.useFakeTimers();
    // Spied for the side effect only — a refresh that reports success.
    vi.spyOn(InMemoryTargetRegistry.prototype, "refreshTtl").mockResolvedValue(
      true
    );
    const reclaimSpy = vi.spyOn(InMemoryTargetRegistry.prototype, "reclaim");

    const socket = harness.createMockRelaySocket("sock-hb-no-heal");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-no-heal");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaimSpy).not.toHaveBeenCalled();
  });

  it("does not emit heartbeat_freshness on the first heartbeat (no previous ack)", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-hb-freshness-first");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-freshness-first");

    mockEmitProtocolMetric.mockClear();

    // First heartbeat — no previous ack → heartbeat_freshness NOT emitted
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const freshnessCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) => (c[0] as { metric: string }).metric === "heartbeat_freshness"
    );
    expect(freshnessCalls).toHaveLength(0);
  });

  it("emits heartbeat_freshness metric on the second heartbeat (previous ack exists)", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-hb-freshness-second");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-freshness-second");

    // First heartbeat: sets lastHeartbeatAckAt, no heartbeat_freshness
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    mockEmitProtocolMetric.mockClear();

    // Second heartbeat: prev is now set → heartbeat_freshness IS emitted
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const freshnessCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) => (c[0] as { metric: string }).metric === "heartbeat_freshness"
    );
    expect(freshnessCalls).toHaveLength(1);
    expect(freshnessCalls[0][0]).toMatchObject({
      metric: "heartbeat_freshness",
      computeTargetId: "target-hb-freshness-second",
    });
    expect(typeof (freshnessCalls[0][0] as { value: unknown }).value).toBe(
      "number"
    );
  });
});
