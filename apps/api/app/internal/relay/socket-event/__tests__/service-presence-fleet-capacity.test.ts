/**
 * ISS-8171: the fleet-capacity gauges must be sampled from the relay's periodic
 * presence probe, not only from `desktop.hello`. A stable connection sends one
 * hello and then nothing, so a hello-only emit leaves the gauges unsampled for
 * the life of that connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindComputeTargetById,
  mockHeartbeat,
  mockRecordRelayPresence,
  mockCountCommandsForTarget,
  mockEmitQueueMetric,
  mockLogWarn,
  mockLogDebug,
  pendingWork,
} = vi.hoisted(() => ({
  mockFindComputeTargetById: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockRecordRelayPresence: vi.fn(),
  mockCountCommandsForTarget: vi.fn(),
  mockEmitQueueMetric: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
  pendingWork: [] as Promise<unknown>[],
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    listNonTerminalDispatchCommands: vi.fn(async () => []),
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
    countCommandsForTarget: mockCountCommandsForTarget,
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: vi.fn(),
    updateOwned: vi.fn(),
    setOnlineState: vi.fn(),
    heartbeat: mockHeartbeat,
    recordRelayPresence: mockRecordRelayPresence,
    findById: mockFindComputeTargetById,
  },
  isComputeTargetGatewayConflictResult: () => false,
}));

// ISS-8686 put a command drain behind the presence path, so any case here that
// drives `queued > 0` now reaches `releaseQueuedCommands`. Unmocked, its reads
// go to a real Prisma client from a unit suite — and the drain's own `.catch`
// swallows the failure into a mocked `log.warn`, so it would never show as red.
vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  // Only a non-null claim matters to the drain from here; the lease's own
  // semantics live in `command-drain.test.ts` and the integration suite.
  acquireCommandDrainLease: vi.fn(async () => new Date()),
  renewCommandDrainLease: vi.fn(async () => new Date()),
  releaseCommandDrainLease: vi.fn(async () => undefined),
  countInFlightCommandsForDispatch: vi.fn(async () => 0),
  listQueuedCommandsForDispatch: vi.fn(async () => []),
  requeueUndeliveredCommands: vi.fn(async () => 0),
}));

vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/compute-targets/relay-command-helpers")
    >()),
    dispatchRelayCommandToRelay: vi.fn(async () => ({ delivered: true })),
  })
);

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: vi.fn(),
    subscribeOperations: vi.fn(() => () => {
      // no-op unsubscribe
    }),
    subscribeTargetConnection: vi.fn(() => () => {
      // no-op unsubscribe
    }),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isComputeTargetSigningEligible: vi.fn(),
}));

vi.mock("@repo/analytics/server", () => ({ analytics: { capture: vi.fn() } }));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    debug: mockLogDebug,
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn(() => ({})),
  ZERO_GATEWAY_SESSION_ID: "zero-gateway-session-id",
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitConnectionStateEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitProtocolMetric: vi.fn(),
  emitQueueMetric: mockEmitQueueMetric,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    pendingWork.push(promise);
    return promise;
  },
}));

vi.mock("@/lib/desktop-gateway-wire", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/desktop-gateway-wire")>();
  return {
    ...actual,
    isTerminalEventData: vi.fn(),
    toEnvelope: <T extends Record<string, unknown>>(payload: T) => payload,
    toWireCommandFromStore: vi.fn((cmd: unknown) => cmd),
  };
});

// Spread the real module rather than list its exports: only the timeout is
// under test here, and an exhaustive factory breaks every consumer of this
// module the day it gains an export.
vi.mock("@/lib/desktop-gateway-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-gateway-types")>()),
  HELLO_OPERATION_TIMEOUT_MS: 5000,
}));

import type { JsonObject } from "@repo/api/src/types/common";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { dispatchSocketEvent } from "../service";
import {
  FLEET_CAPACITY_LATCH_TTL_MS,
  FLEET_CAPACITY_TRACKED_TARGET_CAP,
  resetFleetCapacitySamplerForTests,
} from "../service/fleet-capacity-sampler";

const TARGET_ID = "target-presence-1";
const AUTH = {
  organizationId: "org-presence-test",
  userId: "user-presence-test",
  clerkUserId: "clerk-presence-test",
};

/** Drives the production dispatcher for one target, without draining. */
function dispatchPresenceFor(targetId: string, payload: JsonObject = {}) {
  return dispatchSocketEvent({
    event: "desktop.presence",
    payload,
    auth: AUTH,
    targetId,
    correlation: {},
    requestArrivedAt: Date.now(),
  });
}

