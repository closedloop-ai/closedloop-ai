/**
 * worker-registration-lifecycle.test.ts
 *
 * Covers the worker-registry takeover half of the registration state machine
 * in index.ts:
 *
 *  • cleanupOldWorker — same socket re-hello'ing under a different targetId;
 *    early returns (no old target, same target) and full cleanup (clears timers,
 *    drops the old target's lastHeartbeatAckAt entry)
 *  • cleanupExistingWorker — socket B taking over target T from socket A
 *
 * The hello / disconnect / heartbeat half lives in the sibling
 * worker-hello-heartbeat-lifecycle.test.ts. Split rather than grown so each
 * file keeps its own hoisted socket.io mock (see gateway-harness.ts) and stays
 * under the noExcessiveLinesPerFile ceiling; the fetch doubles both suites
 * drive are shared via worker-lifecycle-fetch-fixtures.ts.
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
  // Unconditional rather than at the end of each test body: a failing assertion
  // aborts the body, and a leaked spy would then silently change behaviour for
  // every later case in the file.
  vi.restoreAllMocks();
  mockEmitProtocolMetric.mockReset();
});

const { makeOkResponse, registerSocket, stubSmartFetch } =
  createWorkerLifecycleFetchFixtures(TEST_API_URL, harness);

/**
 * A repeated `desktop.hello` on an ALREADY-connected socket — the only shape
 * production produces. The namespace connection handler runs once per socket;
 * `hello` is a plain `socket.on` listener with no `once`, no idempotency guard
 * and no "already registered" check, so a client may re-emit it at will.
 *
 * Re-entering through `harness.registerSocketTarget` would re-run that
 * connection handler, re-installing every listener and resetting the pending
 * buffer, so the state the leak actually depends on would never be the state
 * under test.
 */
