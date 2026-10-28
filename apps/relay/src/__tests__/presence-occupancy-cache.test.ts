/**
 * presence-occupancy-cache.test.ts
 *
 * ISS-8531 §2 — the occupancy the relay CACHES and restates on every 30s
 * heartbeat (`presence-forward.ts`) must be one the cloud's fleet-capacity
 * classifier would accept. `typeof === "number"` admitted negative, fractional,
 * unsafe-magnitude and non-finite values, and the relay then originated them
 * forever: the classifier rejected each sample, so `executor_saturation` went
 * absent for that target and a `warn` fired every sampling slot attributed to a
 * desktop that sent one bad frame.
 *
 * The forward path stays permissive on purpose (`presence-forward.ts:64-67`) —
 * a malformed value in the CURRENT frame must still reach the classifier, or
 * screening it here silences the signal instead of raising it. That asymmetry
 * is what these cases pin from both sides.
 *
 * Sibling suite rather than folded into worker-hello-heartbeat-lifecycle.test.ts
 * so each file keeps its own hoisted socket.io mock (gateway-harness.ts) and
 * stays under the noExcessiveLinesPerFile ceiling.
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
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";
import { createWorkerLifecycleFetchFixtures } from "./worker-lifecycle-fetch-fixtures.js";

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const socketIoMocks = vi.hoisted(() => ({
  namespace: { use: vi.fn(), on: vi.fn() },
}));

vi.mock("socket.io", () => ({
  Server: class {
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
const TEST_API_URL = "http://127.0.0.1:19894";

const harness = createGatewayHarness(socketIoMocks.namespace);

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-poc";
  process.env.RELAY_PORT = "20734";
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
  vi.restoreAllMocks();
});

const { stubSmartFetch } = createWorkerLifecycleFetchFixtures(
  TEST_API_URL,
  harness
);

/** Every `desktop.presence` payload the relay forwarded, in order. */
function forwardedPresencePayloads(): Record<string, unknown>[] {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .filter((body) => body.event === "desktop.presence")
    .map((body) => body.payload);
}

async function reportPresence(
  socket: MockRelaySocket,
  payload: unknown
): Promise<void> {
  await socket.handlers.get("desktop.presence")?.(payload);
}

/** One heartbeat tick, plus the microtask turn its forward resolves on. */
async function advanceOneHeartbeat(): Promise<void> {
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(0);
}

// `Infinity` has no JSON literal, so it has to be parsed rather than written --
// a fixture object holding `Number.POSITIVE_INFINITY` is not the wire case.
const PARSED_INFINITY = (
  JSON.parse('{"activeCommands":1e400}') as { activeCommands: number }
).activeCommands;

describe("occupancy cache admits only what the classifier accepts", () => {
  it.each([
    { label: "negative", activeCommands: -1 },
    { label: "fractional", activeCommands: 1.5 },
    {
      label: "past the safe-integer range",
      activeCommands: Number.MAX_SAFE_INTEGER + 2,
    },
    { label: "non-finite", activeCommands: PARSED_INFINITY },
  ])(
    "keeps restating the last valid occupancy after a $label frame",
    async ({ activeCommands }) => {
      vi.useFakeTimers();
      const socket = harness.createMockRelaySocket("sock-occupancy-bad");
      stubSmartFetch();
      await harness.registerSocketTarget(socket, "target-occupancy-bad");

      await reportPresence(socket, { activeCommands: 2 });
      await reportPresence(socket, { activeCommands });
      await advanceOneHeartbeat();

      // Pre-fix the heartbeat carried the impossible value here, and every 30s
      // after it, so the classifier dropped every sample for this target.
      expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 2 });
    }
  );

  it("omits activeCommands on the heartbeat when the only reported value was malformed", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-occupancy-only-bad");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-occupancy-only-bad");

    await reportPresence(socket, { activeCommands: -1 });
    await advanceOneHeartbeat();

    // Nothing valid was ever reported, so the heartbeat states no occupancy --
    // it does not substitute a `0`, which would read as a confirmed-idle
    // executor the relay has no evidence for.
    expect(forwardedPresencePayloads().at(-1)).toEqual({});
  });

  it("caches and replays a valid occupancy unchanged", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-occupancy-good");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-occupancy-good");

    await reportPresence(socket, { activeCommands: 3 });
    await advanceOneHeartbeat();

    // The mutation this kills: a predicate strict enough to reject real input.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 3 });
  });

  it("caches a reported zero rather than treating it as unreported", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-occupancy-zero");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-occupancy-zero");

    await reportPresence(socket, { activeCommands: 2 });
    await reportPresence(socket, { activeCommands: 0 });
    await advanceOneHeartbeat();

    // `>= 0`, not `> 0`: an idle executor is the case the metric most needs.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 0 });
  });

  it("still falls back to the cache for a frame carrying no activeCommands", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-occupancy-absent");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-occupancy-absent");

    await reportPresence(socket, { activeCommands: 4 });
    await reportPresence(socket, { state: "online" });

    // A live desktop sends such frames routinely (the hello-ack presence is
    // one), and the fallback is what keeps this path agreeing with the
    // heartbeat that restates the same cache.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: 4 });
  });

  it("forwards a malformed activeCommands that is in the current frame", async () => {
    vi.useFakeTimers();
    const socket = harness.createMockRelaySocket("sock-occupancy-forward");
    stubSmartFetch();
    await harness.registerSocketTarget(socket, "target-occupancy-forward");

    await reportPresence(socket, { activeCommands: 2 });
    await reportPresence(socket, { activeCommands: -1 });

    // The mutation this kills: a fix that over-reached into the forward path.
    // The API classifier is the only place that can tell a corrupt payload from
    // the omission an older desktop sends, so `-1` has to reach it and raise
    // `activeCommands_invalid` against the frame that actually carried it.
    expect(forwardedPresencePayloads().at(-1)).toEqual({ activeCommands: -1 });
  });
});
