/**
 * gateway-event-handlers.test.ts
 *
 * Covers the socket.on(...) handlers registered inside the
 * namespace.on("connection") block in index.ts:
 *
 *  • Pre-registration buffering — events pushed to pendingBuffer before desktop.hello
 *  • pushPendingBuffer at MAX_PENDING_BUFFER_SIZE (100) cap — 101st dropped
 *  • drainPendingBuffer — buffer discarded when hello returns disconnect or no targetId
 *  • Forward rejection paths — .catch arms when fetch rejects
 *  • Payload ternaries — commandId/computeTargetId from non-object payload
 *  • Registration surface — the exact handler set, and none for retired events
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { socketToTarget, workersByTargetId } from "../worker-registry.js";
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";

// ─── hoisted socket.io namespace mock ────────────────────────────────────────

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
  process.env.INTERNAL_API_SECRET = "test-secret-geh";
  process.env.RELAY_PORT = "20500";
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  await import("../index");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanupRegisteredSockets();
  vi.unstubAllGlobals();
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

function makeHelloResponse(targetId: string) {
  return makeOkResponse({
    emit: [],
    targetId,
    gatewaySessionId: `gw-${targetId}`,
  });
}

function makeEventResponse() {
  return makeOkResponse({ emit: [] });
}

/**
 * Sets fetch to handle hello (returns targetId) and all other events (returns
 * an empty emit), then registers the socket.
 */
async function registerAndStub(
  socket: MockRelaySocket,
  targetId: string
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        event: string;
      };
      return Promise.resolve(
        body.event === "desktop.hello"
          ? makeHelloResponse(targetId)
          : makeEventResponse()
      );
    })
  );
  await harness.registerSocketTarget(socket, targetId);
}
// ─── pre-registration buffering ──────────────────────────────────────────────

describe("pre-registration buffering — events pushed to pendingBuffer before desktop.hello", () => {
  it("buffers desktop.command.event before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-cmd-event");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.command.event")?.({
      commandId: "c1",
      computeTargetId: "t1",
    });
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.command.event");
  });

  it("buffers desktop.command.ack before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-cmd-ack");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.command.ack")?.({ commandId: "c2" });
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.command.ack");
  });

  it("buffers desktop.presence before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-presence");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.presence")?.();
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.presence");
  });

  // ISS-8453: the buffer is replayed with `...args` on the registration path, so
  // buffering presence WITHOUT its payload replays `payload === undefined` and
  // drops the desktop's `activeCommands` — the only source for
  // `executor_saturation`. `pushPendingBuffer`'s args are variadic and optional,
  // so omitting them typechecks; only this assertion catches it. Not a narrow
  // window either: `notifyQueueStats` refuses to re-emit while the counters are
  // unchanged, so for a desktop whose queue is stable across a reconnect the
  // buffered presence is that connection's only occupancy report.
  it("buffers desktop.presence WITH its payload, so the replay still carries activeCommands", () => {
    const socket = harness.createMockRelaySocket("sock-pre-presence-payload");
    harness.getConnectionHandler()(socket);

    socket.handlers.get("desktop.presence")?.({
      state: "online",
      activeCommands: 2,
      queueDepth: 104,
    });

    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.args?.[0]).toEqual(
      expect.objectContaining({ activeCommands: 2, queueDepth: 104 })
    );
  });
});

// ─── pushPendingBuffer at MAX_PENDING_BUFFER_SIZE cap ────────────────────────

describe("pushPendingBuffer at MAX_PENDING_BUFFER_SIZE (100) cap", () => {
  it("drops a generic command event when buffer is full with no ack callback side-effect", () => {
    const socket = harness.createMockRelaySocket("sock-cap-generic");
    harness.getConnectionHandler()(socket);

    for (let i = 0; i < 100; i++) {
      socket.handlers.get("desktop.command.event")?.({ commandId: `c${i}` });
    }

    // 101st command event — no ack, just dropped
    socket.handlers.get("desktop.command.event")?.({ commandId: "overflow" });
    expect(socket.data.pendingBuffer).toHaveLength(100);
  });
});

// ─── drainPendingBuffer ───────────────────────────────────────────────────────