async function rehello(
  socket: MockRelaySocket,
  targetId: string
): Promise<void> {
  const helloHandler = socket.handlers.get("desktop.hello");
  if (!helloHandler) {
    throw new Error("Expected desktop.hello handler to be registered");
  }
  await helloHandler({ targetId, pluginVersion: "test" });
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
    await rehello(socket, "target-same-t");

    // No spurious Disconnected emitted
    const disconnCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Disconnected
    );
    expect(disconnCalls).toHaveLength(0);
  });

  // ISS-8531: a repeated desktop.hello for the same socket+target orphaned the
  // old heartbeat interval because both cleanupOldWorker and
  // cleanupExistingWorker early-return on this path.  The old interval kept
  // calling sendPresence() every 30 s for the life of the relay process.
  it("clears the displaced heartbeat interval on same-socket same-target re-hello (ISS-8531)", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-same-rehello-leak");
    stubSmartFetch();

    // First hello — installs heartbeat interval #1
    await harness.registerSocketTarget(socket, "target-same-rehello");

    // Second hello for the same target on the same socket — without the fix
    // this creates interval #2 but never clears interval #1
    await rehello(socket, "target-same-rehello");

    // Clear call history so we count only post-re-hello presence calls
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    // Advance past two heartbeat intervals (30 s each)
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const presenceCalls = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, init]) =>
        (JSON.parse(String((init as RequestInit).body)) as { event: string })
          .event === "desktop.presence"
    );
    // Exactly 2: one per interval tick.  Without the fix this is 4 (two
    // intervals firing each tick).
    expect(presenceCalls).toHaveLength(2);
  });

  it("orphaned interval does not survive disconnect after same-target re-hello (ISS-8531)", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-same-rehello-disc");
    stubSmartFetch();

    await harness.registerSocketTarget(socket, "target-disc-rehello");
    await rehello(socket, "target-disc-rehello");

    // Disconnect — should clear the surviving interval
    await harness.disconnectSocketTarget(socket);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    // Advance past two heartbeat intervals — nothing should fire
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const presenceCalls = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, init]) =>
        (JSON.parse(String((init as RequestInit).body)) as { event: string })
          .event === "desktop.presence"
    );
    expect(presenceCalls).toHaveLength(0);
  });

  it("clears the displaced degradedTimer on same-socket same-target re-hello (ISS-8531)", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-same-rehello-degraded");

    // Register with a fetch that fails presence so the degradedTimer arms
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
              targetId: "target-same-degraded",
              gatewaySessionId: "gw-sd",
            })
          );
        }
        if (body.event === "desktop.presence") {
          return Promise.reject(new Error("Heartbeat failed"));
        }
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId: "target-same-degraded",
            gatewaySessionId: "gw-sd",
          })
        );
      })
    );
    await harness.registerSocketTarget(socket, "target-same-degraded");

    // Trigger heartbeat failure to arm degradedTimer on the first context
    await vi.advanceTimersByTimeAsync(30_000);

    // Re-hello for the same target on the same socket — must clear the
    // displaced context's degradedTimer
    stubSmartFetch();
    await rehello(socket, "target-same-degraded");

    mockEmitProtocolMetric.mockClear();

    // Advance past the degraded threshold — the old timer must NOT fire
    await vi.advanceTimersByTimeAsync(60_000);

    const degradedCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string; state?: string }).metric ===
          "connection_state_count" &&
        (c[0] as { state: string }).state === ConnectionState.Degraded
    );
    expect(degradedCalls).toHaveLength(0);
  });

  /** Every `desktop.presence` body this suite's fetch double received. */
  function forwardedPresencePayloads(): Record<string, unknown>[] {
    return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .filter((body) => body.event === "desktop.presence")
      .map((body) => body.payload);
  }

  // ISS-8453: this handler took no payload argument and forwarded a hardcoded
  // `undefined`, so the desktop's `activeCommands` — the only source for
  // `executor_saturation` — was dropped one hop before the cloud could read it.
  // The cloud-side test drives its own dispatcher directly, so nothing there
  // can catch a payload severed here.
  //
  // The trim is the review half of the same line: `activeCommands` is the only
  // field the API reads, and forwarding the whole Socket.IO frame made presence
  // a relay-to-API JSON proxy for a caller-controlled payload. So this asserts
  // the field crosses AND that its neighbours do not — the equality is exact
  // rather than `objectContaining`, which is what makes the second half fail.
  it("forwards the desktop's activeCommands and drops the rest of the frame", async () => {
    const socket = harness.createMockRelaySocket("sock-presence-payload");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-presence-payload");

    await socket.handlers.get("desktop.presence")?.({
      state: "online",
      activeCommands: 2,
      queueDepth: 104,
      unexpected: { nested: "caller-controlled" },
    });

    const payloads = forwardedPresencePayloads();
    expect(payloads).not.toHaveLength(0);
    expect(payloads.at(-1)).toEqual({ activeCommands: 2 });
  });

  // The trim picks the field, it does NOT validate it. A malformed occupancy has
  // to reach the API's classifier — that is the only place that can tell a
  // corrupt payload apart from the omission an older desktop sends, and
  // screening it here would silence the invalid-payload signal instead of
  // raising it.
  it("forwards a malformed activeCommands unscreened, so the API can classify it", async () => {
    const socket = harness.createMockRelaySocket("sock-presence-malformed");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-presence-malformed");

    await socket.handlers.get("desktop.presence")?.({
      state: "online",
      activeCommands: "2",
      queueDepth: 104,
    });

    expect(forwardedPresencePayloads().at(-1)).toEqual({
      activeCommands: "2",
    });
  });

  // A live desktop sends occupancy-less presence frames routinely — the
  // hello-ack presence is `{state:"online"}` with nothing else — so this is a
  // real production shape, not a legacy one. Level semantics: nothing reported a
  // change, so the last stated occupancy is still the current one, and
  // restating it keeps this path agreeing with the heartbeat, which reads the
  // same cache. The case below is the cold-cache half and passes for a
  // different reason, so it does not pin this.
  it("restates the cached occupancy for a frame that carries none", async () => {
    const socket = harness.createMockRelaySocket("sock-presence-warm-cache");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-presence-warm-cache");

    await socket.handlers.get("desktop.presence")?.({ activeCommands: 3 });
    await socket.handlers.get("desktop.presence")?.({ state: "online" });

    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 3 });
  });

  // An older desktop reports no occupancy at all, and nothing has warmed the
  // cache. The field must be OMITTED rather than defaulted: a fabricated `0`
  // reads as a confirmed-idle executor, and the API's absent/invalid split
  // needs the omission to stay an omission.
  it("omits activeCommands entirely for a desktop that reports none", async () => {
    const socket = harness.createMockRelaySocket("sock-presence-legacy");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-presence-legacy");

    await socket.handlers.get("desktop.presence")?.({ state: "online" });

    expect(forwardedPresencePayloads().at(-1)).toEqual({});
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

  it("deletes the old target's lastHeartbeatAckAt entry on re-hello so disconnect leaves size 0", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-orphan-rehello");
    stubSmartFetch();

    // hello T1
    await harness.registerSocketTarget(socket, "target-orphan-T1");

    // Advance past one heartbeat so T1 gets an ack entry
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const { lastHeartbeatAckAt } = await import("../index.js");
    expect(lastHeartbeatAckAt.has("target-orphan-T1")).toBe(true);

    // Re-hello for T2 on the same socket — cleanupOldWorker must delete T1's entry
    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-orphan-T2",
      pluginVersion: "v1",
    });

    expect(lastHeartbeatAckAt.has("target-orphan-T1")).toBe(false);

    // Disconnect — cleans up T2's entry
    await harness.disconnectSocketTarget(socket);

    expect(lastHeartbeatAckAt.size).toBe(0);
  });

  it("T2 heartbeat still works after re-hello from T1", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-rehello-hb-ok");
    stubSmartFetch();

    // hello T1
    await harness.registerSocketTarget(socket, "target-hb-T1");

    // Re-hello for T2
    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-hb-T2",
      pluginVersion: "v1",
    });

    mockEmitProtocolMetric.mockClear();

    // Advance one heartbeat interval — T2's heartbeat should fire
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const presenceCalls = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, init]) =>
        (JSON.parse(String((init as RequestInit).body)) as { event: string })
          .event === "desktop.presence"
    );
    expect(presenceCalls.length).toBeGreaterThanOrEqual(1);
    const lastPresenceBody = JSON.parse(
      String((presenceCalls.at(-1)![1] as RequestInit).body)
    ) as { targetId: string };
    expect(lastPresenceBody.targetId).toBe("target-hb-T2");
  });

  it("does not re-orphan the old target when a presence probe resolves after re-hello", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-inflight-ack");

    let settleT1Presence: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          event: string;
          payload?: { targetId?: string };
          targetId?: string;
        };
        const targetId =
          body.payload?.targetId ?? body.targetId ?? "unknown-target";
        if (
          body.event === "desktop.presence" &&
          targetId === "target-inflight-T1"
        ) {
          return new Promise<Response>((resolve) => {
            settleT1Presence = resolve;
          });
        }
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId,
            gatewaySessionId: `gw-${targetId}`,
          })
        );
      })
    );

    await harness.registerSocketTarget(socket, "target-inflight-T1");

    // Fire T1's heartbeat, then leave its presence probe pending
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settleT1Presence).toBeDefined();

    const { lastHeartbeatAckAt } = await import("../index.js");
    expect(lastHeartbeatAckAt.has("target-inflight-T1")).toBe(false);

    // Re-hello for T2 — clearInterval cannot cancel the in-flight probe
    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-inflight-T2",
      pluginVersion: "v1",
    });

    // The probe lands after teardown. Unguarded, onHeartbeatAck writes T1 back
    // into the map and no cleanup path is left that names T1.
    settleT1Presence?.(
      makeOkResponse({
        emit: [],
        targetId: "target-inflight-T1",
        gatewaySessionId: "gw-target-inflight-T1",
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(lastHeartbeatAckAt.has("target-inflight-T1")).toBe(false);

    await harness.disconnectSocketTarget(socket);
    expect(lastHeartbeatAckAt.size).toBe(0);
  });

  it("does not arm a degraded timer when a presence probe rejects after re-hello", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-inflight-fail");

    let rejectT1Presence: ((error: Error) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          event: string;
          payload?: { targetId?: string };
          targetId?: string;
        };
        const targetId =
          body.payload?.targetId ?? body.targetId ?? "unknown-target";
        if (
          body.event === "desktop.presence" &&
          targetId === "target-latefail-T1"
        ) {
          return new Promise<Response>((_resolve, reject) => {
            rejectT1Presence = reject;
          });
        }
        return Promise.resolve(
          makeOkResponse({
            emit: [],
            targetId,
            gatewaySessionId: `gw-${targetId}`,
          })
        );
      })
    );

    await harness.registerSocketTarget(socket, "target-latefail-T1");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(rejectT1Presence).toBeDefined();

    await socket.handlers.get("desktop.hello")?.({
      targetId: "target-latefail-T2",
      pluginVersion: "v1",
    });

    mockEmitProtocolMetric.mockClear();

    // Unguarded, onHeartbeatFailure arms a fresh degradedTimer on the disposed
    // T1 context — one cleanupOldWorker already ran and can no longer clear.
    rejectT1Presence?.(new Error("late heartbeat failure"));
    await vi.advanceTimersByTimeAsync(0);

    // Past the degraded threshold: T1 must never report degraded
    await vi.advanceTimersByTimeAsync(60_000);

    const degradedCalls = mockEmitProtocolMetric.mock.calls.filter(
      (c) =>
        (c[0] as { metric: string }).metric === "connection_state_count" &&
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
