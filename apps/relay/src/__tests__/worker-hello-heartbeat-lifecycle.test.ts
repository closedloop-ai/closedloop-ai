/**
 * worker-hello-heartbeat-lifecycle.test.ts
 *
 * Covers the connection half of the registration state machine in index.ts,
 * split out of worker-registration-lifecycle.test.ts (which keeps the
 * cleanupOldWorker / cleanupExistingWorker takeover cases):
 *
 *  • desktop.hello — API disconnect response; socket disconnects during await;
 *    non-object payload; no targetId in response
 *  • desktop.hello when the forward itself failed (ISS-7976 BUG 1)
 *  • disconnect handler — is/is-not the current owner
 *  • Heartbeat — ownerToken refresh and heartbeat_freshness metric
 *  • hello-time target registration failure
 *
 * Kept as a sibling suite rather than folded back in so each file keeps its own
 * hoisted socket.io mock (see gateway-harness.ts) and stays under the
 * noExcessiveLinesPerFile ceiling; the fetch doubles both suites drive are
 * shared via worker-lifecycle-fetch-fixtures.ts.
 */

import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
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
import { InMemoryTargetRegistry, ReclaimOutcome } from "../target-registry.js";
import { socketToTarget } from "../worker-registry.js";
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";
import { createWorkerLifecycleFetchFixtures } from "./worker-lifecycle-fetch-fixtures.js";

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
    // Engine.IO stub: index.ts attaches a `connection_error` listener to
    // `io.engine` at module load, so a Server double without one crashes on import.
    engine = { on: vi.fn() };
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
const TEST_API_URL = "http://127.0.0.1:19882";

const harness = createGatewayHarness(socketIoMocks.namespace);

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-whl";
  process.env.RELAY_PORT = "20504";
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

const { makeErrorResponse, makeOkResponse, registerSocket, stubSmartFetch } =
  createWorkerLifecycleFetchFixtures(TEST_API_URL, harness);

// ─── desktop.hello lifecycle ──────────────────────────────────────────────────

describe("desktop.hello lifecycle", () => {
  it("calls socket.disconnect and drains buffer when API returns disconnect:true", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-disconnect");
    harness.getConnectionHandler()(socket);

    // Buffer one command event before hello
    socket.handlers.get("desktop.command.event")?.({ commandId: "c-buffered" });
    expect(socket.data.pendingBuffer).toHaveLength(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [], disconnect: true }))
    );

    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-hello-disc",
    });

    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.data.pendingBuffer).toEqual([]);
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

  it("registers worker when the hello payload is not an object", async () => {
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

    await socket.handlers.get("desktop.hello")?.("not-an-object");
    harness.registeredTestSockets.add(socket);

    socket.handlers.get("desktop.command.event")?.({
      commandId: "non_object_hello_probe",
    });

    await vi.waitFor(() =>
      expect(
        forwardedRequests.some(({ event }) => event === "desktop.command.event")
      ).toBe(true)
    );

    const commandEventRequest = forwardedRequests.find(
      ({ event }) => event === "desktop.command.event"
    );
    expect(commandEventRequest).toMatchObject({
      gatewaySessionId: "gw-no",
      payload: { commandId: "non_object_hello_probe" },
      targetId: "target-non-obj",
    });
  });

  it("drains buffer when hello API returns no targetId", async () => {
    const socket = harness.createMockRelaySocket("sock-hello-no-target-id");
    harness.getConnectionHandler()(socket);

    socket.handlers.get("desktop.command.event")?.({ commandId: "c-buffered" });
    expect(socket.data.pendingBuffer).toHaveLength(1);

    // API responds with no targetId → drainPendingBuffer
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [] }))
    );
    await socket.handlers.get("desktop.hello")?.({ targetId: "irrelevant" });

    expect(socket.data.pendingBuffer).toEqual([]);
  });
});

// ─── desktop.hello when the forward itself failed (ISS-7976 BUG 1) ───────────

/**
 * Drives hello against `response` and returns what the socket observed. A
 * command event is buffered first so the drain is observable:
 * drainPendingBuffer discards it without forwarding, while a socket left
 * silently connected keeps holding it.
 */