/** Drives the production dispatcher and drains the emit scheduled on it. */
async function dispatchPresence(payload: JsonObject = {}) {
  const result = await dispatchPresenceFor(TARGET_ID, payload);
  await Promise.all(pendingWork);
  return result;
}

/**
 * A presence payload from a desktop new enough to report its own executor
 * occupancy. The bare `{}` these helpers default to is the older client, which
 * reports none.
 */
function presenceWithActive(activeCommands: number): JsonObject {
  return { activeCommands };
}

function emittedMetricNames(): string[] {
  return mockEmitQueueMetric.mock.calls.map((call) => call[0].metric);
}

/**
 * Drains the microtask queue without moving the clock.
 *
 * A sample whose lookup outlived the 5s wrapper is no longer reachable through
 * `pendingWork` — that promise already settled on the timeout — so this is the
 * only way to reach the emit it would still publish when it finally resolves.
 */
async function flushPendingMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await Promise.resolve();
  }
}

function mockCounts(queued: number, inFlight: number): void {
  mockCountCommandsForTarget.mockImplementation((_targetId, statuses) =>
    Promise.resolve(
      statuses === DesktopCommandStatus.Queued ? queued : inFlight
    )
  );
}

// Both of the sampler's maps are module state that outlives a single case: a
// case that leaves a read hung latches its target, and the cap case fills the
// interval map outright. `resetFleetCapacitySamplerForTests` is what isolates
// cases here — not the clock advance, and not case ordering.
const HEARTBEAT_INTERVAL_MS = RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS;
// The ceiling the latch's own deadline must fit under: a hung read may cost a
// bounded silence, never an open-ended one.
const LATCH_RELEASE_PROBE_MS = 10 * 60 * 1000;
let clock = Date.parse("2026-08-27T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  resetFleetCapacitySamplerForTests();
  pendingWork.length = 0;
  clock += 10 * 60 * 1000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  mockHeartbeat.mockResolvedValue(true);
  mockRecordRelayPresence.mockResolvedValue(true);
  mockFindComputeTargetById.mockResolvedValue({
    id: TARGET_ID,
    capabilities: { maxInFlightCommands: 4 },
  });
  mockCounts(0, 0);
});