describe("drainPendingBuffer — buffered events discarded when hello returns disconnect or no targetId", () => {
  function bufferCommandTraffic(socket: MockRelaySocket): void {
    socket.handlers.get("desktop.command.event")?.({ commandId: "c-buffered" });
    socket.handlers.get("desktop.command.ack")?.({ commandId: "c-buffered" });
  }

  it("discards the buffer without forwarding it when hello API returns disconnect:true", async () => {
    const socket = harness.createMockRelaySocket("sock-drain-disconnect");
    harness.getConnectionHandler()(socket);
    bufferCommandTraffic(socket);
    expect(socket.data.pendingBuffer).toHaveLength(2);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeOkResponse({ emit: [], disconnect: true }));
    vi.stubGlobal("fetch", fetchMock);

    await socket.handlers.get("desktop.hello")?.({
      targetId: "drain-target-disconnect",
    });

    expect(socket.data.pendingBuffer).toEqual([]);
    // Only the hello itself was forwarded; the buffered events were not.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("discards the buffer without forwarding it when hello API returns no targetId", async () => {
    const socket = harness.createMockRelaySocket("sock-drain-notarget");
    harness.getConnectionHandler()(socket);
    bufferCommandTraffic(socket);
    expect(socket.data.pendingBuffer).toHaveLength(2);

    // No targetId in response → drainPendingBuffer called, no registerWorker
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse({ emit: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await socket.handlers.get("desktop.hello")?.({
      targetId: "drain-target-notarget",
    });

    expect(socket.data.pendingBuffer).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socketToTarget.has(socket.id)).toBe(false);
  });
});

// ─── forward rejection paths ──────────────────────────────────────────────────