async function driveHello(
  socketId: string,
  response: Response
): Promise<{
  socket: MockRelaySocket;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const socket = harness.createMockRelaySocket(socketId);
  harness.getConnectionHandler()(socket);

  socket.handlers.get("desktop.command.event")?.({ commandId: "c-buffered" });
  if (socket.data.pendingBuffer?.length !== 1) {
    throw new Error("Expected the command event to be buffered before hello");
  }

  const helloHandler = socket.handlers.get("desktop.hello");
  if (!helloHandler) {
    throw new Error("Expected desktop.hello handler to be registered");
  }
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  await helloHandler({ targetId: "irrelevant" });
  return { socket, fetchMock };
}

/** ok:true, but the body will not parse, so the same `!(ok && data)` arm runs. */
const NON_JSON_200 = {
  ok: true,
  status: 200,
  url: `${TEST_API_URL}/internal/relay/socket-event`,
  headers: { get: () => "text/html" },
  text: () => Promise.resolve("<html>gateway error</html>"),
} as unknown as Response;

describe("desktop.hello — the API call produced no usable answer", () => {
  it.each([
    ["a 5xx status", "sock-hello-api-500", () => makeErrorResponse(500)],
    // A proxy or edge error page reaches the relay as a 200 with an
    // unparseable body — a different entrance to the same arm.
    ["a 200 with a non-JSON body", "sock-hello-non-json", () => NON_JSON_200],
    // The SECOND `{ emit: [] }` return in vercel-client.ts. Fixing only the
    // transport failure would have left this one producing a silent zombie.
    [
      "a 200 whose `emit` is not an array",
      "sock-hello-emit-not-array",
      () => makeOkResponse({ emit: null, targetId: "target-emit-not-array" }),
    ],
  ])("nacks and disconnects on %s", async (_label, socketId, makeResponse) => {
    const { socket, fetchMock } = await driveHello(socketId, makeResponse());

    // The frame that says why goes out BEFORE the close (ISS-6126), carrying
    // a reason an already-installed desktop maps to real wording.
    expect(socket.emit).toHaveBeenCalledWith("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });
    expect(socket.data.pendingBuffer).toEqual([]);
    // Only the hello itself was forwarded; the buffered event was discarded.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    // The zombie the ticket is about: connected with no registry entry, so
    // every later event buffers to the 100 cap and is then dropped.
    expect(socketToTarget.has(socket.id)).toBe(false);
  });

  it("does NOT nack or disconnect when the API legitimately answers with no targetId", async () => {
    // The control that stops the new arm from over-firing. A well-formed 200
    // carrying no work is NOT a failure: the buffer drains and the socket
    // stays open, exactly as before ISS-7976.
    const { socket, fetchMock } = await driveHello(
      "sock-hello-no-target-control",
      makeOkResponse({ emit: [] })
    );

    expect(socket.data.pendingBuffer).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket.emit).not.toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.anything()
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("does NOT nack or disconnect when the API body itself carries a forwardFailed key", async () => {
    // `forwardFailed` is relay-local; the API body is peer-owned. Passing the
    // peer's JSON straight through let a version-skewed API that gives the key
    // another meaning — or a malformed truthy `"false"` — close a healthy
    // connection. vercel-client strips it, so only its own failure returns can
    // set it.
    const { socket } = await driveHello(
      "sock-hello-peer-owned-flag",
      makeOkResponse({
        emit: [],
        targetId: "target-peer-owned-flag",
        forwardFailed: "false",
      })
    );

    expect(socket.emit).not.toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.anything()
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
    // The peer body's other fields still land: registration happened.
    expect(socketToTarget.get(socket.id)).toBe("target-peer-owned-flag");
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
      .mockResolvedValue({ outcome: ReclaimOutcome.Reclaimed });

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

  /**
   * ISS-8453 review: the heartbeat forwarded a hardcoded `undefined`, and it
   * shares the cloud's 25s fleet-capacity sampling slot with the desktop's own
   * presence — so a heartbeat arriving first claimed the slot and that window's
   * sample carried no occupancy at all. Occupancy is a LEVEL: the desktop emits
   * presence per queue mutation, so between mutations the last reported value is
   * still the current one and restating it is the honest answer.
   */
  function forwardedPresencePayloads(): Record<string, unknown>[] {
    return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .filter((body) => body.event === "desktop.presence")
      .map((body) => body.payload);
  }

  it("restates the desktop's last reported occupancy on the heartbeat", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-hb-occupancy");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-occupancy");

    await socket.handlers.get("desktop.presence")?.({
      state: "online",
      activeCommands: 2,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    // The heartbeat is the LAST presence forwarded, and it carries the number —
    // pre-fix this was `undefined` and the slot was spent on nothing.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 2 });
  });

  it("carries the newer occupancy after the desktop reports again", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-hb-occupancy-update");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-occupancy-update");

    await socket.handlers.get("desktop.presence")?.({ activeCommands: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    // The command finished; the desktop reports the drop.
    await socket.handlers.get("desktop.presence")?.({ activeCommands: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    // Zero is the falsy hazard here: a cache read with `||` or a truthiness
    // guard would silently restate the stale 2 for an idle desktop.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 0 });
  });

  it("omits activeCommands on the heartbeat when the desktop never reported one", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-hb-occupancy-legacy");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-hb-occupancy-legacy");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    // An older desktop states no occupancy, so the heartbeat states none
    // either. Substituting a `0` would publish a confirmed-idle executor the
    // relay has no evidence for.
    expect(forwardedPresencePayloads().at(-1)).toEqual({});
  });

  it("does not carry a previous connection's occupancy into a new worker", async () => {
    vi.useFakeTimers();
    const first = harness.createMockRelaySocket("sock-hb-occupancy-conn1");
    stubSmartFetch();
    await harness.registerSocketTarget(first, "target-hb-occupancy-reconnect");
    await first.handlers.get("desktop.presence")?.({ activeCommands: 3 });

    // A fresh socket takes the target over, as a reconnect does.
    const second = harness.createMockRelaySocket("sock-hb-occupancy-conn2");
    await harness.registerSocketTarget(second, "target-hb-occupancy-reconnect");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    // The cache is per-worker, so the new connection starts with no occupancy
    // rather than replaying the old one until the desktop speaks.
    expect(forwardedPresencePayloads().at(-1)).toEqual({});
  });
});

// ─── hello-time registration failure ─────────────────────────────────────────

/*
 * ISS-6213: the hello-time `register` chain carried a `.catch(() => {})` that
 * could never run, because `register` reports a refused write as `false` rather
 * than rejecting. These pin the contract that made the catch removable: the
 * refusal surfaces as a log and the handshake still completes.
 */
function onlineMetricCalls(targetId: string): unknown[] {
  return mockEmitProtocolMetric.mock.calls.filter(
    (c) =>
      (c[0] as { metric: string }).metric === "connection_state_count" &&
      (c[0] as { state: string }).state === ConnectionState.Online &&
      (c[0] as { computeTargetId: string }).computeTargetId === targetId
  );
}

describe("hello-time target registration failure", () => {
  it("surfaces a refused registration and still completes the handshake", async () => {
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: this suite asserts the call, not the console.
    });
    const registerSpy = vi
      .spyOn(InMemoryTargetRegistry.prototype, "register")
      .mockResolvedValue(false);

    const socket = harness.createMockRelaySocket("sock-register-refused");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-register-refused");
    await Promise.resolve();

    expect(registerSpy).toHaveBeenCalledOnce();
    // The handshake is unaffected: the worker still comes Online on this
    // instance even though no other relay instance can see it.
    expect(onlineMetricCalls("target-register-refused")).toHaveLength(1);
    const refusalCall = logErrorSpy.mock.calls.find(
      ([message]) =>
        message === "Target registration failed; heartbeat reclaim will retry"
    );
    expect(refusalCall?.[1]).toMatchObject({
      targetId: "target-register-refused",
    });
  });

  it("does not log a registration failure when the write lands", async () => {
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: this suite asserts the call, not the console.
    });

    const socket = harness.createMockRelaySocket("sock-register-ok");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-register-ok");
    await Promise.resolve();

    expect(onlineMetricCalls("target-register-ok")).toHaveLength(1);
    expect(
      logErrorSpy.mock.calls.filter(
        ([message]) =>
          message === "Target registration failed; heartbeat reclaim will retry"
      )
    ).toHaveLength(0);
  });
});