// Unconditional: a case that throws before restoring would otherwise leak a
// frozen clock into every later test in this worker.
afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchSocketEvent — desktop.presence fleet capacity", () => {
  it("emits executor_saturation from the presence path, using the persisted maxInFlightCommands", async () => {
    mockCounts(0, 2);

    await dispatchPresence(presenceWithActive(2));

    expect(mockEmitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "executor_saturation",
        value: 0.5,
        computeTargetId: TARGET_ID,
        origin: ORIGIN,
      })
    );
  });

  // ISS-8453, replayed from prod target 019cd7a2 on 2026-08-28: 104 commands sat
  // in the desktop's OWN queue behind the 2 it was executing, against a declared
  // ceiling of 2. Every one of those was `Accepted` — the desktop acks at enqueue
  // — so a numerator taken from command rows read 53.0 and paged as an execution
  // overrun the desktop never performed.
  it("reads saturation from the desktop's reported occupancy, so a client-side backlog cannot inflate it", async () => {
    // Written out rather than read back from the values under test: a fixture
    // that derives its expectation from them passes at any of them.
    const DECLARED_CEILING = 2;
    const EXECUTING_AT_CEILING = 2;
    const CLIENT_BACKLOG = 104;
    const SATURATION_AT_CEILING = 1;
    const PRE_FIX_SATURATION = 53;

    // beforeEach seeds a conflicting 4, so the persisted capability winning is
    // itself under test: at 4 this case reads 0.5, not 1.
    mockFindComputeTargetById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: DECLARED_CEILING },
    });
    // The command rows still show the whole backlog as non-terminal.
    mockCounts(0, CLIENT_BACKLOG + EXECUTING_AT_CEILING);

    await dispatchPresence(presenceWithActive(EXECUTING_AT_CEILING));

    const saturationEmits = mockEmitQueueMetric.mock.calls
      .map((call) => call[0])
      .filter((metric) => metric.metric === "executor_saturation");
    expect(saturationEmits).toHaveLength(1);
    expect(saturationEmits[0].value).toBe(SATURATION_AT_CEILING);
    expect(saturationEmits[0].value).not.toBe(PRE_FIX_SATURATION);

    // The backlog itself stays visible on the gauge that already carried it.
    expect(mockEmitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "in_flight_command_count",
        value: CLIENT_BACKLOG + EXECUTING_AT_CEILING,
        computeTargetId: TARGET_ID,
      })
    );
  });

  // A desktop build predating the presence field reports no occupancy. Emitting
  // a number for it would mean inferring one from command rows, which is the
  // defect above; the queue gauges still publish.
  it("skips saturation for a desktop that reports no activeCommands, and still emits the queue gauges", async () => {
    mockCounts(3, 5);

    await dispatchPresence();

    expect(emittedMetricNames()).toEqual(
      expect.arrayContaining([
        "queued_command_count",
        "in_flight_command_count",
      ])
    );
    expect(emittedMetricNames()).not.toContain("executor_saturation");
    // Version skew, not a data defect — it must not warn once per heartbeat for
    // the life of every older client in the fleet.
    expect(mockLogDebug).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "activeCommands_absent" })
    );
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "activeCommands_absent" })
    );
  });

  // The sibling of the case above, and the distinction it must NOT collapse
  // into. An older desktop omits the field; a desktop sending `"2"` is a
  // malformed payload. `readActiveCommands` narrowed both to `undefined`, so a
  // corrupt frame reported itself as version skew at debug level and the
  // invalid-payload warn never fired for the case it exists for. `null` sits on
  // the malformed side deliberately: the desktop types this `number | undefined`
  // and JSON omits an absent optional rather than nulling it, so a null is a
  // producer that broke the contract, not a client too old to honor it.
  it.each([
    { label: "a numeric string", activeCommands: "2" },
    { label: "null", activeCommands: null },
    { label: "an object", activeCommands: {} },
  ])(
    "warns for $label instead of reporting it as an older client's omission",
    async ({ activeCommands }) => {
      mockCounts(0, 2);

      await dispatchPresence({ activeCommands });

      expect(emittedMetricNames()).not.toContain("executor_saturation");
      expect(mockLogWarn).toHaveBeenCalledWith(
        "executor_saturation_skipped",
        expect.objectContaining({ reason: "activeCommands_invalid" })
      );
      expect(mockLogDebug).not.toHaveBeenCalledWith(
        "executor_saturation_skipped",
        expect.objectContaining({ reason: "activeCommands_absent" })
      );
      // The queue gauges are real measurements and still publish, so a corrupt
      // occupancy costs the saturation sample and nothing else.
      expect(emittedMetricNames()).toContain("queued_command_count");
    }
  );

  // The warn carries the offending value, but this is caller-controlled wire
  // input: passing it through raw would let one frame put an arbitrarily large
  // JSON structure into the log line.
  it("bounds the malformed value it logs rather than passing the payload through", async () => {
    const OVERSIZED = "x".repeat(500);

    await dispatchPresence({ activeCommands: OVERSIZED });

    const logged = mockLogWarn.mock.calls.find(
      ([message, fields]) =>
        message === "executor_saturation_skipped" &&
        fields?.reason === "activeCommands_invalid"
    );
    expect(logged?.[1].activeCommands).toBe("x".repeat(64));
  });

  // `readActiveCommands` admits anything `typeof === "number"`, so a negative or
  // fractional occupancy reaches this from the wire whatever the parameter type
  // says. Either would divide into a confident saturation that reads as real.
  it.each([
    { label: "negative", activeCommands: -1 },
    { label: "fractional", activeCommands: 1.5 },
    { label: "non-finite", activeCommands: Number.POSITIVE_INFINITY },
  ])(
    "skips saturation and warns for a $label activeCommands",
    async ({ activeCommands }) => {
      mockCounts(0, 2);

      await dispatchPresence(presenceWithActive(activeCommands));

      expect(emittedMetricNames()).not.toContain("executor_saturation");
      expect(mockLogWarn).toHaveBeenCalledWith(
        "executor_saturation_skipped",
        expect.objectContaining({ reason: "activeCommands_invalid" })
      );
      // The queue gauges are real measurements and still publish.
      expect(emittedMetricNames()).toContain("queued_command_count");
    }
  );

  // Zero is the most common production value and the one falsy hazard in this
  // path: it survives three separate checks (`typeof === "number"`,
  // `=== undefined`, `< 0`), and a single careless `|| undefined` or truthiness
  // spread at any of them turns every idle desktop into "reports no occupancy".
  // The fleet's 0.0 baseline would vanish with the suite still green.
  it("emits saturation of 0 for an idle desktop reporting activeCommands: 0", async () => {
    mockCounts(0, 0);

    await dispatchPresence(presenceWithActive(0));

    expect(mockEmitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "executor_saturation",
        value: 0,
        computeTargetId: TARGET_ID,
        origin: ORIGIN,
      })
    );
    expect(emittedMetricNames()).toContain("executor_saturation");
    expect(mockLogDebug).not.toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "activeCommands_absent" })
    );
  });

  it("emits the queue-depth gauges from the presence path", async () => {
    mockCounts(7, 2);

    await dispatchPresence();

    expect(mockEmitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "queued_command_count",
        value: 7,
        computeTargetId: TARGET_ID,
      })
    );
    expect(mockEmitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "in_flight_command_count",
        value: 2,
        computeTargetId: TARGET_ID,
      })
    );
  });

  it("samples the gauges on every heartbeat, not once per connection", async () => {
    mockCounts(0, 1);

    await dispatchPresence(presenceWithActive(1));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await dispatchPresence(presenceWithActive(1));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await dispatchPresence(presenceWithActive(1));

    const saturationEmits = emittedMetricNames().filter(
      (metric) => metric === "executor_saturation"
    );
    expect(saturationEmits).toHaveLength(3);
  });

  it("collapses the desktop's un-debounced presence bursts between heartbeats", async () => {
    mockCounts(0, 1);

    // The desktop emits presence per queue mutation, not on a schedule.
    await dispatchPresence(presenceWithActive(1));
    await vi.advanceTimersByTimeAsync(200);
    await dispatchPresence(presenceWithActive(1));
    await vi.advanceTimersByTimeAsync(200);
    await dispatchPresence(presenceWithActive(1));

    const saturationEmits = emittedMetricNames().filter(
      (metric) => metric === "executor_saturation"
    );
    expect(saturationEmits).toHaveLength(1);
    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(1);
  });

  it("still emits the queue gauges and skips saturation when the target never reported maxInFlightCommands", async () => {
    // The shape hello persists for a desktop that omitted the field.
    mockFindComputeTargetById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: null },
    });

    await dispatchPresence();

    expect(emittedMetricNames()).toEqual(
      expect.arrayContaining([
        "queued_command_count",
        "in_flight_command_count",
      ])
    );
    expect(emittedMetricNames()).not.toContain("executor_saturation");
    // Absence is version skew, not a data defect, and presence re-samples every
    // heartbeat — so it must not warn once per heartbeat for the target's life.
    expect(mockLogDebug).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_absent" })
    );
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.anything()
    );
  });

  it("skips saturation when the persisted capacity exceeds the safe integer range", async () => {
    // 1e100 is an integer to `Number.isInteger`, and dividing by it yields a
    // near-zero saturation that reads as a comfortably idle executor.
    mockFindComputeTargetById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: 1e100 },
    });
    mockCounts(0, 2);

    await dispatchPresence();

    expect(emittedMetricNames()).not.toContain("executor_saturation");
    expect(mockLogWarn).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_invalid" })
    );
  });

  it("skips saturation when the persisted capacity is not a whole slot count", async () => {
    mockFindComputeTargetById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: 0.5 },
    });
    mockCounts(0, 2);

    await dispatchPresence();

    expect(emittedMetricNames()).not.toContain("executor_saturation");
    expect(mockLogWarn).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_invalid" })
    );
  });

  it.each([
    { name: "negative", value: -1 },
    { name: "positive infinity", value: Number.POSITIVE_INFINITY },
    { name: "NaN", value: Number.NaN },
  ])(
    "keeps queue gauges but skips saturation for a $name persisted capacity",
    async ({ value }) => {
      mockFindComputeTargetById.mockResolvedValue({
        id: TARGET_ID,
        capabilities: { maxInFlightCommands: value },
      });
      mockCounts(7, 2);

      await dispatchPresence();

      expect(emittedMetricNames()).toEqual(
        expect.arrayContaining([
          "queued_command_count",
          "in_flight_command_count",
        ])
      );
      expect(emittedMetricNames()).not.toContain("executor_saturation");
      expect(mockLogWarn).toHaveBeenCalledWith(
        "executor_saturation_skipped",
        expect.objectContaining({
          reason: "maxInFlightCommands_invalid",
          maxInFlightCommands: value,
        })
      );
    }
  );

  it("still emits the queue gauges when the target row is gone", async () => {
    mockFindComputeTargetById.mockResolvedValue(null);

    await dispatchPresence();

    expect(emittedMetricNames()).toEqual(
      expect.arrayContaining([
        "queued_command_count",
        "in_flight_command_count",
      ])
    );
    expect(emittedMetricNames()).not.toContain("executor_saturation");
  });

  it("logs presence_failed and swallows a capability-lookup error", async () => {
    mockFindComputeTargetById.mockRejectedValue(new Error("db unavailable"));

    await dispatchPresence();

    expect(mockLogWarn).toHaveBeenCalledWith(
      "fleet.capacity_metrics.presence_failed",
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
  });

  it("answers the presence heartbeat without waiting for the emit to finish", async () => {
    let releaseLookup: (target: unknown) => void = () => {
      // replaced synchronously below
    };
    mockFindComputeTargetById.mockReturnValue(
      new Promise((resolve) => {
        releaseLookup = resolve;
      })
    );

    const dispatched = await dispatchSocketEvent({
      event: "desktop.presence",
      payload: presenceWithActive(2),
      auth: AUTH,
      targetId: TARGET_ID,
      correlation: {},
      requestArrivedAt: Date.now(),
    });

    // The heartbeat has answered while the emit is still blocked on its lookup.
    expect(dispatched.ok).toBe(true);
    expect(mockEmitQueueMetric).not.toHaveBeenCalled();

    releaseLookup({ id: TARGET_ID, capabilities: { maxInFlightCommands: 4 } });
    await Promise.all(pendingWork);

    expect(emittedMetricNames()).toContain("executor_saturation");
  });

  it("gives up on a lookup that never resolves instead of retrying it forever", async () => {
    vi.useFakeTimers();
    mockFindComputeTargetById.mockReturnValue(
      new Promise(() => {
        // never settles
      })
    );

    const dispatched = await dispatchSocketEvent({
      event: "desktop.presence",
      payload: {},
      auth: AUTH,
      targetId: TARGET_ID,
      correlation: {},
      requestArrivedAt: Date.now(),
    });
    expect(dispatched.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);

    expect(mockLogWarn).toHaveBeenCalledWith(
      "fleet.capacity_metrics.presence_failed",
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
    expect(emittedMetricNames()).not.toContain("executor_saturation");
  });

  it("holds a hung lookup shut for the latch window, then samples again", async () => {
    // The timeout only stops the wrapper waiting; the lookup itself keeps
    // running. Once its deadline passes, the interval gate alone would let the
    // next heartbeat through and leave a second lookup behind, once per
    // heartbeat — so the latch has to hold. But a lookup that never settles
    // never clears the latch either, and holding forever would take this
    // target's gauges dark for the life of the process: the blackout this
    // sampler exists to end, one target at a time.
    mockFindComputeTargetById.mockReturnValue(
      new Promise(() => {
        // never settles
      })
    );

    await dispatchPresenceFor(TARGET_ID);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);
    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(1);

    // Past the sampling interval, so the interval gate alone would reopen.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await dispatchPresenceFor(TARGET_ID);
    await Promise.all(pendingWork);
    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(1);

    // Past the latch's own deadline: the stalled read is unrecoverable, so the
    // silence it buys is capped rather than permanent. The probe span is fixed
    // and the deadline is pinned to fit inside it, rather than advancing by the
    // deadline itself — a TTL widened to effectively-never would otherwise
    // widen this advance with it and the case could not fail.
    expect(FLEET_CAPACITY_LATCH_TTL_MS).toBeLessThan(LATCH_RELEASE_PROBE_MS);
    await vi.advanceTimersByTimeAsync(LATCH_RELEASE_PROBE_MS);
    await dispatchPresenceFor(TARGET_ID);
    // The replacement read hangs too, so its wrapper has to time out before the
    // drain below can settle.
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);

    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(2);
  });

  // ISS-8453 review: the two halves of the lost-update race the expiring latch
  // opens. Both need a REAL overlap — a stalled sample still live while its
  // replacement runs — which is why each holds its own `findById` open rather
  // than sequencing two completed samples.
  // The sibling of the case below, entered at a DIFFERENT await. There are
  // three reads on this path — `findById`, then two `countCommandsForTarget`
  // under one `Promise.all` inside the emit — and any of them can stall past the
  // latch TTL. Guarding only the first left the two likelier ones open: a
  // generation checked before the emit is already gone by the time the counts
  // return. Same trigger the sampler's own comment cites, a read with no RST to
  // settle it.
  it("does not republish when the sample is superseded during the count reads, not the lookup", async () => {
    const STALE_OCCUPANCY = 1;
    const CURRENT_OCCUPANCY = 2;
    const CEILING = 4;
    const CURRENT_SATURATION = 0.5;

    // The lookup resolves promptly, so the stale sample passes the pre-emit
    // check and stalls INSIDE `emitFleetCapacityMetrics` instead.
    let releaseStaleCount: (value: number) => void = () => {
      // replaced synchronously below
    };
    mockCountCommandsForTarget
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseStaleCount = resolve;
        })
      )
      .mockResolvedValue(0);

    await dispatchPresenceFor(TARGET_ID, presenceWithActive(STALE_OCCUPANCY));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);
    expect(emittedMetricNames()).not.toContain("executor_saturation");

    await vi.advanceTimersByTimeAsync(FLEET_CAPACITY_LATCH_TTL_MS + 1);
    mockFindComputeTargetById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: CEILING },
    });
    mockCounts(0, CURRENT_OCCUPANCY);
    await dispatchPresence(presenceWithActive(CURRENT_OCCUPANCY));

    releaseStaleCount(0);
    await Promise.all(pendingWork);
    await flushPendingMicrotasks();

    const saturationValues = mockEmitQueueMetric.mock.calls
      .map((call) => call[0])
      .filter((metric) => metric.metric === "executor_saturation")
      .map((metric) => metric.value);
    expect(saturationValues).toEqual([CURRENT_SATURATION]);

    // The guard sits ABOVE the queue gauges, not just above saturation — a
    // superseded sample publishes nothing at all, rather than a partial set
    // interleaved with its replacement's. Move it below these two emits and
    // `in_flight_command_count` reads [2, 0]: the stale `0` landing after the
    // current `2`, the same lost update in the same saturation-hiding
    // direction. Nothing else in the repo pins this — hello passes no callback,
    // so its suite cannot constrain the ordering.
    const inFlightValues = mockEmitQueueMetric.mock.calls
      .map((call) => call[0])
      .filter((metric) => metric.metric === "in_flight_command_count")
      .map((metric) => metric.value);
    expect(inFlightValues).toEqual([CURRENT_OCCUPANCY]);

    expect(mockLogWarn).toHaveBeenCalledWith(
      "fleet.capacity_metrics.sample_superseded",
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
  });

  it("does not let a superseded sample republish the occupancy it captured a latch ago", async () => {
    // Written out rather than derived from the values under test.
    const STALE_OCCUPANCY = 1;
    const CURRENT_OCCUPANCY = 2;
    const CEILING = 4;
    const CURRENT_SATURATION = 0.5;

    let releaseStaleLookup: (target: unknown) => void = () => {
      // replaced synchronously below
    };
    mockFindComputeTargetById.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseStaleLookup = resolve;
      })
    );

    // The stale sample claims the latch and stalls inside its lookup, so its
    // wrapper has to time out before anything here can drain.
    await dispatchPresenceFor(TARGET_ID, presenceWithActive(STALE_OCCUPANCY));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);
    expect(emittedMetricNames()).not.toContain("executor_saturation");

    // Past the latch TTL, so a newer heartbeat gets in and publishes the
    // occupancy the desktop is actually at.
    await vi.advanceTimersByTimeAsync(FLEET_CAPACITY_LATCH_TTL_MS + 1);
    mockCounts(0, CURRENT_OCCUPANCY);
    await dispatchPresence(presenceWithActive(CURRENT_OCCUPANCY));

    // Only now does the stalled lookup come back, carrying the older number.
    releaseStaleLookup({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: CEILING },
    });
    await Promise.all(pendingWork);
    await flushPendingMicrotasks();

    const saturationValues = mockEmitQueueMetric.mock.calls
      .map((call) => call[0])
      .filter((metric) => metric.metric === "executor_saturation")
      .map((metric) => metric.value);
    // One emit, and it is the current one. Without the generation check this
    // reads [0.5, 0.25] — the stale sample landing LAST and taking the gauge
    // down, which is the direction that hides saturation.
    expect(saturationValues).toEqual([CURRENT_SATURATION]);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "fleet.capacity_metrics.sample_superseded",
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
  });

  it("leaves the replacement sample's latch intact when the superseded one settles", async () => {
    const hang = () =>
      new Promise(() => {
        // never settles
      });
    let releaseStaleLookup: (target: unknown) => void = () => {
      // replaced synchronously below
    };
    mockFindComputeTargetById
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseStaleLookup = resolve;
        })
      )
      .mockReturnValueOnce(hang());

    await dispatchPresenceFor(TARGET_ID, presenceWithActive(1));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);

    // The replacement claims the latch and is still in flight.
    await vi.advanceTimersByTimeAsync(FLEET_CAPACITY_LATCH_TTL_MS + 1);
    await dispatchPresenceFor(TARGET_ID, presenceWithActive(2));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pendingWork);
    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(2);

    // The superseded sample settles. Its cleanup must release only its OWN
    // claim: an unconditional delete frees the latch the replacement is still
    // holding, re-opening the one-extra-read-per-heartbeat leak.
    releaseStaleLookup({ id: TARGET_ID, capabilities: {} });
    await flushPendingMicrotasks();

    // Past the interval gate but well inside the replacement's latch window.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await dispatchPresenceFor(TARGET_ID, presenceWithActive(2));
    await Promise.all(pendingWork);

    expect(mockFindComputeTargetById).toHaveBeenCalledTimes(2);
  });

  it("clears the latch when the lookup rejects, so the next heartbeat samples", async () => {
    // The latch is cleared in `.finally`, not `.then`: a transient
    // `findById` rejection must not leave the target latched until the TTL
    // expires, which would be a lookup-shaped outage turned into a gauge gap.
    mockFindComputeTargetById.mockRejectedValueOnce(
      new Error("db unavailable")
    );

    await dispatchPresence(presenceWithActive(1));
    expect(mockLogWarn).toHaveBeenCalledWith(
      "fleet.capacity_metrics.presence_failed",
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
    expect(emittedMetricNames()).not.toContain("executor_saturation");

    // Past the interval gate but well inside the latch TTL, so only a cleared
    // latch lets this through.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await dispatchPresence(presenceWithActive(1));

    expect(emittedMetricNames()).toContain("executor_saturation");
  });

  it("distinguishes a deleted target from an old desktop in the skip reason", async () => {
    // Both reach the same branch with no capability to read, and both emit the
    // count gauges as real measurements — the reason is the only thing that says
    // whether the row still exists.
    mockFindComputeTargetById.mockResolvedValue(null);

    await dispatchPresence();

    expect(mockLogDebug).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "target_not_found" })
    );
    expect(mockLogDebug).not.toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_absent" })
    );
  });

  it("stops tracking new targets at the cap instead of growing without bound", async () => {
    // Every target is sampled inside one window, so the age-based sweep frees
    // nothing. Without a cap check after that sweep the map keeps growing, one
    // entry per reconnecting target.
    for (let index = 0; index < FLEET_CAPACITY_TRACKED_TARGET_CAP; index++) {
      await dispatchPresenceFor(`${TARGET_ID}-fill-${index}`);
    }
    await Promise.all(pendingWork);
    mockEmitQueueMetric.mockClear();

    await dispatchPresenceFor(`${TARGET_ID}-over-cap`);
    await Promise.all(pendingWork);

    expect(mockEmitQueueMetric).not.toHaveBeenCalled();
    // Filling the map means CAP real dispatches through the production
    // dispatcher — ~2s on a warm laptop, and a loaded CI runner blows the 5s
    // default. The budget is for the fill, not for a hang: the cap assertion
    // above is unchanged and still reds when the post-sweep cap check is cut.
  }, 30_000);
});