describe("forward rejection paths — .catch arm when the desktop.command.ack forward rejects", () => {
  it("completes without throwing when desktop.command.ack forward rejects (no ack callback)", async () => {
    const socket = harness.createMockRelaySocket("sock-reject-cmd-ack");
    await registerAndStub(socket, "target-reject-cmd-ack");

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    // Resolved via the Map directly (not `?.`) so that deleting the
    // desktop.command.ack registration fails this test instead of
    // short-circuiting into a vacuous pass.
    const ackHandler = socket.handlers.get("desktop.command.ack");
    expect(ackHandler).toBeDefined();

    let threw = false;
    try {
      await (ackHandler as (...args: unknown[]) => Promise<void> | void)({
        commandId: "c1",
      });
      // Need to wait for the async catch handler to run
      await Promise.resolve();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The forward was actually attempted and its rejection swallowed — without
    // this, a handler that never called fetch would also "not throw".
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ─── payload ternaries — commandId/computeTargetId from non-object payload ───

describe("payload ternaries — commandId/computeTargetId undefined for non-object payload", () => {
  it("forwards desktop.command.event with non-object payload without throwing", async () => {
    const socket = harness.createMockRelaySocket("sock-non-obj-cmd-event");
    await registerAndStub(socket, "target-non-obj-cmd-event");

    const fetchMock = vi.fn().mockResolvedValue(makeEventResponse());
    vi.stubGlobal("fetch", fetchMock);

    // Non-object payload → commandId and computeTargetId are undefined (log only)
    socket.handlers.get("desktop.command.event")?.(null);
    // Let the enqueue run
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    ) as { payload: unknown };
    expect(body.payload).toBeNull();
  });

  it("forwards desktop.command.ack with non-object payload without throwing", async () => {
    const socket = harness.createMockRelaySocket("sock-non-obj-cmd-ack");
    await registerAndStub(socket, "target-non-obj-cmd-ack");

    const fetchMock = vi.fn().mockResolvedValue(makeEventResponse());
    vi.stubGlobal("fetch", fetchMock);

    await socket.handlers.get("desktop.command.ack")?.(null);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    ) as { payload: unknown };
    expect(body.payload).toBeNull();
  });
});

// ─── the uncovered forwardSocketEvent rejection arms (ISS-7976 3-7) ──────────

describe("forward rejection paths — the arms with no ack callback to observe", () => {
  const NETWORK_ERROR = new Error("Network error");

  /**
   * Lets a fire-and-forget forward's .then/.catch chain settle. `setTimeout 0`
   * is a MACROtask, which is the point: it runs after the whole microtask
   * queue, so an awaited promise chain has certainly resolved by then.
   */
  function flushTasks(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  it("drains the buffer and disconnects when the desktop.hello forward rejects", async () => {
    // The transport-failure twin of ISS-7976 BUG 1. This arm ALREADY
    // disconnected; pinning it is what stops a refactor from quietly making
    // the recoverable 5xx path and this one diverge again.
    const socket = harness.createMockRelaySocket("sock-reject-hello");
    harness.getConnectionHandler()(socket);

    socket.handlers.get("desktop.command.event")?.({ commandId: "c-buffered" });
    expect(socket.data.pendingBuffer).toHaveLength(1);

    const fetchMock = vi.fn().mockRejectedValue(NETWORK_ERROR);
    vi.stubGlobal("fetch", fetchMock);

    const helloHandler = socket.handlers.get("desktop.hello");
    expect(helloHandler).toBeDefined();
    await (helloHandler as (payload: unknown) => Promise<void>)({
      targetId: "target-reject-hello",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket.data.pendingBuffer).toEqual([]);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socketToTarget.has(socket.id)).toBe(false);
  });

  it("keeps the per-socket serial queue usable after a desktop.command.event forward rejects", async () => {
    // desktop.command.event is the one sibling that goes through
    // enqueueForSocket, so its failure mode differs from the covered .ack:
    // every later event on this socket is linked onto the same chain.
    //
    // What this pins is exactly that the NEXT event is still forwarded, and
    // the property it kills is the enqueued function's own try/catch --
    // measured: removing that catch fails this file, while weakening
    // `prev.then(fn, fn)` to `prev.then(fn)` does NOT, because the handler's
    // catch already means `prev` never rejects. The second argument is
    // redundant defence, not the thing keeping the chain alive.
    const socket = harness.createMockRelaySocket("sock-reject-cmd-event");
    await registerAndStub(socket, "target-reject-cmd-event");

    const failingFetch = vi.fn().mockRejectedValue(NETWORK_ERROR);
    vi.stubGlobal("fetch", failingFetch);
    socket.handlers.get("desktop.command.event")?.({ commandId: "c-fails" });
    await flushTasks();
    expect(failingFetch).toHaveBeenCalledOnce();

    // The next event on the SAME socket must still be forwarded.
    const okFetch = vi.fn().mockResolvedValue(makeEventResponse());
    vi.stubGlobal("fetch", okFetch);
    socket.handlers.get("desktop.command.event")?.({ commandId: "c-after" });
    await flushTasks();

    expect(okFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((okFetch.mock.calls[0][1] as RequestInit).body)
    ) as { payload: { commandId: string } };
    expect(body.payload.commandId).toBe("c-after");
  });

  it("settles the desktop.presence handler when its forward rejects", async () => {
    const socket = harness.createMockRelaySocket("sock-reject-presence");
    await registerAndStub(socket, "target-reject-presence");

    const fetchMock = vi.fn().mockRejectedValue(NETWORK_ERROR);
    vi.stubGlobal("fetch", fetchMock);

    const presenceHandler = socket.handlers.get("desktop.presence");
    expect(presenceHandler).toBeDefined();

    let threw = false;
    try {
      await (presenceHandler as () => Promise<void>)();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("completes disconnect cleanup when the disconnect forward rejects", async () => {
    // The forward is fired and NOT awaited, so a rejection here must not stop
    // the local teardown that already ran ahead of it.
    const socket = harness.createMockRelaySocket("sock-reject-disconnect");
    await registerAndStub(socket, "target-reject-disconnect");
    expect(workersByTargetId.has("target-reject-disconnect")).toBe(true);

    const fetchMock = vi.fn().mockRejectedValue(NETWORK_ERROR);
    vi.stubGlobal("fetch", fetchMock);

    socket.connected = false;
    await harness.disconnectSocketTarget(socket);
    await flushTasks();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(workersByTargetId.has("target-reject-disconnect")).toBe(false);
    expect(socketToTarget.has(socket.id)).toBe(false);
  });
});

// ─── unknown events on the authenticated namespace (ISS-7976 branch 10) ─────

describe("authenticated namespace — event registration surface", () => {
  /**
   * Pins the exact set of event names the /desktop-gateway connection handler
   * registers, and that it registers NO catch-all.
   *
   * Socket.IO silently drops an event with no listener, which is the correct
   * degrade for a version-skewed desktop emitting something this relay build
   * predates. What this test can pin is the registration surface, not a live
   * dispatch: these suites mock socket.io, so there is no dispatcher and
   * "emitting an unknown event" is not representable here. The registration
   * surface is what IS pinnable, and it covers the risk the ticket names: a
   * refactor that throws on an unrecognized name has to register something to
   * do it, which changes the set below or trips the `onAny` assertion.
   */
  it("registers exactly the known events and no catch-all", () => {
    const socket = harness.createMockRelaySocket("sock-event-surface");
    harness.getConnectionHandler()(socket);

    expect([...socket.handlers.keys()].sort()).toEqual(
      [
        "desktop.command.ack",
        "desktop.command.event",
        "desktop.hello",
        "desktop.presence",
        "disconnect",
        // attachSocketErrorLogging (error-listeners.ts), not a desktop event.
        "error",
      ].sort()
    );
    // A catch-all is `socket.onAny(fn)` -- a distinct method, so it would
    // never appear among the names above. Asserted separately or it is not
    // asserted at all.
    expect(socket.onAny).not.toHaveBeenCalled();
  });

  // ISS-12735: Desktop stopped emitting these in v0.16.724 and the relay no
  // longer handles them; their wire constants were deleted with the handlers.
  it("registers no handler for the retired legacy Desktop events", () => {
    const socket = harness.createMockRelaySocket("sock-retired-events");
    harness.getConnectionHandler()(socket);

    for (const event of RETIRED_DESKTOP_EVENTS) {
      expect(socket.handlers.has(event)).toBe(false);
    }
  });
});

const RETIRED_DESKTOP_EVENTS = [
  "desktop.telemetry",
  "desktop.analytics",
  "desktop.agent-sessions",
] as const;
